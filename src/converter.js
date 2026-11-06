import { fitToTwoThree, inspectImage, MAX_FILE_BYTES } from "./core.js";

export async function fetchImage(url, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 30_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
    });
    if (!response.ok)
      throw new Error(
        `이미지 서버가 HTTP ${response.status} 오류를 반환했습니다.`,
      );
    if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES)
      throw new Error("파일당 30 MB까지 지원합니다.");
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error("파일당 30 MB까지 지원합니다.");
      }
      chunks.push(value);
    }
    return new Blob(chunks, {
      type: response.headers.get("content-type") || "",
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("중지됨", "AbortError");
    if (controller.signal.aborted)
      throw new Error(
        "30초 안에 이미지를 불러오지 못했습니다. 파일로 첨부하거나 다시 시도해 주세요.",
      );
    if (error instanceof TypeError)
      throw new Error(
        "주소에 접근할 수 없습니다. 서버의 외부 접근 제한(CORS), 주소 또는 네트워크를 확인하거나 파일로 첨부해 주세요.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function encodeWebp(imageData, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./webp.worker.js", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      worker.terminate();
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("중지됨", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "WebP 변환 시간이 초과되었습니다. 더 작은 이미지로 시도해 주세요.",
        ),
      );
    }, 120_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(new Blob([data.result], { type: "image/webp" }));
    };
    worker.onerror = () => {
      cleanup();
      reject(
        new Error(
          "WebP 변환기를 실행할 수 없습니다. 최신 브라우저에서 다시 시도해 주세요.",
        ),
      );
    };
    worker.postMessage(
      {
        pixels: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height,
      },
      [imageData.data.buffer],
    );
  });
}

export async function convertImage(blob, signal) {
  if (blob.size > MAX_FILE_BYTES)
    throw new Error("파일당 30 MB까지 지원합니다.");
  const { format } = inspectImage(await blob.arrayBuffer());
  signal.throwIfAborted();
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "이미지를 열 수 없습니다. 파일이 손상되었거나 지원되지 않는 인코딩입니다.",
    );
  }
  let canvas;
  try {
    signal.throwIfAborted();
    const { width, height } = bitmap;
    const target = fitToTwoThree(width, height);
    if (width === target.width && height === target.height) {
      return {
        blob,
        format,
        width,
        height,
        originalWidth: width,
        originalHeight: height,
        unchanged: true,
      };
    }
    canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: format === "webp",
      colorSpace: "srgb",
    });
    if (!context)
      throw new Error(
        "이미지 처리에 필요한 메모리가 부족합니다. 더 작은 파일로 시도해 주세요.",
      );
    context.fillStyle = "#000000";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(bitmap, target.x, target.y);
    const mime = `image/${format}`;
    const result =
      format === "webp"
        ? await encodeWebp(
            context.getImageData(0, 0, target.width, target.height),
            signal,
          )
        : await new Promise((resolve) => canvas.toBlob(resolve, mime, 1));
    signal.throwIfAborted();
    if (!result || result.type !== mime)
      throw new Error(
        "원본 형식으로 저장하지 못했습니다. 최신 브라우저에서 다시 시도해 주세요.",
      );
    return {
      blob: result,
      format,
      width: target.width,
      height: target.height,
      originalWidth: width,
      originalHeight: height,
      unchanged: false,
    };
  } finally {
    bitmap.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
