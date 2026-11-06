import "./style.css";
import { zip } from "fflate";
import { buildDownloadCommand, recoveryItemId } from "./download-command.js";
import {
  inspectImage,
  parseUrls,
  nameFromUrl,
  outputName,
  formatBytes,
} from "./core.js";
import {
  convertImage,
  fetchImage,
  RemoteImageAccessError,
} from "./converter.js";

const $ = (id) => document.getElementById(id);
const items = [];
const unmatchedFiles = [];
let galleryKey = "";
let busy = false;
let adding = false;
let controller;
let bundle;
const labels = {
  queued: "대기",
  processing: "변환 중",
  done: "완료",
  error: "확인 필요",
  "needs-file": "파일 첨부 필요",
};

const retryable = (item) => ["error", "needs-file"].includes(item.state);

function originalLink(item, text) {
  const link = element("a", "original-fallback", text);
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  return link;
}

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
function newItem(values) {
  return { id: crypto.randomUUID(), state: "queued", ...values };
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function recoveryFeedback(message = "") {
  $("recovery-feedback").textContent = message;
  $("recovery-feedback").hidden = !message;
}

function renderRecovery(locked) {
  const waiting = items.filter((item) => item.state === "needs-file");
  $("recovery-panel").hidden = !waiting.length && !unmatchedFiles.length;
  $("recovery-count").textContent = `${waiting.length}개 파일 연결 대기`;
  $("recovery-upload").disabled = locked || !waiting.length;
  $("recovery-file-input").disabled = locked || !waiting.length;
  $("copy-download-command").disabled = locked || !waiting.length;
  // Retain the image nodes while processing other items. No repeated requests
  // or loss of the user's native context menu on every progress update.
  const key = waiting
    .map((item) => `${item.id}-${items.indexOf(item)}`)
    .join(":");
  if (galleryKey !== key) {
    galleryKey = key;
    $("download-command").value = waiting.length
      ? buildDownloadCommand(waiting)
      : "";
    $("command-feedback").textContent = "";
    const gallery = document.createDocumentFragment();
    for (const item of waiting) {
      const card = element("figure", "original-card");
      card.id = `original-${item.id}`;
      const img = element("img", "original-image");
      img.alt = `${item.name} 원본 (저장용)`;
      img.referrerPolicy = "no-referrer";
      img.loading = "lazy";
      // Intentionally no crossorigin: display the original from its server.
      // The browser's Save Image action works without granting canvas access.
      img.src = item.url;
      const unavailable = element(
        "p",
        "original-unavailable",
        "이 화면에서 원본을 표시할 수 없습니다. 원본 링크를 열어 확인해 주세요.",
      );
      unavailable.hidden = true;
      img.addEventListener("error", () => {
        img.hidden = true;
        unavailable.hidden = false;
      });
      const caption = element("figcaption");
      const name = element(
        "span",
        "original-name",
        `${items.indexOf(item) + 1}. ${item.name}`,
      );
      name.title = item.name;
      caption.append(
        name,
        element("span", "original-host", new URL(item.url).hostname),
        originalLink(item, "원본 링크 열기 (새 탭) ↗"),
      );
      card.append(img, unavailable, caption);
      gallery.append(card);
    }
    $("original-gallery").replaceChildren(gallery);
  }
  $("attachment-review").hidden = !unmatchedFiles.length;
  const list = document.createDocumentFragment();
  for (const entry of unmatchedFiles) {
    if (!waiting.some((item) => item.id === entry.itemId)) entry.itemId = "";
    const row = element("li", "attachment-row");
    const name = element("span", "attachment-name", entry.file.name);
    name.title = entry.file.name;
    const select = element("select", "attachment-target");
    select.setAttribute("aria-label", `${entry.file.name} 연결할 원본`);
    select.disabled = locked;
    select.append(new Option("연결할 원본 선택", ""));
    for (const item of waiting)
      select.append(
        new Option(
          `${items.indexOf(item) + 1}. ${item.name} — ${new URL(item.url).hostname}`,
          item.id,
        ),
      );
    select.value = entry.itemId;
    select.addEventListener("change", () => {
      entry.itemId = select.value;
      $("apply-attachments").disabled = !unmatchedFiles.some(
        (file) => file.itemId,
      );
    });
    const remove = element("button", "icon-button", "×");
    remove.type = "button";
    remove.disabled = locked;
    remove.setAttribute("aria-label", `${entry.file.name} 첨부 취소`);
    remove.addEventListener("click", () => {
      unmatchedFiles.splice(unmatchedFiles.indexOf(entry), 1);
      render();
    });
    row.append(name, select, remove);
    list.append(row);
  }
  $("attachment-list").replaceChildren(list);
  $("apply-attachments").disabled =
    locked || !unmatchedFiles.some((entry) => entry.itemId);
}

function render() {
  const locked = busy || adding;
  const ready = items.filter((item) => item.state === "done");
  const pending = items.filter((item) => item.state === "queued");
  $("file-input").disabled = locked;
  $("drop-zone").disabled = locked;
  $("url-input").disabled = locked;
  $("add-urls").disabled = locked || !$("url-input").value.trim();
  $("clear-all").disabled =
    locked ||
    (!items.length && !unmatchedFiles.length && !$("url-input").value);
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
  $("retry").hidden = !items.some(retryable);
  $("retry").disabled = locked;
  renderRecovery(locked);
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
    if (item.error && item.state !== "needs-file")
      body.append(element("p", "item-error", item.error));
    if (item.state === "needs-file") {
      const recovery = element("div", "file-recovery");
      const steps = element("div", "recovery-actions");
      const original = element(
        "a",
        "button button-small button-secondary",
        "위 원본 모음에서 보기 ↑",
      );
      original.href = `#original-${item.id}`;
      original.addEventListener("click", () => {
        $("manual-save-help").open = true;
      });
      const fileInput = element("input");
      fileInput.type = "file";
      fileInput.accept =
        "image/webp,image/png,image/jpeg,.webp,.png,.jpg,.jpeg";
      fileInput.hidden = true;
      fileInput.disabled = locked;
      fileInput.setAttribute("aria-label", `${item.name} 저장한 파일 첨부`);
      fileInput.addEventListener("change", (event) => {
        const file = event.target.files[0];
        if (file) void restoreFile(item, file);
        event.target.value = "";
      });
      const upload = element(
        "button",
        "button button-small button-secondary",
        "이 항목에 파일 연결",
      );
      upload.type = "button";
      upload.disabled = locked;
      upload.addEventListener("click", () => fileInput.click());
      steps.append(original, upload, fileInput);
      recovery.append(
        steps,
        element(
          "span",
          "recovery-note",
          "여러 파일은 위에서 한 번에 첨부할 수 있어요.",
        ),
      );
      if (item.fileError)
        recovery.append(element("p", "item-error", item.fileError));
      body.append(recovery);
    }
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

async function validateFile(file) {
  inspectImage(await file.arrayBuffer());
}

function attachFile(item, file) {
  if (recoveryItemId(file.name) !== item.id) item.name = file.name;
  item.source = file;
  item.key = `${file.name}:${file.size}:${file.lastModified}`;
  item.preview = URL.createObjectURL(file);
  item.error = "";
  item.fileError = "";
  item.state = "queued";
}

async function restoreFile(item, file) {
  if (busy || adding || !items.includes(item) || item.state !== "needs-file")
    return;
  adding = true;
  render();
  let restored = false;
  try {
    await validateFile(file);
    attachFile(item, file);
    invalidateBundle();
    complete();
    restored = true;
  } catch (error) {
    item.fileError = error.message;
  } finally {
    adding = false;
    render();
  }
  if (restored) await convert(new Set([item.id]));
}

async function addFiles(files, { recoveryOnly = false } = {}) {
  if (busy || adding) return;
  adding = true;
  render();
  const errors = [];
  const restoredIds = new Set();
  let duplicates = 0;
  recoveryFeedback();
  try {
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (
        items.some((item) => item.key === key) ||
        unmatchedFiles.some((entry) => entry.key === key)
      ) {
        duplicates++;
        continue;
      }
      const remaining = items.filter((item) => item.state === "needs-file");
      const linkedId = recoveryItemId(file.name);
      let waiting = linkedId
        ? remaining.filter((item) => item.id === linkedId)
        : remaining.filter((item) => item.name === file.name);
      if (!waiting.length) {
        // Browser duplicate-save suffixes, e.g. photo (1).webp. Exact matches
        // take priority and ambiguous originals always require user selection.
        const originalName = file.name.replace(/ \(\d+\)(?=\.[^.]+$)/, "");
        waiting = remaining.filter((item) => item.name === originalName);
      }
      const replacement = waiting.length === 1 ? waiting[0] : undefined;
      try {
        await validateFile(file);
        if (replacement) {
          attachFile(replacement, file);
          restoredIds.add(replacement.id);
        } else if (recoveryOnly || waiting.length > 1) {
          unmatchedFiles.push({ file, key, itemId: "" });
        } else
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
    if (recoveryOnly) recoveryFeedback(errors.join("\n"));
    else notice(errors.join("\n"));
    complete();
    invalidateBundle();
    render();
  }
  if (restoredIds.size) await convert(restoredIds);
}

async function applyAttachments() {
  if (busy || adding) return;
  const selected = unmatchedFiles.filter((entry) => entry.itemId);
  const ids = new Set(selected.map((entry) => entry.itemId));
  if (!selected.length) return;
  if (ids.size !== selected.length) {
    recoveryFeedback(
      "같은 원본에 여러 파일을 연결할 수 없습니다. 연결할 원본을 각각 선택해 주세요.",
    );
    return;
  }
  if (
    selected.some(
      (entry) =>
        !items.some(
          (item) => item.id === entry.itemId && item.state === "needs-file",
        ),
    )
  ) {
    recoveryFeedback(
      "대기 목록이 바뀌었습니다. 연결할 원본을 다시 선택해 주세요.",
    );
    render();
    return;
  }
  for (const entry of selected) {
    attachFile(
      items.find((item) => item.id === entry.itemId),
      entry.file,
    );
    unmatchedFiles.splice(unmatchedFiles.indexOf(entry), 1);
  }
  recoveryFeedback();
  await convert(ids);
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

async function convert(onlyIds) {
  if (busy || adding) return;
  if (!onlyIds && $("url-input").value.trim()) addUrls();
  const pending = items.filter(
    (item) => item.state === "queued" && (!onlyIds || onlyIds.has(item.id)),
  );
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
        item.state =
          error instanceof RemoteImageAccessError ? "needs-file" : "error";
      }
      $("progress").value = ++processed;
      render();
    }
    const successes = items.filter((item) => item.result).length;
    const failures = items.filter((item) => item.state === "error").length;
    const awaitingFiles = items.filter(
      (item) => item.state === "needs-file",
    ).length;
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
        `${successes}개 준비 완료${failures ? ` · ${failures}개는 확인이 필요합니다` : ""}${awaitingFiles ? ` · ${awaitingFiles}개는 원본 저장 후 파일 첨부가 필요합니다` : ""}. ${auto ? "자동 다운로드를 요청했습니다. 저장되지 않으면 다운로드 버튼을 눌러주세요." : "다운로드 버튼을 눌러 저장해 주세요."}`,
      );
      if (auto) downloadBundle();
    } else if (awaitingFiles) {
      complete(
        `${awaitingFiles}개는 파일 첨부가 필요합니다. 아래 일괄 다운로드 명령으로 원본을 받은 뒤 한 번에 첨부해 주세요.${failures ? ` 다른 ${failures}개 항목은 오류를 확인해 주세요.` : ""}`,
      );
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
$("recovery-upload").addEventListener("click", () =>
  $("recovery-file-input").click(),
);
$("copy-download-command").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("download-command").value);
    $("command-feedback").textContent =
      "복사했습니다. Mac 터미널에 붙여넣고 Enter를 누르세요.";
  } catch {
    $("command-details").open = true;
    $("download-command").focus();
    $("download-command").select();
    $("command-feedback").textContent =
      "자동 복사가 차단되었습니다. 선택된 명령을 ⌘C로 복사해 주세요.";
  }
});
$("recovery-file-input").addEventListener("change", (event) => {
  void addFiles([...event.target.files], { recoveryOnly: true });
  event.target.value = "";
});
$("recovery-upload").addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!busy && !adding) $("recovery-upload").classList.add("drag-over");
});
$("recovery-upload").addEventListener("dragleave", () =>
  $("recovery-upload").classList.remove("drag-over"),
);
$("recovery-upload").addEventListener("drop", (event) => {
  event.preventDefault();
  $("recovery-upload").classList.remove("drag-over");
  void addFiles([...event.dataTransfer.files], { recoveryOnly: true });
});
$("apply-attachments").addEventListener("click", () => void applyAttachments());
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
  items.filter(retryable).forEach((item) => {
    item.state = "queued";
    item.error = "";
  });
  void convert();
});
$("clear-all").addEventListener("click", () => {
  invalidateBundle();
  items.forEach(release);
  items.length = 0;
  unmatchedFiles.length = 0;
  $("url-input").value = "";
  notice();
  complete();
  recoveryFeedback();
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
