// Paste this entire file into a Cloudflare Module Worker and deploy.
// Also disable Workers Logs / Traces and Worker Cache in the dashboard.
// This code does not use storage, Cache API, analytics, or console logging.
// Origin checks restrict browser use; they are not user authentication.

const ALLOWED_ORIGIN = "https://whitelips.github.io";
const ALLOWED_HOST = "image.cdn.mnetplus.world";
const MAX_METADATA_BYTES = 16_384;
const MAX_URL_LENGTH = 8_192;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set(["image/webp", "image/png", "image/jpeg", "image/jpg"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headersFor(request) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Image-Relay": "1",
  });
  if (request.headers.get("Origin") === ALLOWED_ORIGIN)
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  return headers;
}

function json(request, body, status) {
  const headers = headersFor(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(request, status, message) {
  return json(request, { error: message }, status);
}

function sourceUrl(value, base) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH)
    throw new Error("Invalid source");
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    url.hostname !== ALLOWED_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.href.includes("#")
  ) throw new Error("Invalid source");
  return url;
}

// Only the small JSON envelope is buffered. This is not an image-size limit.
async function readMetadata(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_METADATA_BYTES)
    throw new Error("Invalid metadata");
  if (!request.body) throw new Error("Invalid metadata");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) {
        await reader.cancel();
        throw new Error("Invalid metadata");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid metadata");
  return sourceUrl(body.url);
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Do not log a URL, headers, or an upstream exception.
  }
}

async function relay(request, initialUrl) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response;
    try {
      // Construct a fresh request: never forward client cookies, authorization,
      // Referer, or other request headers to the image host.
      response = await fetch(url.href, {
        method: "GET",
        headers: { Accept: "image/webp,image/png,image/jpeg" },
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      return controller.signal.aborted
        ? failure(request, 504, "이미지 서버가 30초 안에 응답하지 않았습니다. 다시 시도해 주세요.")
        : failure(request, 502, "원본 이미지 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      // Large image transfers are not subject to this response-header timeout.
      clearTimeout(timeout);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("Location");
      await discard(response);
      if (!location || redirects === MAX_REDIRECTS)
        return failure(request, 502, "원본 이미지 주소의 이동을 완료하지 못했습니다.");
      try {
        url = sourceUrl(location, url);
      } catch {
        return failure(request, 403, "허용되지 않은 이미지 서버로 이동하는 주소입니다.");
      }
      continue;
    }

    if (!response.ok || response.status !== 200 || !response.body) {
      await discard(response);
      return failure(request, 502, "원본 이미지 서버가 파일을 반환하지 않았습니다. 주소를 확인해 주세요.");
    }
    const type = (response.headers.get("Content-Type") || "")
      .split(";", 1)[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) {
      await discard(response);
      return failure(request, 415, "원본 주소가 WebP, PNG 또는 JPEG 이미지 파일을 반환하지 않았습니다.");
    }

    const headers = headersFor(request);
    headers.set("Content-Type", type === "image/jpg" ? "image/jpeg" : type);
    // Preserve transport encoding for Cloudflare's streaming passthrough.
    // Do not forward Set-Cookie, Location, ETag, or upstream caching headers.
    const encoding = response.headers.get("Content-Encoding");
    if (encoding) headers.set("Content-Encoding", encoding);
    return new Response(response.body, { status: 200, headers });
  }
}

export default {
  async fetch(request) {
    try {
      const endpoint = new URL(request.url);
      if (endpoint.pathname !== "/" || endpoint.search)
        return failure(request, 404, "지원하지 않는 중계 주소입니다.");
      if (request.method === "GET")
        return json(request, { service: "2x3-image-relay", version: 1, status: "ok" }, 200);
      if (request.headers.get("Origin") !== ALLOWED_ORIGIN)
        return failure(request, 403, "허용된 변환기에서만 요청할 수 있습니다.");

      if (request.method === "OPTIONS") {
        const method = request.headers.get("Access-Control-Request-Method");
        const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
          .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
        if (method !== "POST" || requestedHeaders.some((name) => name !== "content-type"))
          return failure(request, 403, "허용되지 않은 중계 요청입니다.");
        const headers = headersFor(request);
        headers.set("Access-Control-Allow-Methods", "POST");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        headers.set("Access-Control-Max-Age", "600");
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "POST") {
        const response = failure(request, 405, "지원하지 않는 요청 방식입니다.");
        response.headers.set("Allow", "GET, POST, OPTIONS");
        return response;
      }
      const contentType = (request.headers.get("Content-Type") || "")
        .split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json")
        return failure(request, 415, "JSON 형식으로 이미지 주소를 보내 주세요.");
      let url;
      try {
        url = await readMetadata(request);
      } catch {
        return failure(request, 400, "허용된 HTTPS 이미지 주소인지 확인해 주세요.");
      }
      return await relay(request, url);
    } catch {
      // Keep raw exceptions out of both application responses and logs.
      return failure(request, 502, "이미지 중계를 완료하지 못했습니다. 다시 시도해 주세요.");
    }
  },
};
