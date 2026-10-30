export function listeningProgress(total, index, currentTime, duration) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const position = Number.isFinite(index) ? Math.max(0, Math.min(index, count)) : 0;
  const fraction = Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime)
    ? Math.max(0, Math.min(1, currentTime / duration))
    : 0;
  const ratio = count ? Math.min(1, (position + fraction) / count) : 0;
  return { fraction, ratio, percent: Math.round(ratio * 100), continuous: count > 40 };
}

export function formatPlaybackTime(seconds, padMinutes = false) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = String(Math.floor(safeSeconds / 60));
  return `${padMinutes ? minutes.padStart(2, "0") : minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}
