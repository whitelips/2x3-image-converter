import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.throws(() => fitToTwoThree(10_000, 10));
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

test("image validation rejects HTML, animated PNG/WebP, oversized and truncated inputs", () => {
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
  assert.throws(() => inspectImage(webp.buffer), /너무 큽니다/);
  assert.throws(() => inspectImage(webp.slice(0, 24).buffer));
});
