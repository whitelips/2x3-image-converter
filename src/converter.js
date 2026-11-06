import { fitToTwoThree, inspectImage } from "./core.js";

export class RemoteImageAccessError extends Error {
  constructor() {
    super(
      "서버의 외부 접근 제한(CORS) 또는 네트워크 문제로 이미지를 읽을 수 없습니다. 원본을 저장한 뒤 파일로 첨부해 주세요.",
    );
    this.name = "RemoteImageAccessError";
  }
}

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
    // Only time out the initial response, not a large image's transfer.
    clearTimeout(timeout);
    return await response.blob();
  } catch (error) {
    if (signal.aborted) throw new DOMException("중지됨", "AbortError");
    if (controller.signal.aborted)
      throw new Error(
        "이미지 서버가 30초 안에 응답하지 않았습니다. 파일로 첨부하거나 다시 시도해 주세요.",
      );
    // Browsers deliberately hide whether this is CORS or another network failure.
    if (error instanceof TypeError) throw new RemoteImageAccessError();
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
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("중지됨", "AbortError"));
    };
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
  const { format } = inspectImage(await blob.arrayBuffer());
  signal.throwIfAborted();
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "이미지를 열 수 없습니다. 파일 손상, 지원되지 않는 인코딩 또는 브라우저 메모리 부족이 원인일 수 있습니다.",
    );
  }
  let canvas;
  let target;
  try {
    signal.throwIfAborted();
    const { width, height } = bitmap;
    target = fitToTwoThree(width, height);
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
    // libwebp's bitstream/encoder limit, not an application size policy.
    if (format === "webp" && (target.width > 16383 || target.height > 16383))
      throw new Error(
        `결과 크기 ${target.width} × ${target.height}px는 WebP 형식의 최대 변 길이 16,383px을 넘습니다. 원본 크기와 WebP 형식을 모두 유지한 2:3 변환은 불가능합니다.`,
      );
    canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: format === "webp",
      colorSpace: "srgb",
    });
    const canvasError = () =>
      new Error(
        `${target.width} × ${target.height}px 이미지를 처리하지 못했습니다. 현재 브라우저의 캔버스 한도 또는 사용 가능한 메모리를 확인해 주세요. 다른 데스크톱 브라우저에서 다시 시도할 수 있습니다.`,
      );
    if (!context) throw canvasError();
    // Some browsers return a context but silently ignore drawing on a canvas
    // they cannot allocate. Probe a pixel before accepting a blank result.
    context.fillStyle = "rgb(1, 2, 3)";
    context.fillRect(0, 0, 1, 1);
    const probe = context.getImageData(0, 0, 1, 1).data;
    if (probe[0] !== 1 || probe[1] !== 2 || probe[2] !== 3 || probe[3] !== 255)
      throw canvasError();
    context.fillStyle = "#000000";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(bitmap, target.x, target.y);
    bitmap.close();
    bitmap = undefined;
    const mime = `image/${format}`;
    let result;
    if (format === "webp") {
      const pixels = context.getImageData(0, 0, target.width, target.height);
      // Release the canvas before the worker allocates its codec buffers.
      canvas.width = 0;
      canvas.height = 0;
      result = await encodeWebp(pixels, signal);
    } else {
      result = await new Promise((resolve) => canvas.toBlob(resolve, mime, 1));
    }
    signal.throwIfAborted();
    if (!result || !result.size) throw canvasError();
    if (result.type !== mime)
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
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof RangeError || error instanceof DOMException)
      throw new Error(
        `${target ? `${target.width} × ${target.height}px ` : ""}이미지 처리 중 브라우저의 크기 또는 메모리 한도에 도달했습니다. 다른 데스크톱 브라우저에서 다시 시도해 주세요.`,
      );
    throw error;
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
