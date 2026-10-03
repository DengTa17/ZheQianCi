const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.resolve(__dirname, '..', 'index.html');
const html = fs.readFileSync(appPath, 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

function createHarness() {
  const storage = new Map();
  const elements = new Map();
  const listeners = new Map();
  const frames = new Map();
  const timers = new Map();
  const notices = [];
  const confirmations = [];
  const documentListeners = new Map();
  let sequence = 0;
  let now = 0;
  let previewItems = [];
  let confirmResult = false;
  const document = {
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll(selector) { return selector === '.preview-item' ? previewItems : []; },
    createElement() {
      return {
        set textContent(value) { this.text = String(value ?? ''); },
        get innerHTML() {
          return (this.text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        }
      };
    },
    body: { contains() { return true; } },
    documentElement: { dataset: {}, style: { setProperty() {} } }
  };
  const context = {
    document,
    console: { log() {}, warn() {}, error() {} },
    navigator: { storage: { persist: async () => true } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    performance: { now: () => now },
    addEventListener(name, callback) { listeners.set(name, callback); },
    dispatchEvent() {},
    fetch: async () => { throw new Error('Network calls are disabled in regression tests'); },
    Intl,
    AbortController,
    URL,
    Blob,
    location: { href: 'https://regression.invalid/', reload() {} },
    auditNotices: notices,
    auditConfirmations: confirmations,
    auditConfirm: () => confirmResult
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(scripts[1] + `
    globalThis.audit = { WordDatabase, LocalBackupService, ReviewMode, StudyMode, ImportMode,
      App, db, settings, phoneticsService, parseFlexibleImportText, parseOCRImportText };
    showToast = (message, type) => auditNotices.push({ message, type });
    showConfirm = async message => { auditConfirmations.push(message); return auditConfirm(); };
  `, context, { filename: appPath });
  return {
    app: context.audit, context, document, storage, elements, listeners, frames, timers,
    notices, confirmations,
    setConfirm(value) { confirmResult = value; },
    setPreview(items) { previewItems = items; },
    advanceFrame(milliseconds) {
      now += milliseconds;
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); }
    },
    async runTimers() {
      for (const [id, callback] of [...timers]) { timers.delete(id); await callback(); }
    }
  };
}

function createFolder(initialData) {
  let content = initialData === undefined ? null : JSON.stringify(initialData);
  let writes = 0;
  const file = {
    getFile: async () => ({ text: async () => content }),
    createWritable: async () => ({
      write: async value => { content = value; writes += 1; },
      close: async () => {}
    })
  };
  return {
    handle: {
      name: 'test-backup',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      async getFileHandle(name, options = {}) {
        assert.equal(name, '折千词数据.json');
        if (content === null && !options.create) {
          const error = new Error('No backup file');
          error.name = 'NotFoundError';
          throw error;
        }
        return file;
      }
    },
    get content() { return content; },
    get writes() { return writes; }
  };
}

async function setupFolder(harness, initialData) {
  const folder = createFolder(initialData);
  const service = new harness.app.LocalBackupService();
  let savedHandle = null;
  service.handleStore = {
    set: async handle => { savedHandle = handle; },
    get: async () => savedHandle,
    clear: async () => { savedHandle = null; }
  };
  harness.context.indexedDB = {};
  harness.context.showDirectoryPicker = async () => folder.handle;
  harness.context.backupService = service;
  await harness.app.db.init();
  await harness.app.db.batchImport([{ word: 'current', meaning: '当前数据' }], 1);
  await service.chooseFolder();
  return { folder, service };
}

const oldBackup = { books: [{ id: 10, name: '旧备份' }], words: [{ id: 10, bookId: 10, word: 'important', meaning: '重要数据' }], records: [] };

test('all inline scripts parse successfully', () => {
  assert.equal(scripts.length, 3);
  scripts.forEach(script => new vm.Script(script));
});

test('connecting an existing backup preserves its contents across writes and reconnection', async () => {
  const h = createHarness();
  const { folder, service } = await setupFolder(h, oldBackup);
  assert.equal(folder.content, JSON.stringify(oldBackup));
  assert.equal(folder.writes, 0);
  assert.equal(service.isAutoEnabled(), false);
  await h.app.db.addWord({ word: 'later', meaning: '后续数据', bookId: 1 });
  await h.runTimers();
  assert.equal(folder.writes, 0);
  const reloaded = new h.app.LocalBackupService();
  reloaded.handleStore = service.handleStore;
  await reloaded.init();
  assert.equal(await reloaded.backupNow(), false);
  assert.equal(h.confirmations.length, 1);
  assert.equal(folder.writes, 0);
});

test('existing backups can be restored before automatic backup resumes', async () => {
  const h = createHarness();
  const { folder, service } = await setupFolder(h, oldBackup);
  h.setConfirm(true);
  await service.restore();
  assert.equal(h.app.db.data.words[0].word, 'important');
  assert.equal(service.isAutoEnabled(), true);
  assert.equal(folder.writes, 0);
  await h.app.db.updateWord(h.app.db.data.words[0].id, { meaning: '恢复后的编辑' });
  await h.runTimers();
  assert.equal(folder.writes, 1);
  assert.equal(JSON.parse(folder.content).words[0].meaning, '恢复后的编辑');
});

test('overwriting an existing backup requires confirmation', async () => {
  const h = createHarness();
  const { folder, service } = await setupFolder(h, oldBackup);
  assert.equal(await service.backupNow(), false);
  assert.equal(folder.writes, 0);
  h.setConfirm(true);
  assert.equal(await service.backupNow(), true);
  assert.equal(folder.writes, 1);
  assert.equal(JSON.parse(folder.content).words[0].word, 'current');
});

test('new backup folders still receive an initial backup', async () => {
  const h = createHarness();
  const { folder, service } = await setupFolder(h);
  assert.equal(service.isAutoEnabled(), true);
  assert.equal(folder.writes, 1);
  assert.equal(JSON.parse(folder.content).words[0].word, 'current');
  assert.equal(h.confirmations.length, 0);
});

test('deleting the last book keeps every word accessible in the replacement book', async () => {
  const h = createHarness();
  await h.app.db.init();
  const book = h.app.db.data.books[0];
  await h.app.db.batchImport([{ word: 'apple', meaning: '苹果' }], book.id);
  await h.app.db.deleteBook(book.id);
  const remaining = await h.app.db.getAllBooks();
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].id, book.id);
  const words = await h.app.db.getWordsByBook(remaining[0].id);
  assert.equal(words.length, 1);
  assert.equal(words[0].word, 'apple');
});

