import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { createServer } from "node:http";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function solidImage(page, width, height, format) {
  return Buffer.from(
    await page.evaluate(
      async ({ width, height, format }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "rgb(200, 30, 70)";
        ctx.fillRect(0, 0, width, height);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, `image/${format}`, 1),
        );
        canvas.width = canvas.height = 0;
        return [...new Uint8Array(await blob.arrayBuffer())];
      },
      { width, height, format },
    ),
  );
}

for (const [format, width, height, resultWidth, resultHeight] of [
  ["png", 12, 8400, 5600, 8400],
  ["webp", 3800, 5400, 3800, 5700],
]) {
  test(`large ${format} crosses the former source/output size caps without scaling`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("./");
    const source =
      format === "webp"
        ? await readFile(fixture("large.webp"))
        : await solidImage(page, width, height, format);
    await page
      .locator("#file-input")
      .setInputFiles({
        name: `large.${format}`,
        mimeType: `image/${format}`,
        buffer: source,
      });
    await expect(page.locator("#item-count")).toHaveText("1");
    const saved = page.waitForEvent("download", { timeout: 110_000 });
    await page.locator("#convert").click();
    const download = await saved;
    expect(download.suggestedFilename()).toBe(`large_2x3.${format}`);
    const output = await readFile(await download.path());
    const actual = await page.evaluate(
      async ({ source, output }) => {
        const original = await createImageBitmap(
          new Blob([new Uint8Array(source)]),
        );
        const result = await createImageBitmap(
          new Blob([new Uint8Array(output)]),
        );
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        const pixel = (image, x, y) => {
          ctx.drawImage(image, -x, -y);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        const x = Math.floor((result.width - original.width) / 2);
        const y = Math.floor((result.height - original.height) / 2);
        const data = {
          width: result.width,
          height: result.height,
          original: pixel(original, 0, 0),
          first: pixel(result, x, y),
          last: pixel(result, x + original.width - 1, y + original.height - 1),
          padding: pixel(result, 0, 0),
        };
        original.close();
        result.close();
        return data;
      },
      { source: [...source], output: [...output] },
    );
    expect([actual.width, actual.height]).toEqual([resultWidth, resultHeight]);
    expect(actual.first).toEqual(actual.original);
    expect(actual.last).toEqual(actual.original);
    expect(actual.padding).toEqual([0, 0, 0, 255]);
    await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(1);
  });
}

test("encoding allocation failure is explained and the remaining files still finish", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, mime, quality) {
      if (mime === "image/png") return callback(null);
      return encode.call(this, callback, mime, quality);
    };
  });
  await page.goto("./");
  await page.locator("#auto-download").uncheck();
  await page
    .locator("#file-input")
    .setInputFiles([fixture("pattern.png"), fixture("pattern.jpeg")]);
  await expect(page.locator("#item-count")).toHaveText("2");
  await page.locator("#convert").click();
  await expect(page.locator('.queue-item[data-state="error"]')).toContainText(
    "메모리",
  );
  await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(1);
  await expect(page.locator("#download-all")).toBeEnabled();
});

test("WebP's actual format boundary is explained before allocating a huge output", async ({
  page,
}) => {
  await page.goto("./");
  const source = await readFile(fixture("wide.webp"));
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "wide.webp",
      mimeType: "image/webp",
      buffer: source,
    });
  await expect(page.locator("#item-count")).toHaveText("1");
  await page.locator("#convert").click();
  await expect(page.locator('.queue-item[data-state="error"]')).toContainText(
    "WebP 형식의 최대 변 길이 16,383px",
  );
  await expect(page.locator("#download-all")).toBeHidden();
});

