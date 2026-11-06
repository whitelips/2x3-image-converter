import encode, { init } from "@jsquash/webp/encode.js";
import wasmUrl from "@jsquash/webp/codec/enc/webp_enc.wasm?url";
import simdWasmUrl from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?url";

const ready = init({
  locateFile: (path) => (path.includes("simd") ? simdWasmUrl : wasmUrl),
});
self.onmessage = async ({ data: { pixels, width, height } }) => {
  try {
    await ready;
    const result = await encode(
      { data: new Uint8ClampedArray(pixels), width, height },
      {
        lossless: 1,
        near_lossless: 100,
        exact: 1,
        quality: 100,
        method: 4,
      },
    );
    self.postMessage({ result }, [result]);
  } catch {
    self.postMessage({
      error:
        "WebP 무손실 변환에 실패했습니다. 파일 크기를 줄이거나 다시 시도해 주세요.",
    });
  }
};
