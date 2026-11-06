import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../relay/worker.js";

const ORIGIN = "https://whitelips.github.io";
const ENDPOINT = "https://2x3-image-relay.whitelips19.workers.dev/";
const SOURCE = "https://image.cdn.mnetplus.world/test/original.jpg";

function request(url = SOURCE, extraHeaders = {}, endpoint = ENDPOINT) {
  return new Request(endpoint, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ url }),
  });
}

test("relay streams original WebP bytes and strips private and caching headers", async (t) => {
  const bytes = await readFile(new URL("./fixtures/pattern.webp", import.meta.url));
  const upstream = new Response(bytes, {
    headers: {
      "Content-Type": "image/webp",
      "Set-Cookie": "secret=value",
      "Cache-Control": "public, max-age=86400",
      ETag: "private-tag",
    },
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, SOURCE);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.deepEqual(options.headers, { Accept: "image/webp,image/png,image/jpeg" });
    return upstream;
  });
  const response = await worker.fetch(request(SOURCE, {
    Cookie: "private=session",
    Authorization: "Bearer private",
    Referer: "https://private.example/",
  }));
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(response.status, 200);
  assert.equal(response.body, upstream.body, "body must be streamed, not buffered");
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("ETag"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("preflight permits only the converter origin and JSON POST", async () => {
  const response = await worker.fetch(new Request(ENDPOINT, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);

  for (const headers of [
    { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    { Origin: ORIGIN, "Access-Control-Request-Method": "GET" },
    { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
  ]) {
    assert.equal((await worker.fetch(new Request(ENDPOINT, { method: "OPTIONS", headers }))).status, 403);
  }
});

test("disallowed origins and source URLs never make an upstream request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("invalid request reached upstream");
  });
  for (const origin of ["", "null", "https://evil.example", "https://whitelips.github.io.evil.example"]) {
    const response = await worker.fetch(request(SOURCE, { Origin: origin }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  for (const url of [
    "http://image.cdn.mnetplus.world/a.webp",
    "https://image.cdn.mnetplus.world.evil.example/a.webp",
    "https://image.cdn.mnetplus.world./a.webp",
    "https://image.cdn.mnetplus.world:444/a.webp",
    "https://user:password@image.cdn.mnetplus.world/a.webp",
    "https://image.cdn.mnetplus.world/a.webp#secret",
    "https://image.cdn.mnetplus.world/a.webp#",
    "https://127.0.0.1/private",
    "file:///private/image.png",
    "data:image/png;base64,AA==",
    "/relative.webp",
    "https://image.cdn.mnetplus.world/" + "x".repeat(8192),
    null,
  ]) {
    const response = await worker.fetch(request(url));
    assert.equal(response.status, 400, String(url).slice(0, 100));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("redirects are validated before fetching the destination", async (t) => {
  const destinations = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    destinations.push(url);
    assert.equal(options.redirect, "manual");
    if (destinations.length === 1)
      return new Response(null, { status: 302, headers: { Location: "/safe.webp" } });
    return new Response("image", { headers: { "Content-Type": "image/webp" } });
  });
  const response = await worker.fetch(request());
  assert.equal(response.status, 200);
  assert.deepEqual(destinations, [SOURCE, "https://image.cdn.mnetplus.world/safe.webp"]);
});

test("cross-host, insecure, credentialed redirects and redirect loops are rejected", async (t) => {
  for (const location of [
    "https://evil.example/image.webp",
    "http://image.cdn.mnetplus.world/image.webp",
    "https://user:secret@image.cdn.mnetplus.world/image.webp",
  ]) {
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      new Response(null, { status: 302, headers: { Location: location } }));
    const response = await worker.fetch(request());
    assert.equal(response.status, 403);
    assert.equal(fetchMock.mock.callCount(), 1);
    fetchMock.mock.restore();
  }
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 307, headers: { Location: "/loop.webp" } }));
  assert.equal((await worker.fetch(request())).status, 502);
  assert.equal(fetchMock.mock.callCount(), 4);
});

test("invalid metadata and methods return fixed messages without exposing input", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("invalid metadata was fetched"));
  for (const body of ["broken-json", "null", "[]", JSON.stringify({ url: SOURCE, extra: "x".repeat(16384) })]) {
    const response = await worker.fetch(new Request(ENDPOINT, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "허용된 HTTPS 이미지 주소인지 확인해 주세요." });
  }
  assert.equal((await worker.fetch(request(SOURCE, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await worker.fetch(new Request(ENDPOINT, { method: "DELETE", headers: { Origin: ORIGIN } }))).status, 405);
  assert.equal((await worker.fetch(request(SOURCE, {}, ENDPOINT + "?url=private"))).status, 404);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("upstream errors and non-image responses are not exposed to the browser", async (t) => {
  const cases = [
    [() => { throw new Error("private upstream URL or token"); }, 502],
    [() => new Response("private error", { status: 403 }), 502],
    [() => new Response("private html", { headers: { "Content-Type": "text/html" } }), 415],
    [() => new Response("partial", { status: 206, headers: { "Content-Type": "image/webp" } }), 502],
  ];
  for (const [upstream, status] of cases) {
    const fetchMock = t.mock.method(globalThis, "fetch", upstream);
    const response = await worker.fetch(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    const body = await response.text();
    assert.ok(!body.includes("private"));
    fetchMock.mock.restore();
  }
});

test("health endpoint returns no image data and never makes an upstream request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("health fetched upstream"));
  const response = await worker.fetch(new Request(ENDPOINT));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { service: "2x3-image-relay", version: 1, status: "ok" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("unresponsive upstream is aborted after 30 seconds without exposing its URL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", (_url, options) => {
    started();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("private URL")), { once: true });
    });
  });
  const pending = worker.fetch(request());
  await fetching;
  t.mock.timers.tick(30_000);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "이미지 서버가 30초 안에 응답하지 않았습니다. 다시 시도해 주세요.",
  });
});

test("slow image transfer remains open after the response-header timeout is cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stream;
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
      headers: { "Content-Type": "image/png" },
    });
  });
  const response = await worker.fetch(request());
  t.mock.timers.tick(120_000);
  assert.equal(signal.aborted, false);
  stream.enqueue(new Uint8Array([1, 2, 3, 4]));
  stream.close();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});
