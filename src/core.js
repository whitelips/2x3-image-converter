export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_PIXELS = 20_000_000;
export const MAX_EDGE = 8192;

export function fitToTwoThree(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("이미지 크기를 확인할 수 없습니다.");
  }
  const unit = Math.max(Math.ceil(width / 2), Math.ceil(height / 3));
  const targetWidth = unit * 2;
  const targetHeight = unit * 3;
  if (
    targetWidth > MAX_EDGE ||
    targetHeight > MAX_EDGE ||
    targetWidth * targetHeight > MAX_PIXELS
  ) {
    throw new Error(
      "결과 이미지가 너무 큽니다. 결과 기준 2,000만 픽셀, 한 변 8,192px까지 지원합니다.",
    );
  }
  return {
    width: targetWidth,
    height: targetHeight,
    x: Math.floor((targetWidth - width) / 2),
    y: Math.floor((targetHeight - height) / 2),
  };
}

export function parseUrls(text) {
  return [...new Set(text.trim().split(/\s+/).filter(Boolean))].map((input) => {
    try {
      const url = new URL(input);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      url.hash = "";
      return { url: url.href };
    } catch {
      return {
        input,
        error: "http:// 또는 https://로 시작하는 이미지 주소를 입력해 주세요.",
      };
    }
  });
}

export function nameFromUrl(url) {
  try {
    const name = new URL(url).pathname.split("/").pop();
    return decodeURIComponent(name || "image");
  } catch {
    return "image";
  }
}

export function outputName(name, format, taken) {
  const ext = format === "jpeg" && /\.jpg$/i.test(name) ? "jpg" : format;
  const stem =
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 100) || "image";
  let candidate = `${stem}_2x3.${ext}`;
  let n = 2;
  while (taken.has(candidate.toLowerCase()))
    candidate = `${stem}_2x3_${n++}.${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

const ascii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

// Inspect the container before decoding, including dimensions and animation.
export function inspectImage(buffer) {
  const b = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let format, width, height;
  if (b.length >= 24 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") {
    format = "png";
    width = view.getUint32(16);
    height = view.getUint32(20);
    for (let offset = 8; offset + 12 <= b.length; ) {
      const length = view.getUint32(offset);
      const type = ascii(b, offset + 4, 4);
      if (type === "acTL")
        throw new Error(
          "움직이는 PNG는 지원하지 않습니다. 정지 이미지를 첨부해 주세요.",
        );
      offset += length + 12;
    }
  } else if (
    b.length >= 30 &&
    ascii(b, 0, 4) === "RIFF" &&
    ascii(b, 8, 4) === "WEBP"
  ) {
    format = "webp";
    for (let offset = 12; offset + 8 <= b.length; ) {
      const type = ascii(b, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const p = offset + 8;
      if (p + length > b.length)
        throw new Error("WebP 파일이 손상되었거나 불완전합니다.");
      if (type === "ANIM" || (type === "VP8X" && b[p] & 2)) {
        throw new Error(
          "움직이는 WebP는 지원하지 않습니다. 정지 이미지를 첨부해 주세요.",
        );
      }
      if (type === "VP8X" && length >= 10) {
        width = 1 + b[p + 4] + (b[p + 5] << 8) + (b[p + 6] << 16);
        height = 1 + b[p + 7] + (b[p + 8] << 8) + (b[p + 9] << 16);
      } else if (!width && type === "VP8 " && length >= 10) {
        width = view.getUint16(p + 6, true) & 0x3fff;
        height = view.getUint16(p + 8, true) & 0x3fff;
      } else if (!width && type === "VP8L" && length >= 5) {
        const bits = view.getUint32(p + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      offset = p + length + (length % 2);
    }
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    format = "jpeg";
    for (let offset = 2; offset + 4 <= b.length; ) {
      if (b[offset++] !== 0xff) break;
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > b.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > b.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 7
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else {
    throw new Error(
      "WebP, PNG, JPEG 이미지 파일만 지원합니다. 웹페이지 주소가 아닌 이미지 주소인지 확인해 주세요.",
    );
  }
  if (!width || !height)
    throw new Error(
      "이미지 정보를 읽을 수 없습니다. 파일이 손상되었는지 확인해 주세요.",
    );
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new Error(
      "원본 이미지가 너무 큽니다. 2,000만 픽셀, 한 변 8,192px까지 지원합니다.",
    );
  }
  return { format, width, height };
}

export function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
