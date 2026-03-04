export function saveProgress(time) {
  localStorage.setItem("audioProgress", time);
}

export function loadProgress() {
  return localStorage.getItem("audioProgress");
}