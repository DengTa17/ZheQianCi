import { forwardJson, guardRequest, jsonError, readJson, sanitizeChatPayload } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') return jsonError('Method not allowed', 405);
  const blocked = guardRequest(context, 12);
  if (blocked) return blocked;

  try {
    const body = await readJson(context.request, 1_000_000);
    const payload = sanitizeChatPayload(body, 'deepseek-v4-flash');
    return forwardJson(
      'https://api.deepseek.com/v1/chat/completions',
      context.env.DEEPSEEK_API_KEY,
      payload,
      55_000
    );
  } catch (error) {
    return jsonError(error.message || 'DeepSeek 请求无效');
  }
}