test("batch upload automatically downloads ZIP, keeps formats and exact pixels for PNG/WebP", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  const names = [
    "pattern.png",
    "pattern.webp",
    "pattern.jpeg",
    "tall.png",
    "already-2x3.jpeg",
    "transparent.png",
  ];
  await page.locator("#file-input").setInputFiles(names.map(fixture));
  await expect(page.locator("#item-count")).toHaveText("6");
  const downloaded = page.waitForEvent("download");
  await page.locator("#convert").click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("images-2x3.zip");
  const files = unzipSync(await readFile(await download.path()));
  expect(Object.keys(files)).toHaveLength(6);
  await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(6);
  expect(Buffer.from(files["already-2x3_2x3.jpeg"])).toEqual(
    await readFile(fixture("already-2x3.jpeg")),
  );
  for (const name of names.filter((name) => !name.startsWith("already"))) {
    const output =
      files[name.replace(/\.[^.]+$/, "") + "_2x3." + name.split(".").pop()];
    expect(output).toBeTruthy();
    if (name.endsWith(".webp"))
      expect(Buffer.from(output).subarray(0, 4).toString()).toBe("RIFF");
    if (name.endsWith(".jpeg"))
      expect([...output.subarray(0, 2)]).toEqual([255, 216]);
    const result = await page.evaluate(
      async ({ original, output }) => {
        async function decode(bytes) {
          return createImageBitmap(new Blob([new Uint8Array(bytes)]));
        }
        const source = await decode(original);
        const target = await decode(output);
        const canvas = document.createElement("canvas");
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          source,
          Math.floor((target.width - source.width) / 2),
          Math.floor((target.height - source.height) / 2),
        );
        const expected = ctx.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        ctx.drawImage(target, 0, 0);
        const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const differences = actual.reduce(
          (count, value, i) => count + (value !== expected[i] ? 1 : 0),
          0,
        );
        return { width: target.width, height: target.height, differences };
      },
      { original: [...(await readFile(fixture(name)))], output: [...output] },
    );
    expect(result.width * 3).toBe(result.height * 2);
    if (!name.endsWith(".jpeg")) expect(result.differences, name).toBe(0);
  }
  expect(errors).toEqual([]);
});

