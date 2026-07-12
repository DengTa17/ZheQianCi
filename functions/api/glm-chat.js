import { forwardJson, guardRequest, jsonError, readJson, sanitizeChatPayload } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') return jsonError('Method not allowed', 405);
  const blocked = guardRequest(context, 12);
  if (blocked) return blocked;

  try {
    const body = await readJson(context.request, 2_000_000);
    const payload = sanitizeChatPayload(body, 'glm-4.7');
    return forwardJson(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      context.env.ZHIPU_API_KEY,
      payload,
      55_000
    );
  } catch (error) {
    return jsonError(error.message || '智谱请求无效');
  }
}
