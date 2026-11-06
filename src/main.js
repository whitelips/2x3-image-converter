import "./style.css";
import { zip } from "fflate";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  inspectImage,
  parseUrls,
  nameFromUrl,
  outputName,
  formatBytes,
} from "./core.js";
import { convertImage, fetchImage } from "./converter.js";

const $ = (id) => document.getElementById(id);
const items = [];
let busy = false;
let adding = false;
let controller;
let bundle;
const labels = {
  queued: "대기",
  processing: "변환 중",
  done: "완료",
  error: "확인 필요",
};

function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function complete(message = "") {
  $("completion").textContent = message;
  $("completion").hidden = !message;
}
function invalidateBundle() {
  if (bundle?.temporary) URL.revokeObjectURL(bundle.url);
  bundle = undefined;
}
function release(item) {
  if (item.preview) URL.revokeObjectURL(item.preview);
  if (item.result?.url) URL.revokeObjectURL(item.result.url);
}
function sourceBytes() {
  return items.reduce((sum, item) => sum + (item.source?.size || 0), 0);
}
function newItem(values) {
  return { id: crypto.randomUUID(), state: "queued", ...values };
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function render() {
  const locked = busy || adding;
  const ready = items.filter((item) => item.state === "done");
  const pending = items.filter((item) => item.state === "queued");
  $("file-input").disabled = locked;
  $("drop-zone").disabled = locked;
  $("url-input").disabled = locked;
  $("add-urls").disabled = locked || !$("url-input").value.trim();
  $("clear-all").disabled = locked || (!items.length && !$("url-input").value);
  $("convert").disabled =
    locked || (!pending.length && !$("url-input").value.trim());
  $("convert").hidden = busy;
  $("cancel").hidden = !busy || !controller;
  $("convert-label").textContent = pending.length
    ? `${pending.length}개 · 2:3으로 변환`
    : "2:3으로 변환";
  $("item-count").textContent = items.length;
  $("empty-state").hidden = !!items.length;
  $("download-all").hidden = !ready.length;
  $("download-all").disabled = locked;
  $("download-all").textContent =
    ready.length > 1 ? `${ready.length}개 ZIP 다운로드 ↓` : "이미지 다운로드 ↓";
  $("retry").hidden = !items.some((item) => item.state === "error");
  $("retry").disabled = locked;
  const list = document.createDocumentFragment();
  for (const item of items) {
    const row = element("li", "queue-item");
    row.dataset.state = item.state;
    const preview = element("div", "item-preview");
    if (item.result?.url || item.preview) {
      const img = element("img");
      img.src = item.result?.url || item.preview;
      img.alt = `${item.name} ${item.result ? "변환 결과" : "원본"} 미리보기`;
      img.loading = "lazy";
      preview.append(img);
    } else {
      preview.textContent = "↗";
    }
    const body = element("div", "item-body");
    const name = element("span", "item-name", item.name);
    name.title = item.name;
    body.append(name);
    let meta = item.source
      ? formatBytes(item.source.size)
      : "URL 이미지 · 변환 시 불러오기";
    if (item.result) {
      const r = item.result;
      meta = `${r.format.toUpperCase()} · ${r.originalWidth} × ${r.originalHeight} → ${r.width} × ${r.height} · ${formatBytes(r.blob.size)}`;
      if (r.unchanged) meta += " · 이미 2:3, 원본 유지";
      else if (r.format === "jpeg") meta += " · 최고 품질 재압축";
      else meta += " · 무손실 저장";
    }
    body.append(element("span", "item-meta", meta));
    if (item.error) body.append(element("p", "item-error", item.error));
    const controls = element("div", "item-controls");
    controls.append(element("span", "item-status", labels[item.state]));
    if (item.result) {
      const download = element("a", "download-link", "저장 ↓");
      download.href = item.result.url;
      download.download = item.result.name;
      download.setAttribute("aria-label", `${item.name} 다운로드`);
      controls.append(download);
    }
    const remove = element("button", "icon-button", "×");
    remove.type = "button";
    remove.disabled = locked;
    remove.setAttribute("aria-label", `${item.name} 삭제`);
    remove.addEventListener("click", () => {
      release(item);
      items.splice(items.indexOf(item), 1);
      invalidateBundle();
      complete();
      render();
    });
    controls.append(remove);
    row.append(preview, body, controls);
    list.append(row);
  }
  $("queue").replaceChildren(list);
}

async function addFiles(files) {
  if (busy || adding) return;
  adding = true;
  render();
  const errors = [];
  let duplicates = 0;
  try {
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (items.some((item) => item.key === key)) {
        duplicates++;
        continue;
      }
      if (items.length >= MAX_FILES) {
        errors.push("최대 50개까지 추가할 수 있습니다.");
        break;
      }
      try {
        if (file.size > MAX_FILE_BYTES)
          throw new Error("파일당 30 MB까지 지원합니다.");
        if (sourceBytes() + file.size > MAX_TOTAL_BYTES)
          throw new Error("전체 원본 용량은 200 MB까지 지원합니다.");
        inspectImage(await file.arrayBuffer());
        items.push(
          newItem({
            name: file.name,
            source: file,
            key,
            preview: URL.createObjectURL(file),
          }),
        );
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }
  } finally {
    adding = false;
    if (duplicates)
      errors.push(`이미 목록에 있는 파일 ${duplicates}개는 제외했습니다.`);
    notice(errors.join("\n"));
    complete();
    invalidateBundle();
    render();
  }
}

function addUrls() {
  const parsed = parseUrls($("url-input").value);
  const errors = [];
  const remaining = [];
  let duplicates = 0;
  for (const entry of parsed) {
    if (entry.error) {
      errors.push(`${entry.input}: ${entry.error}`);
      remaining.push(entry.input);
      continue;
    }
    if (items.some((item) => item.url === entry.url)) {
      duplicates++;
      continue;
    }
    if (items.length >= MAX_FILES) {
      remaining.push(entry.url);
      errors.push("최대 50개까지 추가할 수 있습니다.");
      continue;
    }
    items.push(newItem({ name: nameFromUrl(entry.url), url: entry.url }));
  }
  if (duplicates)
    errors.push(`이미 목록에 있는 URL ${duplicates}개는 제외했습니다.`);
  $("url-input").value = remaining.join("\n");
  notice([...new Set(errors)].join("\n"));
  invalidateBundle();
  complete();
  render();
}

async function buildBundle() {
  if (bundle) return bundle;
  const ready = items.filter((item) => item.result);
  if (!ready.length) return;
  if (ready.length === 1) {
    bundle = {
      url: ready[0].result.url,
      name: ready[0].result.name,
      temporary: false,
    };
    return bundle;
  }
  const files = Object.create(null);
  for (const item of ready)
    files[item.result.name] = new Uint8Array(
      await item.result.blob.arrayBuffer(),
    );
  const zipped = await new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) =>
      error ? reject(error) : resolve(data),
    );
  });
  bundle = {
    url: URL.createObjectURL(new Blob([zipped], { type: "application/zip" })),
    name: "images-2x3.zip",
    temporary: true,
  };
  return bundle;
}
function downloadBundle() {
  if (!bundle) return;
  const link = element("a");
  link.href = bundle.url;
  link.download = bundle.name;
  document.body.append(link);
  link.click();
  link.remove();
}