test('deleting a book moves its words to an existing book', async () => {
  const h = createHarness();
  await h.app.db.init();
  const original = h.app.db.data.books[0].id;
  const destination = await h.app.db.addBook({ name: '保留' });
  await h.app.db.batchImport([{ word: 'apple', meaning: '苹果' }], original);
  await h.app.db.deleteBook(original);
  assert.equal((await h.app.db.getAllBooks()).length, 1);
  assert.equal((await h.app.db.getWordsByBook(destination)).length, 1);
});

test('learning records, mastery statistics and dashboard agree after actual scoring', async () => {
  const h = createHarness();
  await h.app.db.init();
  await h.app.db.batchImport([{ word: 'apple', meaning: '苹果' }], 1);
  const word = h.app.db.data.words[0];
  const study = new h.app.StudyMode();
  study.advance = () => {};
  study.graduateThenNext = () => {};
  for (let attempt = 0; attempt < 2; attempt++) {
    study.queue = [word];
    study.current = { word, locked: false, scored: false, startTime: Date.now() - 100 };
    await study.markKnown();
    await study.markKnown(); // A second click on the same appearance must not count twice.
  }
  assert.equal(word.currentScore, 4);
  assert.equal(word.reviewCount, 2);
  assert.equal(word.correctCount, 2);
  assert.ok(word.lastReviewed);
  assert.equal(h.app.db.data.records.length, 2);
  assert.equal((await h.app.db.getStats()).mastered, 1);
  assert.equal((await h.app.db.getBookStats(1)).mastered, 1);
  assert.equal((await h.app.db.getUnlearnedWords()).length, 0);
  ['goal-sub', 'review-title-text', 'review-sub-text'].forEach(id => h.elements.set(id, {}));
  const dashboardValues = {};
  const app = new h.app.App();
  app._setText = (id, value) => { dashboardValues[id] = value; };
  app._renderHeatmap = () => {};
  app._renderRecent = () => {};
  await app.renderDashboard();
  assert.equal(dashboardValues['stat-mastered'], 1);
  assert.equal(dashboardValues['stat-today-learn'], 2);
  assert.equal(dashboardValues['stat-today-review'], 1);
  const restored = new h.app.WordDatabase();
  await restored.importData(await h.app.db.exportData());
  assert.equal(restored.data.records[0].isReview, false);
  assert.equal(restored.data.records[1].isReview, true);
});

test('old mastered words are counted without inventing missing history', async () => {
  const h = createHarness();
  await h.app.db.init();
  await h.app.db.batchImport([{ word: 'apple', mastered: true, currentScore: 4 }], 1);
  assert.equal((await h.app.db.getStats()).mastered, 1);
  assert.equal(h.app.db.data.records.length, 0);
});

test('clearing all data also clears learning history', async () => {
  const h = createHarness();
  await h.app.db.init();
  await h.app.db.batchImport([{ word: 'apple', meaning: '苹果' }], 1);
  await h.app.db.recordStudy(h.app.db.data.words[0].id, true);
  h.setConfirm(true);
  const mode = new h.app.ImportMode();
  mode.clearPreview = () => {};
  await mode.clearAllData();
  assert.equal(h.app.db.data.words.length, 0);
  assert.equal(h.app.db.data.records.length, 0);
  assert.equal(h.app.db.data.books.length, 1);
});

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle(name, forced) {
      const enabled = forced === undefined ? !values.has(name) : forced;
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    }
  };
}

