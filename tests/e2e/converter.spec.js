import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const fixture = (name) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

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
  await expect(page.locator('.queue-item[data-state="error"]')).toHaveCount(1);
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

test("single JPEG keeps .jpg extension; duplicate names cannot overwrite ZIP entries", async ({
  page,
}) => {
  await page.goto("./");
  const first = await readFile(fixture("pattern.jpeg"));
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      buffer: first,
    });
  await expect(page.locator("#item-count")).toHaveText("1");
  let event = page.waitForEvent("download");
  await page.locator("#convert").click();
  expect((await event).suggestedFilename()).toBe("photo_2x3.jpg");
  await page
    .locator("#file-input")
    .setInputFiles({
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
  await page
    .locator("#file-input")
    .setInputFiles({
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
