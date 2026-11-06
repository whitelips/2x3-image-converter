import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import {
  buildDownloadCommand,
  recoveryFilename,
  recoveryItemId,
} from "../src/download-command.js";
import {
  fitToTwoThree,
  parseUrls,
  outputName,
  inspectImage,
} from "../src/core.js";

test("canvas contains the full original at an exact 2:3 ratio, including odd dimensions", () => {
  assert.deepEqual(fitToTwoThree(600, 450), {
    width: 600,
    height: 900,
    x: 0,
    y: 225,
  });
  assert.deepEqual(fitToTwoThree(600, 800), {
    width: 600,
    height: 900,
    x: 0,
    y: 50,
  });
  assert.deepEqual(fitToTwoThree(200, 900), {
    width: 600,
    height: 900,
    x: 200,
    y: 0,
  });
  assert.deepEqual(fitToTwoThree(600, 900), {
    width: 600,
    height: 900,
    x: 0,
    y: 0,
  });
  for (const [w, h] of [
    [1, 1],
    [601, 451],
    [43, 781],
    [1599, 899],
  ]) {
    const target = fitToTwoThree(w, h);
    assert.equal(target.width * 3, target.height * 2);
    assert.ok(target.width >= w && target.height >= h);
    assert.ok(Math.abs(target.width - w - target.x * 2) <= 1);
    assert.ok(Math.abs(target.height - h - target.y * 2) <= 1);
  }
  assert.throws(() => fitToTwoThree(0, 100));
  assert.deepEqual(fitToTwoThree(10_000, 10), {
    width: 10_000,
    height: 15_000,
    x: 0,
    y: 7_495,
  });
  assert.throws(() => fitToTwoThree(Number.MAX_SAFE_INTEGER, 10));
});

test("URL parsing supports whitespace, preserves query commas, rejects credentials and executable schemes", () => {
  const urls = parseUrls(
    "https://a.test/a.png?q=1,2\nhttps://b.test/a.webp https://a.test/a.png?q=1,2\tjavascript:alert(1)\nhttps://u:p@a.test/",
  );
  assert.equal(urls.length, 4);
  assert.equal(urls[0].url, "https://a.test/a.png?q=1,2");
  assert.ok(urls[2].error && urls[3].error);
});

test("safe filenames preserve JPEG extension and avoid case-insensitive ZIP collisions", () => {
  const taken = new Set();
  assert.equal(outputName("PHOTO.jpeg", "jpeg", taken), "PHOTO_2x3.jpeg");
  assert.equal(outputName("photo.jpeg", "jpeg", taken), "photo_2x3_2.jpeg");
  assert.equal(outputName("photo.jpg", "jpeg", taken), "photo_2x3.jpg");
  assert.equal(
    outputName("../bad:path.png", "webp", taken),
    "_bad_path_2x3.webp",
  );
});

test("image validation accepts large dimensions but rejects HTML, animation and truncated inputs", () => {
  assert.throws(() =>
    inspectImage(new TextEncoder().encode("<html>not an image</html>").buffer),
  );
  const png = new Uint8Array(45);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const pv = new DataView(png.buffer);
  pv.setUint32(8, 13);
  png.set(new TextEncoder().encode("IHDR"), 12);
  pv.setUint32(16, 20);
  pv.setUint32(20, 30);
  assert.deepEqual(inspectImage(png.buffer), {
    format: "png",
    width: 20,
    height: 30,
  });
  png.set(new TextEncoder().encode("acTL"), 37);
  assert.throws(() => inspectImage(png.buffer), /움직이는 PNG/);
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(webp.buffer).setUint32(16, 10, true);
  webp[20] = 2;
  assert.throws(() => inspectImage(webp.buffer), /움직이는 WebP/);
  webp[20] = 0;
  webp[24] = 255;
  webp[25] = 255;
  assert.deepEqual(inspectImage(webp.buffer), {
    format: "webp",
    width: 65536,
    height: 1,
  });
  assert.throws(() => inspectImage(webp.slice(0, 24).buffer));
});

test("download names bind duplicate originals by ID and do not contain paths or shell syntax", () => {
  const item = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "../../한글'`$()*.webp",
  };
  const name = recoveryFilename(item);
  assert.equal(recoveryItemId(name), item.id);
  assert.match(name, /^[a-zA-Z0-9._-]+$/);
  assert.equal(recoveryItemId("ordinary.webp"), undefined);
  assert.throws(() =>
    buildDownloadCommand([{ ...item, url: "file:///etc/passwd" }]),
  );
  assert.throws(() =>
    buildDownloadCommand([
      { ...item, url: "https://user:pass@example.com/a.png" },
    ]),
  );
});

test("generated command downloads a batch unchanged, quotes URLs, and cleans only failed partial files", async () => {
  const received = [];
  const bytes = await readFile(
    new URL("./fixtures/pattern.webp", import.meta.url),
  );
  const server = createServer((req, res) => {
    received.push(req.url);
    res.writeHead(req.url.startsWith("/missing") ? 404 : 200, {
      "Content-Type": "image/webp",
    });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const inputs = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "photo.webp",
      url: `${base}/one?q=[]&quote='&literal=$(printf%20UNSAFE)`,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "photo.webp",
      url: `${base}/two`,
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      name: "bad.webp",
      url: `${base}/missing`,
    },
  ];
  let folder;
  try {
    const command = buildDownloadCommand(inputs);
    const child = spawn("/bin/bash", ["-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(command);
    const code = await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
    assert.equal(code, 1, stderr);
    assert.match(stdout, /완료 2개 \/ 실패 1개/);
    folder = stdout.match(/저장 위치: (.+)/)?.[1];
    assert.match(folder, /\/Downloads\/2x3-originals\.[a-zA-Z0-9]+$/);
    assert.deepEqual(
      (await readdir(folder)).sort(),
      inputs.slice(0, 2).map(recoveryFilename).sort(),
    );
    for (const item of inputs.slice(0, 2))
      assert.deepEqual(
        await readFile(`${folder}/${recoveryFilename(item)}`),
        bytes,
      );
    assert.deepEqual(
      received,
      inputs.map((item) => {
        const url = new URL(item.url);
        return url.pathname + url.search;
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (folder && /\/Downloads\/2x3-originals\.[a-zA-Z0-9]+$/.test(folder))
      await rm(folder, { recursive: true });
  }
});
