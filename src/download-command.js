const ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const validId = new RegExp(`^${ID_PATTERN}$`, "i");
const fileId = new RegExp(`^2x3-(${ID_PATTERN})--`, "i");

export function recoveryItemId(name) {
  return name.match(fileId)?.[1];
}

export function recoveryFilename(item) {
  if (!validId.test(item.id))
    throw new Error("파일 연결 정보를 확인할 수 없습니다.");
  // A bounded ASCII basename avoids shell metacharacters, path traversal and
  // filesystem byte-length limits. The original name stays in the page's queue.
  const name =
    item.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "image";
  return `2x3-${item.id}--${name}`;
}

const quote = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;

export function buildDownloadCommand(items) {
  const commands = items.map((item, index) => {
    const url = new URL(item.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("다운로드할 이미지 주소를 확인해 주세요.");
    url.hash = "";
    return `printf '%s\\n' ${quote(`${index + 1}/${items.length} 원본 받는 중`)}\ndownload_one ${quote(url.href)} ${quote(recoveryFilename(item))}`;
  });
  // No remote code, eval, credentials or intermediary server. Every URL is a
  // single-quoted argument; the browser never reads the downloaded files.
  return `/bin/bash <<'IMAGES_2X3_DOWNLOAD'
/bin/mkdir -p "$HOME/Downloads" || exit 1
download_dir="$(/usr/bin/mktemp -d "$HOME/Downloads/2x3-originals.XXXXXX")" || exit 1
download_ok=0
download_failed=0
download_one() {
  if /usr/bin/curl --fail --silent --show-error --location --globoff \\
    --proto '=http,https' --proto-redir '=http,https' \\
    --connect-timeout 30 --retry 2 \\
    --output "$download_dir/$2.part" --url "$1" && \\
    /bin/mv "$download_dir/$2.part" "$download_dir/$2"; then
    download_ok=$((download_ok + 1))
  else
    download_failed=$((download_failed + 1))
    /bin/rm -f "$download_dir/$2.part"
  fi
}
${commands.join("\n")}
printf '\\n완료 %s개 / 실패 %s개\\n저장 위치: %s\\n' "$download_ok" "$download_failed" "$download_dir"
printf '%s\\n' '웹페이지로 돌아가 이 폴더의 파일들을 한 번에 첨부해 주세요. 파일 이름은 바꾸지 않아도 됩니다.'
[ "$download_failed" -eq 0 ]
IMAGES_2X3_DOWNLOAD`;
}
