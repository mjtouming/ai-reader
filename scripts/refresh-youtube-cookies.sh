#!/usr/bin/env bash
set -euo pipefail

TEST_URL="${1:-https://youtu.be/5w4mYeWGVc8?is=Py9EoEcntmp2Ai4U}"
REMOTE="${REMOTE:-mj}"
REMOTE_COOKIE_PATH="${REMOTE_COOKIE_PATH:-/root/ai-reader/cookies.txt}"
YTDLP_URL="${YTDLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos}"

find_yt_dlp() {
  if [[ -n "${YTDLP_BIN:-}" && -x "${YTDLP_BIN}" ]]; then
    printf '%s\n' "${YTDLP_BIN}"
    return
  fi

  if command -v yt-dlp >/dev/null 2>&1; then
    command -v yt-dlp
    return
  fi

  if [[ -x /tmp/yt-dlp ]]; then
    printf '%s\n' /tmp/yt-dlp
    return
  fi

  echo "本机没有 yt-dlp，正在临时下载到 /tmp/yt-dlp ..."
  curl -L "${YTDLP_URL}" -o /tmp/yt-dlp
  chmod +x /tmp/yt-dlp
  printf '%s\n' /tmp/yt-dlp
}

YTDLP="$(find_yt_dlp)"
COOKIE_FILE="$(mktemp -u /tmp/youtube_cookies.XXXXXX)"
trap 'rm -f "${COOKIE_FILE}"' EXIT

echo "使用 yt-dlp: ${YTDLP}"
echo "从本机 Chrome 导出 cookies，并用测试链接验证 ..."
"${YTDLP}" \
  --cookies-from-browser chrome \
  --cookies "${COOKIE_FILE}" \
  --list-subs "${TEST_URL}" >/tmp/youtube_cookies_local_check.log

if ! sed -n '1p' "${COOKIE_FILE}" | grep -q 'Netscape HTTP Cookie File'; then
  echo "导出的 cookies 不是 Netscape 格式，已停止。"
  exit 1
fi

echo "本机验证通过，上传到 ${REMOTE}:${REMOTE_COOKIE_PATH} ..."
scp "${COOKIE_FILE}" "${REMOTE}:${REMOTE_COOKIE_PATH}"

echo "VPS 验证 cookies ..."
ssh "${REMOTE}" "yt-dlp --cookies '${REMOTE_COOKIE_PATH}' --list-subs '${TEST_URL}'" >/tmp/youtube_cookies_remote_check.log

echo "验证摘要："
grep -E 'Available automatic captions|Available subtitles|English|Chinese|has no subtitles' /tmp/youtube_cookies_remote_check.log || true
echo "完成：VPS cookies 已刷新。"