async function convert() {
  if (busy || adding) return;
  if ($("url-input").value.trim()) addUrls();
  const pending = items.filter((item) => item.state === "queued");
  if (!pending.length) return;
  busy = true;
  controller = new AbortController();
  const signal = controller.signal;
  invalidateBundle();
  complete();
  const taken = new Set(
    items
      .filter((item) => item.result)
      .map((item) => item.result.name.toLowerCase()),
  );
  $("progress-area").hidden = false;
  $("progress").max = pending.length;
  $("progress").value = 0;
  let processed = 0;
  try {
    for (const item of pending) {
      if (signal.aborted) break;
      item.state = "processing";
      item.error = "";
      $("progress-text").textContent = item.source
        ? "검은 여백을 더하고 있어요."
        : "URL에서 이미지를 불러오고 있어요.";
      $("progress-count").textContent = `${processed + 1} / ${pending.length}`;
      render();
      try {
        if (!item.source) {
          const blob = await fetchImage(item.url, signal);
          if (sourceBytes() + blob.size > MAX_TOTAL_BYTES)
            throw new Error(
              "전체 원본 용량은 200 MB까지 지원합니다. 목록을 나눠서 변환해 주세요.",
            );
          inspectImage(await blob.arrayBuffer());
          item.source = blob;
          item.preview = URL.createObjectURL(blob);
        }
        const result = await convertImage(item.source, signal);
        result.name = outputName(item.name, result.format, taken);
        result.url = URL.createObjectURL(result.blob);
        item.result = result;
        item.state = "done";
      } catch (error) {
        if (signal.aborted) {
          item.state = "queued";
          break;
        }
        item.error =
          error.message || "변환 중 오류가 발생했습니다. 다시 시도해 주세요.";
        item.state = "error";
      }
      $("progress").value = ++processed;
      render();
    }
    const successes = items.filter((item) => item.result).length;
    const failures = items.filter((item) => item.state === "error").length;
    if (signal.aborted) {
      complete(
        `변환을 중지했습니다. 완료된 ${successes}개는 다운로드할 수 있고, 나머지는 다시 시작할 수 있습니다.`,
      );
    } else if (successes) {
      $("progress-text").textContent =
        successes > 1
          ? "다운로드할 ZIP 파일을 준비하고 있어요."
          : "다운로드를 준비하고 있어요.";
      controller = undefined;
      render();
      await buildBundle();
      const auto = $("auto-download").checked;
      complete(
        `${successes}개 준비 완료${failures ? ` · ${failures}개는 확인이 필요합니다` : ""}. ${auto ? "자동 다운로드를 요청했습니다. 저장되지 않으면 다운로드 버튼을 눌러주세요." : "다운로드 버튼을 눌러 저장해 주세요."}`,
      );
      if (auto) downloadBundle();
    } else {
      complete("변환된 이미지가 없습니다. 각 항목의 안내를 확인해 주세요.");
    }
  } catch {
    complete(
      "묶음 다운로드를 준비하지 못했습니다. 완료된 이미지는 각 항목의 저장 버튼으로 다운로드할 수 있습니다.",
    );
  } finally {
    busy = false;
    controller = undefined;
    $("progress-area").hidden = true;
    render();
  }
}

