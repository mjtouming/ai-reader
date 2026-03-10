import { generateAudioFromText } from './audioEngine.js?v=20260310-2';
import { saveProgress, loadProgress } from './storage.js';

const textInput = document.getElementById("textInput");
const generateBtn = document.getElementById("generateBtn");
const audioPlayer = document.getElementById("audioPlayer");
const fileInput = document.getElementById("fileInput");
const modeSelect = document.getElementById("modeSelect");
const statusText = document.getElementById("statusText");
const speedSelect = document.getElementById("speedSelect");
const voiceSelect = document.getElementById("voiceSelect");
modeSelect.addEventListener("change", () => {

  if (modeSelect.value === "original") {
    voiceSelect.value = "young_female";
  }

  if (modeSelect.value === "story") {
    voiceSelect.value = "elder_male";
  }

});
const urlInput = document.getElementById("urlInput");
const fetchUrlBtn = document.getElementById("fetchUrlBtn");

const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const sleepTimer = document.getElementById("sleepTimer");

let chunks = [];
let rewrittenChunks = [];
let currentIndex = 0;
let isAutoPlaying = false;
let sleepTimerId = null;
let sleepMode = null;
let restoreTime = 0;

let currentAbort = null;
let currentJobId = 0;
let currentAudioUrl = null;
let nextAudioUrl = null;
let nextAbort = null;
let nextNextAudioUrl = null;
let preGeneratingIndex = -1;
const SESSION_KEY = "ai_reader_session_v1";

