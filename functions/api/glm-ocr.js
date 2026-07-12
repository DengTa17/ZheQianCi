import { forwardJson, guardRequest, jsonError, readJson } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') return jsonError('Method not allowed', 405);
  const blocked = guardRequest(context, 6);
  if (blocked) return blocked;

  try {
    const body = await readJson(context.request, 15_000_000);
    const file = String(body?.file || '');
    if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(file)) {
      return jsonError('仅支持 JPEG、PNG 或 WebP 图片');
    }
    if (file.length > 14_500_000) return jsonError('图片过大，请压缩后重试', 413);

    return forwardJson(
      'https://open.bigmodel.cn/api/paas/v4/layout_parsing',
      context.env.ZHIPU_API_KEY,
      { model: 'glm-ocr', file },
      65_000
    );
  } catch (error) {
    return jsonError(error.message || 'OCR 请求无效');
  }
}