function style() {
  return { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
}

function createFoldReview(h) {
  const handlers = {};
  const rows = [];
  const review = new h.app.ReviewMode();
  review.maskMode = 'english';
  review.listEl = {
    classList: classList(),
    addEventListener(name, callback) { handlers[name] = callback; },
    querySelectorAll(selector) {
      return selector === '.revealed-en, .revealed-cn'
        ? rows.filter(({ row }) => row.classList.contains('revealed-en') || row.classList.contains('revealed-cn')).map(({ row }) => row)
        : [];
    }
  };
  review.initFoldDrag();
  function newRow() {
    const strips = Array.from({ length: 18 }, () => ({ style: style() }));
    const cover = {
      classList: classList(), style: style(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
      querySelector: () => null,
      querySelectorAll: () => strips,
      setPointerCapture() {}, releasePointerCapture() {}
    };
    const row = {
      classList: classList(),
      querySelector: selector => selector === '.fold-en' || selector === '.fold-cn' ? cover : { style: style() }
    };
    const result = { row, cover, strips, target: { closest: selector => selector === '.row-actions' ? null : row } };
    rows.push(result);
    return result;
  }
  return {
    review, newRow,
    down: entry => handlers.pointerdown({ target: entry.target, clientX: 100, clientY: 20, pointerId: 1, preventDefault() {} }),
    move: x => h.listeners.get('pointermove')({ clientX: x, clientY: 20 }),
    up: () => h.listeners.get('pointerup')(),
    cancel: () => h.listeners.get('pointercancel')()
  };
}

function assertSettled(entry) {
  assert.equal(entry.cover.classList.contains('dragging'), false);
  assert.equal(entry.strips.some(strip => Boolean(strip.style.transform || strip.style.opacity)), false);
}

test('starting a second fold settles the first opening or closing animation', () => {
  const h = createHarness();
  const f = createFoldReview(h);
  const first = f.newRow();
  const second = f.newRow();
  f.down(first); f.move(55); f.up(); h.advanceFrame(40);
  f.down(second);
  assertSettled(first);
  assert.equal(first.row.classList.contains('revealed-en'), true);
  f.move(10); f.up(); h.advanceFrame(500);
  assertSettled(second);
  f.down(first); f.up(); h.advanceFrame(40); f.down(second);
  assertSettled(first);
  assert.equal(first.row.classList.contains('revealed-en'), false);
});

test('mask changes and pointer cancellation leave no partial fold', () => {
  const h = createHarness();
  const f = createFoldReview(h);
  const entry = f.newRow();
  f.down(entry); f.move(55); f.up(); h.advanceFrame(40);
  f.review.setMaskMode('chinese');
  assertSettled(entry);
  assert.equal(entry.row.classList.contains('revealed-en'), false);
  assert.equal(h.frames.size, 0);
  f.review.setMaskMode('english');
  f.down(entry); f.move(55); f.cancel();
  assertSettled(entry);
  assert.equal(h.frames.size, 0);
});

async function setupImport(h, currentTab, entries) {
  await h.app.db.init();
  const mode = new h.app.ImportMode();
  mode.currentTab = currentTab;
  mode.parsedWords = entries;
  mode.clearPreview = () => {};
  let dictionaryCalls = 0;
  h.app.phoneticsService.batchFetchPhonetics = async () => { dictionaryCalls++; return new Map(); };
  h.elements.set('preview-book-select', { value: '1' });
  h.setPreview(entries.map(entry => ({
    dataset: { uid: entry.uid },
    querySelector(selector) {
      return { value: selector === '.preview-word' ? entry.word : selector === '.preview-meaning' ? entry.meaning : '' };
    }
  })));
  return { mode, dictionaryCalls: () => dictionaryCalls };
}

test('manual import keeps the preview intact until every meaning is supplied', async () => {
  const h = createHarness();
  const entries = [{ uid: 'a', word: 'apple', meaning: '' }, { uid: 'b', word: 'banana', meaning: '香蕉' }];
  const { mode, dictionaryCalls } = await setupImport(h, 'manual', entries);
  await mode.confirmImport();
  assert.equal(h.app.db.data.words.length, 0);
  assert.equal(dictionaryCalls(), 0);
  assert.ok(h.notices.some(notice => /缺少中文释义/.test(notice.message)));
  assert.equal(mode.parsedWords.length, 2);
  entries[0].meaning = '苹果';
  await mode.confirmImport();
  assert.equal(h.app.db.data.words.length, 2);
});

test('OCR entries may still be imported without a meaning', async () => {
  const h = createHarness();
  const { mode } = await setupImport(h, 'ocr', [{ uid: 'a', word: 'apple', meaning: '' }]);
  await mode.confirmImport();
  assert.equal(h.app.db.data.words.length, 1);
  assert.equal(h.app.db.data.words[0].word, 'apple');
});