function saveSession(patch = {}) {
  try {
    const prev = loadSession() || {};

    const data = {
      ...prev,
      text: textInput?.value || "",
      chunks,
      currentIndex,
      currentTime: audioPlayer?.currentTime || 0,
      mode: modeSelect?.value || "original",
      voice: voiceSelect?.value || "young_female",
      speed: speedSelect?.value || "1",
      ...patch,
      updatedAt: Date.now()
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch (e) {
    console.log("saveSession error:", e);
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStatus(text, type = "info", opts = {}) {
  if (!statusText) return;

  statusText.innerText = text;

  statusText.classList.remove("ok", "bad", "info");
  if (type === "ok") statusText.classList.add("ok");
  else if (type === "bad") statusText.classList.add("bad");
  else statusText.classList.add("info");

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

function cleanBookTextForReading(rawText) {
  const text = (rawText || "").replace(/\r/g, "").trim();
  if (!text) return "";

  const MAX_HEAD_LINES = 220;
  const lines = text.split("\n");

  const head = lines.slice(0, MAX_HEAD_LINES);
  const tail = lines.slice(MAX_HEAD_LINES);

  const metaLineRe = new RegExp(
    [
      "^\\s*(作者|编者|译者|校注|整理|出品|出版|出版社|出版方|出品方|责任编辑|责任编辑|策划|监制)\\s*[:：].*$",
      "^\\s*(ISBN|书号|CIP|版次|印次|定价|字数|开本|装帧|页数|印刷|印刷厂|发行|网址|邮箱|电话)\\s*[:：].*$",
      "^\\s*(版权|版权声明|版权所有|著作权|免责声明|前言|序言|引言|推荐序|出版说明|再版说明)\\s*$",
      "^\\s*©\\s*\\d{4}.*$",
      "^\\s*All\\s+rights\\s+reserved\\s*.*$"
    ].join("|"),
    "i"
  );

  const tocLineRe = new RegExp(
    [
      "^\\s*(目录|目\\s*录|contents)\\s*$",
      "^\\s*第\\s*[零一二三四五六七八九十百千万0-9]+\\s*(章|回|节|卷|篇|部)\\b.*$",
      "^\\s*第\\s*[零一二三四五六七八九十百千万0-9]+\\s*(章|回)\\s*$",
      "^\\s*(Chapter|CHAPTER)\\s*\\d+\\b.*$",
      "^\\s*\\d+\\s*[\\.、]\\s*.+$",
      "^\\s*(楔子|序章|终章|后记|番外|引子)\\s*$"
    ].join("|"),
    "i"
  );

  let cleanedHead = [];
  for (let i = 0; i < head.length; i++) {
    const line = head[i].trim();
    if (!line) {
      cleanedHead.push("");
      continue;
    }
    if (metaLineRe.test(line)) continue;
    cleanedHead.push(head[i]);
  }

  const WINDOW = 18;
  let cutStart = -1;
  let cutEnd = -1;

  const headLines = cleanedHead;
  const SEARCH_LIMIT = Math.min(120, headLines.length);

  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const t = (headLines[i] || "").trim();
    if (/^(目录|目\s*录|contents)\s*$/i.test(t)) {
      cutStart = i;
      break;
    }
  }

  if (cutStart === -1) {
    const DENSE_LIMIT = Math.min(80, headLines.length);
    for (let i = 0; i < DENSE_LIMIT; i++) {
      const end = Math.min(i + WINDOW, headLines.length);
      const slice = headLines.slice(i, end);

      let hit = 0;
      let nonEmpty = 0;

      for (const s of slice) {
        const line = (s || "").trim();
        if (!line) continue;
        nonEmpty++;
        if (tocLineRe.test(line)) hit++;
      }

      if (nonEmpty >= 8 && hit >= 6 && hit / nonEmpty >= 0.6) {
        cutStart = i;
        break;
      }
    }
  }

  if (cutStart !== -1) {
    let i = cutStart;
    let looseCount = 0;

    for (; i < headLines.length; i++) {
      const line = (headLines[i] || "").trim();

      if (!line) continue;

      if (tocLineRe.test(line) || /^(目录|目\s*录|contents)\s*$/i.test(line)) {
        looseCount = 0;
        continue;
      } else {
        looseCount++;
        if (looseCount >= 3) {
          cutEnd = i;
          break;
        }
      }
    }

    if (cutEnd === -1) cutEnd = headLines.length;

    const kept = headLines.slice(0, cutStart).concat(headLines.slice(cutEnd));
    cleanedHead = kept;
  }

  const merged = cleanedHead.concat(tail).join("\n");

  return merged
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function interruptPlayback(reason = "") {
  isAutoPlaying = false;

  if (currentAbort) {
    try { currentAbort.abort(); } catch {}
    currentAbort = null;
  }

  if (nextAbort) {
    try { nextAbort.abort(); } catch {}
    nextAbort = null;
  }
  preGeneratingIndex = -1;

  if (nextAudioUrl) {
    try { URL.revokeObjectURL(nextAudioUrl); } catch {}
  }
  nextAudioUrl = null;

  if (typeof nextNextAudioUrl !== "undefined" && nextNextAudioUrl) {
    try { URL.revokeObjectURL(nextNextAudioUrl); } catch {}
  }
  nextNextAudioUrl = null;

  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }

  if (currentAudioUrl) {
    try { URL.revokeObjectURL(currentAudioUrl); } catch {}
    currentAudioUrl = null;
  }

  if (reason) setStatus(reason, "info", { busy: false });
}

async function playChunk(index, jobId) {
  const mode = modeSelect?.value || "original";
  const total = chunks.length;
  const voice = voiceSelect?.value || "young_female";

  setStatus(`正在生成第 ${index + 1}/${total} 段...`, "info", {
    busy: true,
    step: index + 1,
    total
  });

  const abort = new AbortController();
  currentAbort = abort;

  let result;

  try {
    const textToSend = rewrittenChunks[index] || chunks[index];

    result = await generateAudioFromText(
      textToSend,
      mode,
      voice,
      abort.signal,
      rewrittenChunks[index - 1] || null,
      index + 1,
      chunks.length
    );
  } catch (e) {
    if (e?.name === "AbortError") {
      console.log("生成被取消");
      return;
    }
    throw e;
  }

  const audioUrl = result.url;
  const rewrittenText = result.rewritten;

  if (jobId !== currentJobId) return;

  if (!audioUrl) throw new Error("audioUrl is null (TTS failed)");
  if (!rewrittenChunks[index] && rewrittenText) {
    rewrittenChunks[index] = rewrittenText;
  }

  if (currentAudioUrl) {
    try { URL.revokeObjectURL(currentAudioUrl); } catch {}
  }
  currentAudioUrl = audioUrl;

  audioPlayer.src = audioUrl;
  audioPlayer.currentTime = 0;
  audioPlayer.playbackRate = parseFloat(speedSelect?.value || "1");

  if (restoreTime > 0) {
    audioPlayer.addEventListener("loadedmetadata", () => {
      try {
        audioPlayer.currentTime = restoreTime;
        restoreTime = 0;
      } catch {}
    }, { once: true });
  }

  setStatus(`播放第 ${index + 1}/${total} 段（${mode} / ${voice}）`, "ok", {
    busy: true,
    step: index + 1,
    total
  });

  try {
    preGenerateNext(index + 1, jobId);
    await audioPlayer.play();
  } catch (e) {
    console.log("play() 被浏览器拒绝或异常:", e);
    if (!audioPlayer.paused) {
      console.log("实际已播放，忽略错误");
      return;
    }
    throw e;
  }
}

async function preGenerateNext(index, jobId) {
  if (index >= chunks.length) return;
  if (preGeneratingIndex === index) return;
  preGeneratingIndex = index;
  const mode = modeSelect?.value || "original";
  const voice = voiceSelect?.value || "young_female";

  const abort = new AbortController();
  nextAbort = abort;

  try {
    const textToSend = rewrittenChunks[index] || chunks[index];

    const result = await generateAudioFromText(
      textToSend,
      mode,
      voice,
      abort.signal,
      rewrittenChunks[index - 1] || null,
      index + 1,
      chunks.length
    );

    const url = result.url;
    const rewrittenText = result.rewritten;

    if (!rewrittenChunks[index] && rewrittenText) {
      rewrittenChunks[index] = rewrittenText;
    }

    if (jobId !== currentJobId) return;

    if (!nextAudioUrl) {
      if (jobId !== currentJobId) return;
      nextAudioUrl = url;
      preGenerateNext(index + 1, jobId);
      return;
    }

    if (!nextNextAudioUrl) {
      if (jobId !== currentJobId) return;
      nextNextAudioUrl = url;
      setTimeout(() => {
        preGenerateNext(index + 1, jobId);
      }, 100);
      return;
    }

  } catch (e) {
    if (e?.name === "AbortError") return;
  }
}

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
  let text = textInput.value.trim();
  if (!text) {
    alert("请输入文字");
    return;
  }

  // ✅ 识别 YouTube 链接，自动提取字幕
  const isYouTube = /youtube\.com\/watch|youtu\.be\//.test(text);
  if (isYouTube) {
    setStatus("正在提取 YouTube 字幕...", "info", { busy: true });
    try {
      const response = await fetch("/fetch-youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: text })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "失败");
      textInput.value = data.text || "";
      text = textInput.value;
      modeSelect.value = "translate";
      voiceSelect.value = "young_female";
      setStatus("字幕已提取，准备生成...", "info");
    } catch (error) {
      console.error(error);
      setStatus("YouTube 字幕提取失败 ❌：" + error.message, "bad", { busy: false });
      return;
    }
  }

  // ✅ 分段前清理电子书开头目录/元信息
  const cleaned = cleanBookTextForReading(text);
  if (cleaned && cleaned.trim().length > 0) {
    text = cleaned;
    textInput.value = cleaned;
  }

  // 1) 立刻打断上一轮
  interruptPlayback("已打断，按当前设置重新生成…");

  // 2) 新开一轮任务 id
  currentJobId += 1;
  const jobId = currentJobId;

  // 加速启动：第一段切小
  const firstParts = splitTextIntoChunks(text, { maxLen: 420, minLen: 200 });

  if (firstParts.length > 1) {
    const first = firstParts.shift();
    const restText = firstParts.join("\n\n");
    const restParts = splitTextIntoChunks(restText, { maxLen: 2200, minLen: 800 });
    chunks = [first, ...restParts];
  } else {
    chunks = firstParts;
  }

  currentIndex = 0;
  rewrittenChunks = [];

  saveSession({ chunks, currentIndex });

  isAutoPlaying = true;

  if (chunks.length === 0) {
    alert("没有可朗读内容");
    isAutoPlaying = false;
    return;
  }

  try {
    await playChunk(currentIndex, jobId);
  } catch (error) {
    if (error?.name === "AbortError" || String(error?.message || "").includes("aborted")) {
      return;
    }
    console.error(error);
    setStatus("生成/播放失败 ❌", "bad", { busy: false });
    isAutoPlaying = false;
  }
});

const playPauseBtn = document.getElementById("playPauseBtn");

playPauseBtn?.addEventListener("click", async function () {

  if (!audioPlayer.src && chunks.length > 0) {
    try {
      isAutoPlaying = true;
      currentJobId += 1;
      const jobId = currentJobId;
      await playChunk(currentIndex, jobId);
      playPauseBtn.innerText = "⏸ 暂停";
    } catch (e) {
      console.error("恢复播放失败:", e);
      setStatus("恢复播放失败 ❌", "bad");
    }
    return;
  }

  if (audioPlayer.paused) {
    try {
      await audioPlayer.play();
      playPauseBtn.innerText = "⏸ 暂停";
    } catch (e) {
      console.log("播放失败:", e);
    }
  } else {
    audioPlayer.pause();
    playPauseBtn.innerText = "▶️ 播放";
  }

});

let lastSessionSave = 0;

audioPlayer?.addEventListener("timeupdate", function () {

  if (sleepTargetTime && Date.now() >= sleepTargetTime) {
    interruptPlayback("定时关闭");
    sleepTargetTime = null;
    return;
  }

  saveProgress(audioPlayer.currentTime);

  const now = Date.now();
  if (now - lastSessionSave > 2000) {
    saveSession();
    lastSessionSave = now;
  }

});

audioPlayer?.addEventListener("play", () => {
  if (playPauseBtn) playPauseBtn.innerText = "⏸ 暂停";
});

audioPlayer?.addEventListener("pause", () => {
  if (playPauseBtn) playPauseBtn.innerText = "▶️ 播放";
});

window.addEventListener("load", function () {

  const session = loadSession();
  if (!session) return;

  try {
    textInput.value = session.text || "";
    chunks = session.chunks || [];
    currentIndex = session.currentIndex || 0;
    modeSelect.value = session.mode || "original";
    voiceSelect.value = session.voice || "young_female";
    speedSelect.value = session.speed || "1";

    if (session.currentTime != null) {
      restoreTime = session.currentTime;
    }

    if (chunks.length > 0) {
      isAutoPlaying = false;
      setStatus(
        `已恢复上次进度：第 ${currentIndex + 1}/${chunks.length} 段`,
        "ok",
        {
          step: currentIndex,
          total: chunks.length
        }
      );
    }
  } catch (e) {
    console.log("恢复 session 失败", e);
  }

});

speedSelect?.addEventListener("change", function () {
  audioPlayer.playbackRate = parseFloat(speedSelect.value);
});

audioPlayer?.addEventListener("ended", async function () {

  if (sleepMode === "end") {
    interruptPlayback("定时关闭（本段结束）");
    sleepMode = null;
    return;
  }

  if (!isAutoPlaying) return;

  currentIndex += 1;

  saveSession({ currentIndex });

  if (nextAudioUrl) {
    const url = nextAudioUrl;

    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
    }

    nextAudioUrl = nextNextAudioUrl;
    nextNextAudioUrl = null;
    currentAudioUrl = url;

    audioPlayer.src = url;
    audioPlayer.currentTime = 0;
    audioPlayer.playbackRate = parseFloat(speedSelect?.value || "1");

    if (restoreTime > 0) {
      audioPlayer.addEventListener("loadedmetadata", () => {
        try {
          audioPlayer.currentTime = restoreTime;
          restoreTime = 0;
        } catch {}
      }, { once: true });
    }

    setStatus(`播放第 ${currentIndex + 1}/${chunks.length} 段`, "ok", {
      busy: true,
      step: currentIndex + 1,
      total: chunks.length
    });

    await audioPlayer.play();

    const startIdx = nextAudioUrl ? (currentIndex + 2) : (currentIndex + 1);
    preGenerateNext(startIdx, currentJobId);

    return;
  }

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

window.addEventListener("DOMContentLoaded", () => {
  const hasVisited = localStorage.getItem("ai_reader_visited");

  if (!hasVisited) {
    const defaultText = `
臣亮言：先帝创业未半而中道崩殂。今天下三分，益州疲弊，此诚危急存亡之秋也。
然侍卫之臣不懈于内，忠志之士忘身于外者，盖追先帝之殊遇，欲报之于陛下也。
诚宜开张圣听，以光先帝遗德，恢弘志士之气，不宜妄自菲薄，引喻失义，以塞忠谏之路也。
`;

    textInput.value = defaultText.trim();
    modeSelect.value = "story";
    voiceSelect.value = "elder_male";

    setTimeout(async () => {
      try {
        await generateBtn.click();
        setStatus("已生成，点击播放 ▶️", "ok");
      } catch (e) {
        console.log("首次自动生成失败:", e);
      }
    }, 800);

    localStorage.setItem("ai_reader_visited", "1");

  } else {
    modeSelect.value = "original";
    voiceSelect.value = "young_female";
  }
});

let sleepTargetTime = null;

sleepTimer?.addEventListener("change", function () {

  const value = sleepTimer.value;

  sleepMode = null;
  sleepTargetTime = null;

  if (value === "0") {
    setStatus("定时关闭已取消", "info");
    return;
  }

  if (value === "end") {
    sleepMode = "end";
    setStatus("将在本段播放完后关闭", "info");
    return;
  }

  const seconds = parseInt(value);
  sleepTargetTime = Date.now() + seconds * 1000;
  setStatus(`已设置 ${seconds / 60} 分钟后关闭`, "info");

});