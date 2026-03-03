import { generateAudioFromText } from './audioEngine.js';
import { saveProgress, loadProgress } from './storage.js';

const textInput = document.getElementById("textInput");
const generateBtn = document.getElementById("generateBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const audioPlayer = document.getElementById("audioPlayer");
const fileInput = document.getElementById("fileInput");
const modeSelect = document.getElementById("modeSelect");
const statusText = document.getElementById("statusText");
const speedSelect = document.getElementById("speedSelect");
const voiceSelect = document.getElementById("voiceSelect");
const urlInput = document.getElementById("urlInput");
const fetchUrlBtn = document.getElementById("fetchUrlBtn");

const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");

let chunks = [];
let currentIndex = 0;
let isAutoPlaying = false;

/** ✅ 新增：用于“可中断生成”的控制 */
let currentAbort = null;     // AbortController
let currentJobId = 0;        // 每次点击生成+1，旧任务结果全部作废
let currentAudioUrl = null;  // 释放 objectURL，避免内存泄漏

function setStatus(text, type = "info", opts = {}) {
  if (!statusText) return;

  statusText.innerText = text;

  statusText.classList.remove("ok", "bad", "info");
  if (type === "ok") statusText.classList.add("ok");
  else if (type === "bad") statusText.classList.add("bad");
  else statusText.classList.add("info");

  // ✅ 改：不再用 busy 锁死“生成并播放”
  // 生成按钮永远可点，用来“打断并重来”
  if (generateBtn && typeof opts.busy === "boolean") {
    generateBtn.disabled = false;
  }

  if (progressBar && opts.total != null) {
    progressBar.max = opts.total;
    progressBar.value = opts.step ?? 0;
  }
  if (progressLabel && opts.total != null) {
    progressLabel.innerText = `${opts.step ?? 0}/${opts.total}`;
  }
}

// ✅ 稳定分段（保留你原来的）
function splitTextIntoChunks(text, opts = {}) {
  const { maxLen = 2200, minLen = 800 } = opts;

  const cleaned = (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (!cleaned) return [];

  if (cleaned.length <= maxLen) return [cleaned];

  const paragraphs = cleaned.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  const chunks = [];
  let buf = "";

  const pushBuf = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const p of paragraphs) {
    if (p.length > maxLen) {
      pushBuf();

      const sentences = p
        .split(/(?<=[。！？!?；;。\.])\s+/)
        .map(s => s.trim())
        .filter(Boolean);

      let sbuf = "";
      for (const s of sentences) {
        if ((sbuf + " " + s).trim().length <= maxLen) {
          sbuf = (sbuf ? sbuf + " " : "") + s;
        } else {
          if (sbuf) chunks.push(sbuf.trim());
          if (s.length > maxLen) {
            for (let i = 0; i < s.length; i += maxLen) {
              const cut = s.slice(i, i + maxLen).trim();
              if (cut) chunks.push(cut);
            }
            sbuf = "";
          } else {
            sbuf = s;
          }
        }
      }
      if (sbuf) chunks.push(sbuf.trim());
      continue;
    }

    const candidate = buf ? (buf + "\n\n" + p) : p;
    if (candidate.length <= maxLen) {
      buf = candidate;
    } else {
      pushBuf();
      buf = p;
    }
  }
  pushBuf();

  for (let i = chunks.length - 1; i > 0; i--) {
    if (chunks[i].length < minLen) {
      const merged = chunks[i - 1] + "\n\n" + chunks[i];
      if (merged.length <= maxLen) {
        chunks[i - 1] = merged;
        chunks.splice(i, 1);
      }
    }
  }

  return chunks;
}

/** ✅ 新增：立刻停止当前播放/队列/网络请求，并清理资源 */
function interruptPlayback(reason = "") {
  isAutoPlaying = false;

  // 取消正在进行的 TTS 请求
  if (currentAbort) {
    try { currentAbort.abort(); } catch {}
    currentAbort = null;
  }

  // 停止 audio
  if (audioPlayer) {
    audioPlayer.pause();
    // 重置 src 可以立刻打断
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }

  // 释放上一次生成的 objectURL，避免越用越占内存
  if (currentAudioUrl) {
    try { URL.revokeObjectURL(currentAudioUrl); } catch {}
    currentAudioUrl = null;
  }

  if (reason) setStatus(reason, "info", { busy: false });
}

/** ✅ 改造：playChunk 支持“可取消” + “旧任务作废” */
async function playChunk(index, jobId) {
  const mode = modeSelect?.value || "original";
  const total = chunks.length;
  const voice = voiceSelect?.value || "young_female";

  setStatus(`正在生成第 ${index + 1}/${total} 段...`, "info", {
    busy: true,
    step: index + 1,
    total
  });

  // 每次生成都用新的 AbortController
  const abort = new AbortController();
  currentAbort = abort;

  // ✅ 关键：把 signal 传进去（需要配合 audioEngine.js 的小改动，见后面）
  const audioUrl = await generateAudioFromText(
    chunks[index],
    mode,
    voice,
    abort.signal
  );

  // 如果点击了新一轮“生成并播放”，旧结果直接丢弃
  if (jobId !== currentJobId) return;

  if (!audioUrl) throw new Error("audioUrl is null (TTS failed)");

  // 清理旧的 objectURL
  if (currentAudioUrl) {
    try { URL.revokeObjectURL(currentAudioUrl); } catch {}
  }
  currentAudioUrl = audioUrl;

  audioPlayer.src = audioUrl;
  audioPlayer.playbackRate = parseFloat(speedSelect?.value || "1");

  setStatus(`播放第 ${index + 1}/${total} 段（${mode} / ${voice}）`, "ok", {
    busy: true,
    step: index + 1,
    total
  });

  await audioPlayer.play();
}

// 上传文件（保留你的逻辑，只加：选择文件时打断播放）
fileInput?.addEventListener("change", async function () {
  const file = fileInput.files[0];
  if (!file) return;

  interruptPlayback("已切换文件，停止当前播放");

  if (file.name.endsWith(".txt")) {
    const reader = new FileReader();
    reader.onload = function (e) {
      textInput.value = e.target.result;
      setStatus("TXT 已载入 ✅", "ok");
    };
    reader.readAsText(file);
    return;
  }

  if (file.name.endsWith(".pdf")) {
    const formData = new FormData();
    formData.append("file", file);

    setStatus("正在解析 PDF...", "info", { busy: true });

    try {
      const response = await fetch("/upload-pdf", {
        method: "POST",
        body: formData
      });

      const data = await response.json();
      textInput.value = data.text || "";

      setStatus("PDF 已载入 ✅", "ok", { busy: false });
    } catch (error) {
      console.error(error);
      setStatus("PDF 文件读取失败 ❌", "bad", { busy: false });
    }
    return;
  }

  if (file.name.endsWith(".docx")) {
    const formData = new FormData();
    formData.append("file", file);

    setStatus("正在解析 Word...", "info", { busy: true });

    try {
      const response = await fetch("/upload-word", {
        method: "POST",
        body: formData
      });

      const data = await response.json();
      textInput.value = data.text || "";
      setStatus("Word 已载入 ✅", "ok", { busy: false });
    } catch (error) {
      console.error(error);
      setStatus("Word 文件读取失败 ❌", "bad", { busy: false });
    }
    return;
  }

  setStatus("暂不支持该文件类型", "bad", { busy: false });
});

// ✅ 生成音频（可随时打断）
generateBtn?.addEventListener("click", async function () {
  const text = textInput.value;
  if (!text) {
    alert("请输入文字");
    return;
  }

  // 1) 立刻打断上一轮
  interruptPlayback("已打断，按当前设置重新生成…");

  // 2) 新开一轮任务 id
  currentJobId += 1;
  const jobId = currentJobId;

  chunks = splitTextIntoChunks(text, { maxLen: 2200, minLen: 800 });
  currentIndex = 0;
  isAutoPlaying = true;

  if (chunks.length === 0) {
    alert("没有可朗读内容");
    isAutoPlaying = false;
    return;
  }

  try {
    await playChunk(currentIndex, jobId);
  } catch (error) {
    // 如果是 abort 导致的错误，不算失败
    if (error?.name === "AbortError" || String(error?.message || "").includes("aborted")) {
      return;
    }
    console.error(error);
    setStatus("生成/播放失败 ❌", "bad", { busy: false });
    isAutoPlaying = false;
  }
});

// 播放/暂停（保持）
playBtn?.addEventListener("click", function () {
  audioPlayer.play();
});
pauseBtn?.addEventListener("click", function () {
  audioPlayer.pause();
});

// 自动保存播放进度（保持）
audioPlayer?.addEventListener("timeupdate", function () {
  saveProgress(audioPlayer.currentTime);
});

// 页面加载时恢复播放进度（保持）
window.addEventListener("load", function () {
  const savedTime = loadProgress();
  if (savedTime) audioPlayer.currentTime = savedTime;
});

// ✅ 语速：立刻生效（保持）
speedSelect?.addEventListener("change", function () {
  audioPlayer.playbackRate = parseFloat(speedSelect.value);
});

// ✅ 自动播放下一段：带 jobId 防止串线
audioPlayer?.addEventListener("ended", async function () {
  if (!isAutoPlaying) return;

  currentIndex += 1;
  if (currentIndex >= chunks.length) {
    setStatus("全部播放完成 ✅", "ok", {
      busy: false,
      step: chunks.length,
      total: chunks.length
    });
    isAutoPlaying = false;
    return;
  }

  const jobId = currentJobId;
  try {
    await playChunk(currentIndex, jobId);
  } catch (e) {
    if (e?.name === "AbortError" || String(e?.message || "").includes("aborted")) return;
    console.error(e);
    setStatus("下一段生成失败 ❌（已停止）", "bad", { busy: false });
    isAutoPlaying = false;
  }
});

// 读取链接：开始抓取前也打断播放（只加一行 interrupt）
if (fetchUrlBtn) {
  fetchUrlBtn.addEventListener("click", async function () {
    if (!urlInput) {
      alert("urlInput 没找到：请检查 HTML 里是否有 id=urlInput");
      return;
    }
    const url = urlInput.value;
    if (!url) {
      alert("请输入链接");
      return;
    }

    interruptPlayback("正在抓取网页内容，已停止当前播放");

    setStatus("正在抓取网页内容...", "info", { busy: true });

    try {
      const response = await fetch("/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });

      const data = await response.json();
      textInput.value = data.text || "";

      setStatus("抓取成功 ✅", "ok", { busy: false });
    } catch (error) {
      console.error(error);
      setStatus("抓取失败 ❌", "bad", { busy: false });
    }
  });
}