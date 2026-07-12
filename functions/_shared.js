const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

const burstBuckets = new Map();

export function jsonError(message, status = 400) {
  return Response.json({ error: { message } }, { status, headers: JSON_HEADERS });
}

export function requireSameOrigin(request) {
  const origin = request.headers.get('Origin');
  const expected = new URL(request.url).origin;
  return origin === expected ? null : jsonError('Forbidden origin', 403);
}

export function enforceBurstLimit(request, limit, windowMs = 60_000) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const route = new URL(request.url).pathname;
  const key = `${route}:${ip}`;
  const bucket = burstBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    burstBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return jsonError('请求过于频繁，请稍后再试', 429);
  }
  return null;
}

export async function readJson(request, maxBytes) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > maxBytes) throw new Error('请求内容过大');

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new Error('请求内容过大');
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求格式无效');
  }
}

export function sanitizeChatPayload(body, model) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0 || body.messages.length > 20) {
    throw new Error('消息数量无效');
  }

  return {
    model,
    messages: body.messages,
    temperature: Math.max(0, Math.min(1, Number(body.temperature ?? 0.3))),
    max_tokens: Math.max(32, Math.min(12_000, Number(body.max_tokens ?? 1_800))),
    stream: false,
    ...(body.response_format?.type === 'json_object'
      ? { response_format: { type: 'json_object' } }
      : {})
  };
}

export async function forwardJson(url, apiKey, payload, timeoutMs) {
  if (!apiKey) return jsonError('站点 AI 服务尚未配置', 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: JSON_HEADERS });
  } catch (error) {
    return jsonError(error?.name === 'AbortError' ? '上游 AI 响应超时' : '上游 AI 暂时不可用', 504);
  } finally {
    clearTimeout(timer);
  }
}

export function guardRequest(context, burstLimit) {
  if (String(context.env.AI_ENABLED || 'true').toLowerCase() === 'false') {
    return jsonError('站点 AI 服务已暂停', 503);
  }
  return requireSameOrigin(context.request) || enforceBurstLimit(context.request, burstLimit);
}