$("drop-zone").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  void addFiles([...event.target.files]);
  event.target.value = "";
});
let dragDepth = 0;
$("drop-zone").addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  if (!busy && !adding) $("drop-zone").classList.add("drag-over");
});
$("drop-zone").addEventListener("dragover", (event) => event.preventDefault());
$("drop-zone").addEventListener("dragleave", () => {
  if (--dragDepth <= 0) $("drop-zone").classList.remove("drag-over");
});
$("drop-zone").addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("drop-zone").classList.remove("drag-over");
  void addFiles([...event.dataTransfer.files]);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
$("url-input").addEventListener("input", render);
$("add-urls").addEventListener("click", addUrls);
$("convert").addEventListener("click", () => void convert());
$("cancel").addEventListener("click", () => controller?.abort());
$("retry").addEventListener("click", () => {
  items
    .filter((item) => item.state === "error")
    .forEach((item) => {
      item.state = "queued";
      item.error = "";
    });
  void convert();
});
$("clear-all").addEventListener("click", () => {
  invalidateBundle();
  items.forEach(release);
  items.length = 0;
  $("url-input").value = "";
  notice();
  complete();
  render();
});
$("download-all").addEventListener("click", async () => {
  if (busy || adding) return;
  busy = true;
  render();
  try {
    await buildBundle();
    downloadBundle();
  } catch {
    notice(
      "ZIP 파일을 만들지 못했습니다. 각 항목의 저장 버튼을 이용해 주세요.",
    );
  } finally {
    busy = false;
    render();
  }
});
render();