test("multiple URLs, partial errors, safe retries and manual download work", async ({
  page,
}) => {
  await page.goto("./");
  const png = await readFile(fixture("pattern.png"));
  await page.route("https://images.example/**", async (route) => {
    if (route.request().url().includes("blocked")) return route.abort("failed");
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: png,
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.locator("#auto-download").uncheck();
  await page
    .locator("#url-input")
    .fill(
      "https://images.example/a.png\nhttps://images.example/blocked.webp\nhttps://images.example/b.png\nhttps://images.example/a.png",
    );
  await page.locator("#convert").click();
  await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(2);
  await expect(
    page.locator('.queue-item[data-state="needs-file"]'),
  ).toHaveCount(1);
  await expect(page.locator(".item-error")).toContainText("CORS");
  await expect(page.locator("#item-count")).toHaveText("3");
  await expect(page.locator("#download-all")).toBeEnabled();
  await page.unroute("https://images.example/**");
  await page.route("https://images.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: png,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.locator("#retry").click();
  await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(3);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-all").click();
  const downloaded = await downloadPromise;
  const files = unzipSync(await readFile(await downloaded.path()));
  expect(Object.keys(files).sort()).toEqual([
    "a_2x3.png",
    "b_2x3.png",
    "blocked_2x3.png",
  ]);
});

test("real cross-origin image without CORS opens for saving and attachment resumes the same item", async ({
  page,
  context,
}) => {
  const bytes = await readFile(fixture("pattern.webp"));
  const modes = [];
  const server = createServer((req, res) => {
    modes.push(req.headers["sec-fetch-mode"]);
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Cache-Control": "no-store",
    });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/original.webp`;
  const requestedHosts = new Set();
  context.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (["http:", "https:"].includes(requestUrl.protocol))
      requestedHosts.add(requestUrl.hostname);
  });
  try {
    await page.goto("./");
    await page.locator("#url-input").fill(url);
    const opened = page.waitForEvent("popup");
    await page.locator("#convert").click();
    const original = await opened;
    await original.waitForURL(url);
    const waiting = page.locator('.queue-item[data-state="needs-file"]');
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText(
      "다운로드 완료 여부는 확인할 수 없습니다",
    );
    expect(await original.evaluate(() => window.opener === null)).toBe(true);
    expect(page.url()).toContain("/2x3-image-converter/");
    await expect(page.locator("#download-all")).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(modes).toContain("cors");
    expect(modes).toContain("navigate");
    const originalLink = waiting.getByRole("link", {
      name: /원본 열기 및 저장/,
    });
    expect(await originalLink.getAttribute("href")).toBe(url);
    expect(await originalLink.getAttribute("rel")).toBe("noopener noreferrer");

    // Invalid attachment must not lose the original URL or create a new item.
    await waiting.locator('input[type="file"]').setInputFiles({
      name: "broken.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("not an image"),
    });
    await expect(waiting).toContainText(
      "WebP, PNG, JPEG 이미지 파일만 지원합니다",
    );
    await expect(page.locator("#item-count")).toHaveText("1");
    const downloadWait = page.waitForEvent("download");
    await waiting.locator('input[type="file"]').setInputFiles({
      name: "saved-original.webp",
      mimeType: "image/webp",
      buffer: bytes,
    });
    const result = await downloadWait;
    expect(result.suggestedFilename()).toBe("saved-original_2x3.webp");
    await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(1);
    await expect(page.locator("#item-count")).toHaveText("1");
    expect([...requestedHosts]).toEqual(["127.0.0.1"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("normal upload reconnects one matching URL and blocked popups keep a working save link", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Simulate a browser blocking automatic popup/download navigation.
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.target === "_blank") return;
      click.call(this);
    };
  });
  await page.goto("./");
  await page.route("https://images.example/**", (route) =>
    route.abort("failed"),
  );
  await page
    .locator("#url-input")
    .fill("https://images.example/already-2x3.jpeg");
  await page.locator("#convert").click();
  const waiting = page.locator('.queue-item[data-state="needs-file"]');
  await expect(waiting).toHaveCount(1);
  await expect(
    waiting.getByRole("link", { name: /원본 열기 및 저장/ }),
  ).toBeVisible();
  await expect(waiting).toContainText("아무 반응이 없으면");
  const downloaded = page.waitForEvent("download");
  await page.locator("#file-input").setInputFiles(fixture("already-2x3.jpeg"));
  const result = await downloaded;
  expect(await readFile(await result.path())).toEqual(
    await readFile(fixture("already-2x3.jpeg")),
  );
  await expect(page.locator("#item-count")).toHaveText("1");
  await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(1);
});

test("single JPEG keeps .jpg extension; duplicate names cannot overwrite ZIP entries", async ({
  page,
}) => {
  await page.goto("./");
  const first = await readFile(fixture("pattern.jpeg"));
  await page.locator("#file-input").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: first,
  });
  await expect(page.locator("#item-count")).toHaveText("1");
  let event = page.waitForEvent("download");
  await page.locator("#convert").click();
  expect((await event).suggestedFilename()).toBe("photo_2x3.jpg");
  await page.locator("#file-input").setInputFiles({
    name: "photo.jpg",
    mimeType: "image/jpeg",
    buffer: await readFile(fixture("already-2x3.jpeg")),
  });
  await expect(page.locator("#item-count")).toHaveText("2");
  event = page.waitForEvent("download");
  await page.locator("#convert").click();
  const download = await event;
  expect(
    Object.keys(unzipSync(await readFile(await download.path()))).sort(),
  ).toEqual(["photo_2x3.jpg", "photo_2x3_2.jpg"]);
});

test("invalid input is escaped; unsupported files are rejected; reset clears the queue", async ({
  page,
}) => {
  await page.goto("./");
  await page.locator("#url-input").fill("javascript:alert(1)");
  await page.locator("#add-urls").click();
  await expect(page.locator("#notice")).toContainText("http:// 또는 https://");
  await expect(page.locator("#item-count")).toHaveText("0");
  await page.locator("#file-input").setInputFiles({
    name: "<img src=x onerror=alert(1)>.png",
    mimeType: "image/png",
    buffer: Buffer.from("<html>no image</html>"),
  });
  await expect(page.locator("#notice")).toContainText("WebP, PNG, JPEG");
  await expect(page.locator("#notice img")).toHaveCount(0);
  await page.locator("#file-input").setInputFiles(fixture("pattern.png"));
  await expect(page.locator("#item-count")).toHaveText("1");
  await page.locator("#clear-all").click();
  await expect(page.locator("#item-count")).toHaveText("0");
  await expect(page.locator("#convert")).toBeDisabled();
});

test("cancelling a pending URL leaves it restartable and never downloads partial work automatically", async ({
  page,
}) => {
  await page.goto("./");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("https://images.example/slow.png", async (route) => {
    await held;
    await route
      .fulfill({
        status: 200,
        contentType: "image/png",
        body: await readFile(fixture("pattern.png")),
      })
      .catch(() => {});
  });
  await page.locator("#url-input").fill("https://images.example/slow.png");
  await page.locator("#convert").click();
  await expect(page.locator("#cancel")).toBeVisible();
  await page.locator("#cancel").click();
  await expect(page.locator("#completion")).toContainText("중지했습니다");
  await expect(page.locator("#convert")).toBeEnabled();
  await expect(page.locator('.queue-item[data-state="queued"]')).toHaveCount(1);
  release();
});

test("mobile layout remains within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("./");
  await page.locator("#auto-download").uncheck();
  await page.locator("#file-input").setInputFiles(fixture("pattern.webp"));
  await expect(page.locator("#item-count")).toHaveText("1");
  await page.locator("#convert").click();
  await expect(page.locator('.queue-item[data-state="done"]')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
