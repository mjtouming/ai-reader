import { generateAudioFromText } from './audioEngine.js?v=20260312-18';
import { saveProgress, loadProgress } from './storage.js';

// ── DOM refs ──────────────────────────────────────────────────
const textInput   = document.getElementById("textInput");
const generateBtn = document.getElementById("generateBtn");
const audioPlayer = document.getElementById("audioPlayer");
const fileInput   = document.getElementById("fileInput");
const modeSelect  = document.getElementById("modeSelect");
const statusText  = document.getElementById("statusText");
const speedSelect = document.getElementById("speedSelect");
const voiceSelect = document.getElementById("voiceSelect");
const urlInput    = document.getElementById("urlInput");
const fetchUrlBtn = document.getElementById("fetchUrlBtn");
const progressBar = document.getElementById("progressBar");
const chunkNav    = document.getElementById("chunkNav");
const sleepTimer  = document.getElementById("sleepTimer");

const VOICE_MANUAL_KEY = "ai_reader_voice_manual";

voiceSelect.addEventListener("change", () => {
  localStorage.setItem(VOICE_MANUAL_KEY, voiceSelect.value);
});

modeSelect.addEventListener("change", () => {
  const manualVoice = localStorage.getItem(VOICE_MANUAL_KEY);
  if (manualVoice) {
    voiceSelect.value = manualVoice;
  } else {
    if (modeSelect.value === "original") voiceSelect.value = "young_female";
    if (modeSelect.value === "story")    voiceSelect.value = "elder_male";
  }
});

// ── State ─────────────────────────────────────────────────────
let chunks           = [];
let rewrittenChunks  = [];
let currentIndex     = 0;
let maxReachedIndex  = -1;
let isAutoPlaying    = false;
let sleepMode        = null;
let sleepTargetTime  = null;
let restoreTime      = 0;
let currentAbort     = null;
let currentJobId     = 0;
let currentAudioUrl  = null;
let currentFileName  = null;
let audioCache       = {};   // index → url
let preGeneratingSet = new Set();
let preGenerateAbort = new AbortController();
const PRE_WINDOW     = 2;    // 预生成窗口大小
let lastSessionSave  = 0;

// ── Keys ──────────────────────────────────────────────────────
const SESSION_KEY = "ai_reader_session_v1";
const SHELF_KEY   = "ai_reader_shelf_v1";
let currentBookId = null;

// ── Session ───────────────────────────────────────────────────
function saveSession(patch = {}) {
  try {
    const prev = loadSession() || {};
    const data = {
      ...prev,
      text: textInput?.value || "",
      chunks,
      currentIndex,
      maxReachedIndex,
      currentTime: audioPlayer?.currentTime || 0,
      mode:  modeSelect?.value  || "original",
      voice: voiceSelect?.value || "young_female",
      speed: speedSelect?.value || "1",
      ...patch,
      updatedAt: Date.now()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    updateShelfProgress();
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

// ── 书架 (Shelf) ──────────────────────────────────────────────
function loadShelf() {
  try {
    const raw = localStorage.getItem(SHELF_KEY);
    return raw ? JSON.parse(raw) : { books: [], currentBookId: null };
  } catch { return { books: [], currentBookId: null }; }
}

function saveShelf(shelf) {
  try { localStorage.setItem(SHELF_KEY, JSON.stringify(shelf)); } catch {}
}

function hashText(text) {
  // djb2-like hash of first 500 chars for book identity
  let h = 5381;
  for (let i = 0; i < Math.min(text.length, 500); i++) {
    h = ((h << 5) + h) + text.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

function deriveTitle() {
  if (currentFileName) return currentFileName;
  const text = textInput?.value?.trim() || "";
  if (text.length > 0) {
    return text.slice(0, 10).replace(/\s+/g, "") + (text.length > 10 ? "…" : "");
  }
  const today = new Date().toISOString().slice(0, 10);
  return `未命名书籍 ${today}`;
}

function saveToShelf() {
  const text = textInput?.value?.trim() || "";
  if (!text || !chunks.length) return;

  const id    = hashText(text);
  const shelf = loadShelf();
  const existing = shelf.books.find(b => b.id === id);

  if (!existing && shelf.books.length >= 10) {
    alert("书架已满（最多 10 本），请打开书架删除旧书再继续");
    return;
  }

  const book = {
    id,
    title:       deriveTitle(),
    fileName:    currentFileName || null,
    text,
    totalChunks: chunks.length,
    currentIndex,
    maxReachedIndex,
    currentTime: audioPlayer?.currentTime || 0,
    mode:  modeSelect?.value  || "original",
    voice: voiceSelect?.value || "young_female",
    speed: speedSelect?.value || "1",
    addedAt:   existing?.addedAt || Date.now(),
    updatedAt: Date.now()
  };

  if (existing) {
    Object.assign(existing, book);
  } else {
    shelf.books.unshift(book);
  }

  currentBookId       = id;
  shelf.currentBookId = id;
  saveShelf(shelf);
}

function updateShelfProgress() {
  if (!currentBookId || !chunks.length) return;
  const shelf = loadShelf();
  const book  = shelf.books.find(b => b.id === currentBookId);
  if (!book) return;
  book.currentIndex    = currentIndex;
  book.maxReachedIndex = maxReachedIndex;
  book.currentTime     = audioPlayer?.currentTime || 0;
  book.totalChunks     = chunks.length;
  book.updatedAt       = Date.now();
  saveShelf(shelf);
}

function loadBook(book) {
  interruptPlayback();
  textInput.value   = book.text;
  modeSelect.value  = book.mode  || "original";
  voiceSelect.value = book.voice || "young_female";
  speedSelect.value = book.speed || "1";

  // Re-split with same algorithm as generateBtn
  const firstParts = splitTextIntoChunks(book.text, { maxLen: 420, minLen: 200 });
  if (firstParts.length > 1) {
    const first     = firstParts.shift();
    const restText  = firstParts.join("\n\n");
    const restParts = splitTextIntoChunks(restText, { maxLen: 2200, minLen: 800 });
    chunks = [first, ...restParts];
  } else {
    chunks = firstParts;
  }

  rewrittenChunks = [];
  currentIndex    = Math.min(book.currentIndex || 0, Math.max(0, chunks.length - 1));
  maxReachedIndex = book.maxReachedIndex ?? currentIndex;
  restoreTime     = book.currentTime || 0;
  currentBookId   = book.id;

  saveSession({ chunks, currentIndex, maxReachedIndex });
  renderChunkNav();
  updateNowPlayingTitle(book.title);
  const ppBtn = document.getElementById("playPauseBtn");
  if (ppBtn) ppBtn.innerText = "▶ 播放";
  setStatus(
    `已切换：${book.title}（第 ${currentIndex + 1}/${chunks.length} 段）`,
    "ok",
    { step: currentIndex + 1, total: chunks.length }
  );
}

function deleteBook(id) {
  const shelf = loadShelf();
  shelf.books = shelf.books.filter(b => b.id !== id);
  if (shelf.currentBookId === id) shelf.currentBookId = null;
  saveShelf(shelf);
  if (currentBookId === id) currentBookId = null;
}

function renderShelf() {
  const list = document.getElementById("bookList");
  if (!list) return;
  const shelf = loadShelf();

  if (!shelf.books.length) {
    list.innerHTML = '<div style="padding:28px 20px;color:rgba(15,23,42,.4);font-size:14px;text-align:center;">书架还是空的，添加第一本书吧 📖</div>';
    return;
  }

  list.innerHTML = "";
  shelf.books.forEach(book => {
    const item = document.createElement("div");
    item.className = "book-item" + (book.id === shelf.currentBookId ? " active" : "");

    const info = document.createElement("div");
    info.className = "book-info";

    const titleEl = document.createElement("div");
    titleEl.className = "book-title";
    titleEl.textContent = book.title;

    const progressEl = document.createElement("div");
    progressEl.className = "book-progress";
    const modeLabel = book.mode === "story" ? "故事" : book.mode === "translate" ? "翻译" : "原文";
    progressEl.textContent = `第 ${(book.currentIndex || 0) + 1}/${book.totalChunks || "?"} 段 · ${modeLabel}`;

    info.appendChild(titleEl);
    info.appendChild(progressEl);

    const del = document.createElement("button");
    del.className = "book-delete";
    del.textContent = "✕";
    del.title = "删除";
    del.addEventListener("click", e => {
      e.stopPropagation();
      if (confirm(`确定删除"${book.title}"？`)) {
        deleteBook(book.id);
        renderShelf();
      }
    });

    item.appendChild(info);
    item.appendChild(del);
    item.addEventListener("click", () => { loadBook(book); closeSheet(); });
    list.appendChild(item);
  });
}

function openSheet() {
  renderShelf();
  document.getElementById("sheetOverlay")?.classList.add("open");
  document.getElementById("sheetDrawer")?.classList.add("open");
}

function closeSheet() {
  document.getElementById("sheetOverlay")?.classList.remove("open");
  document.getElementById("sheetDrawer")?.classList.remove("open");
}

function clearForNewBook() {
  interruptPlayback("准备添加新书");
  textInput.value = "";
  chunks          = [];
  rewrittenChunks = [];
  currentIndex    = 0;
  maxReachedIndex = -1;
  currentBookId   = null;
  currentFileName = null;
  renderChunkNav();
  setStatus("请粘贴文字或上传文件", "info");
  closeSheet();
}

// ── 段落导航 ──────────────────────────────────────────────────
function renderChunkNav() {
  if (!chunkNav) return;
  if (!chunks.length) { chunkNav.innerHTML = ""; return; }

  const sel = document.createElement("select");
  sel.className = "chunk-select";

  for (let i = 0; i < chunks.length; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = i === currentIndex ? `▶ 第 ${i + 1} 段` : `第 ${i + 1} 段`;
    if (i === currentIndex)  opt.selected = true;
    sel.appendChild(opt);
  }

  sel.addEventListener("change", function () {
    const idx = parseInt(this.value, 10);
    if (!isNaN(idx) && idx !== currentIndex) jumpToChunk(idx);
  });

  chunkNav.innerHTML = "";
  chunkNav.appendChild(sel);
}

async function jumpToChunk(index) {
  interruptPlayback();
  currentIndex  = index;
  currentJobId += 1;
  const jobId   = currentJobId;
  isAutoPlaying = true;
  renderChunkNav();
  saveSession({ currentIndex });
  try {
    await playChunk(currentIndex, jobId);
  } catch (e) {
    if (e?.name === "AbortError") {
      isAutoPlaying = false;
      return;
    }
    setStatus("跳转失败 ❌", "bad", { busy: false });
    isAutoPlaying = false;
  }
}

// ── Now playing title ────────────────────────────────────────
function updateNowPlayingTitle(title) {
  const el = document.getElementById("nowPlayingTitle");
  if (!el) return;
  if (title) {
    // 超过5个字用滚动，否则静止
    const inner = document.createElement("span");
    inner.className = "marquee-inner";
    if (title.length > 5) {
      // 复制一份文字实现无缝循环
      inner.textContent = title + "　　" + title;
      inner.classList.add("scrolling");
    } else {
      inner.textContent = title;
    }
    el.innerHTML = "";
    el.appendChild(inner);
    el.classList.add("visible");
  } else {
    el.classList.remove("visible");
    setTimeout(() => { el.innerHTML = ""; }, 300);
  }
}

// ── UI helpers ────────────────────────────────────────────────
function setStatus(text, type = "info", opts = {}) {
  if (!statusText) return;

  statusText.classList.remove("ok", "bad", "info", "loading");

  if (opts.loading) {
    const wrap = document.createElement("span");
    wrap.className = "status-loading-wrap";

    const icon = document.createElement("span");
    icon.className = "loading-icon";
    icon.textContent = "❄";

    const textSpan = document.createElement("span");
    textSpan.className = "status-text";
    textSpan.textContent = text;

    wrap.appendChild(icon);
    wrap.appendChild(textSpan);
    statusText.innerHTML = "";
    statusText.appendChild(wrap);
    statusText.classList.add("info", "loading");
  } else {
    statusText.textContent = text;
    if (type === "ok")       statusText.classList.add("ok");
    else if (type === "bad") statusText.classList.add("bad");
    else                     statusText.classList.add("info");
  }

  if (generateBtn && typeof opts.busy === "boolean") {
    generateBtn.disabled = false;
  }
  if (progressBar && opts.total != null) {
    progressBar.max   = opts.total;
    progressBar.value = opts.step ?? 0;
  }
}

// ── Text processing ───────────────────────────────────────────
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

  const MAX_HEAD_LINES = 400;
  const lines = text.split("\n");

  const head = lines.slice(0, MAX_HEAD_LINES);
  const tail = lines.slice(MAX_HEAD_LINES);

  const metaLineRe = new RegExp(
    [
      "^\\s*(作者|编者|译者|校注|整理|出品|出版|出版社|出版方|出品方|责任编辑|责任编辑|策划|监制)\\s*[:：].*$",
      "^\\s*(ISBN|书号|CIP|版次|印次|定价|字数|开本|装帧|页数|印刷|印刷厂|发行|网址|邮箱|电话)\\s*[:：].*$",
      "^\\s*(版权|版权声明|版权所有|著作权|免责声明|前言|序言|引言|推荐序|出版说明|再版说明)\\s*$",
      "^\\s*©\\s*\\d{4}.*$",
      "^\\s*All\\s+rights\\s+reserved\\s*.*$",
      "^\\s*\\d{3}-\\d+-\\d+-\\d+-\\d+\\s*$",
      "^\\s*978[\\d\\-]+\\s*$",
      "^\\s*\\d{4}\\s*年.*(版|次|印).*$",
      "^\\s*\\d+\\s*mm\\s*[×x*]\\s*\\d+\\s*mm.*$",
      "^\\s*(北京|上海|广州|深圳|杭州|成都|武汉|南京|天津|西安).*(出版|书局|书店|文化|传媒|印刷).*$",
      "^\\s*(图书在版编目|CIP数据核字).*$",
      "^\\s*printed\\s+in\\s+.*$"
    ].join("|"),
    "i"
  );

  const tocLineRe = new RegExp(
    [
      "^\\s*(目录|目\\s*录|contents)\\s*$",
      "^\\s*第\\s*[零一二三四五六七八九十百千万0-9]+\\s*(章|回|节|卷|篇|部).*$",
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

  const WINDOW = 30;
  let cutStart = -1;
  let cutEnd = -1;

  const headLines = cleanedHead;
  const SEARCH_LIMIT = Math.min(300, headLines.length);

  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const t = (headLines[i] || "").trim();
    if (/^(目录|目\s*录|contents)\s*$/i.test(t)) {
      cutStart = i;
      break;
    }
  }

  if (cutStart === -1) {
    const DENSE_LIMIT = Math.min(200, headLines.length);
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
    // 从目录标题开始，跳过所有目录块（支持多个目录）
    // 遇到非章节行时重置计数，连续3行非章节才认为是真正正文
    let i = cutStart + 1;
    let nonTocCount = 0;
    let lastTocLine = cutStart;

    for (; i < headLines.length; i++) {
      const line = (headLines[i] || "").trim();
      if (!line) { nonTocCount = 0; continue; }

      if (tocLineRe.test(line) || /^(目录|目\s*录|contents)\s*$/i.test(line)) {
        lastTocLine = i;
        nonTocCount = 0;
      } else {
        nonTocCount++;
        if (nonTocCount >= 1) {
          cutEnd = i;
          break;
        }
      }
    }

    if (cutEnd === -1) cutEnd = lastTocLine + 1;

    const kept = headLines.slice(0, cutStart).concat(headLines.slice(cutEnd));
    cleanedHead = kept;
  }

  const merged = cleanedHead.concat(tail).join("\n");

  // 换行合并：段落内的单个换行合并掉，保留段落分隔
  const joined = merged.replace(/([^\n])\n([^\n])/g, "$1$2");

  return joined
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Playback core ─────────────────────────────────────────────
function interruptPlayback(reason = "") {
  isAutoPlaying = false;

  if (currentAbort) {
    try { currentAbort.abort(); } catch {}
    currentAbort = null;
  }

  // 取消所有预生成请求
  preGenerateAbort.abort();
  preGenerateAbort = new AbortController();
  // 清空预生成缓存
  for (const url of Object.values(audioCache)) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  audioCache = {};
  preGeneratingSet.clear();

  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }

  if (currentAudioUrl) {
    try { URL.revokeObjectURL(currentAudioUrl); } catch {}
    currentAudioUrl = null;
  }

  updateNowPlayingTitle(null);
  if (reason) setStatus(reason, "info", { busy: false });
}

async function playChunk(index, jobId) {
  const mode  = modeSelect?.value  || "original";
  const total = chunks.length;
  const voice = voiceSelect?.value || "young_female";

  setStatus(`正在生成第 ${index + 1}/${total} 段...`, "info", {
    busy: true,
    loading: true,
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
      chunks.length,
      index === 0  // 第一段跳过改写，直接 TTS
    );
  } catch (e) {
    if (e?.name === "AbortError") {
      console.log("生成被取消");
      return;
    }
    throw e;
  }

  const audioUrl      = result.url;
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

  // Update max reached and nav
  maxReachedIndex = Math.max(maxReachedIndex, index);
  renderChunkNav();

  updateNowPlayingTitle(currentFileName || (currentBookId && (() => { const s = loadShelf(); const b = s.books.find(x => x.id === currentBookId); return b?.title; })()) || deriveTitle());
  setStatus(`播放第 ${index + 1}/${total} 段`, "ok", {
    busy: true,
    step: index + 1,
    total
  });

  fillWindow(index, jobId);
  try {
    await audioPlayer.play();
  } catch (e) {
    console.log("play() 被浏览器拒绝或异常:", e);
    if (!audioPlayer.paused) {
      console.log("实际已播放，忽略错误");
      return;
    }
    // Safari 自动播放被拦截，提示用户手动点击
    setStatus("下一段生成失败 ❌（已停止）", "bad", { busy: false });
    isAutoPlaying = false;
    return;  // 不 throw，避免上层显示"跳转失败"
  }
}

// 填满预生成窗口
function fillWindow(fromIndex, jobId) {
  for (let i = fromIndex + 1; i <= fromIndex + PRE_WINDOW; i++) {
    if (i >= chunks.length) break;
    if (audioCache[i]) continue;
    if (preGeneratingSet.has(i)) continue;
    preGenerateNext(i, jobId);
  }
}

async function preGenerateNext(index, jobId) {
  if (index >= chunks.length) return;
  if (audioCache[index]) return;
  if (preGeneratingSet.has(index)) return;

  preGeneratingSet.add(index);

  const mode  = modeSelect?.value  || "original";
  const voice = voiceSelect?.value || "young_female";

  try {
    const textToSend = rewrittenChunks[index] || chunks[index];

    const result = await generateAudioFromText(
      textToSend,
      mode,
      voice,
      preGenerateAbort.signal,
      rewrittenChunks[index - 1] || null,
      index + 1,
      chunks.length
    );

    if (jobId !== currentJobId) {
      preGeneratingSet.delete(index);
      return;
    }

    const url           = result.url;
    const rewrittenText = result.rewritten;

    if (!rewrittenChunks[index] && rewrittenText) {
      rewrittenChunks[index] = rewrittenText;
    }

    audioCache[index] = url;
    preGeneratingSet.delete(index);

    // 生成完一段后继续填窗口
    fillWindow(currentIndex, jobId);

  } catch (e) {
    preGeneratingSet.delete(index);
    if (e?.name === "AbortError") return;
    console.log("preGenerateNext error:", e);
  }
}

// ── File upload ───────────────────────────────────────────────
fileInput?.addEventListener("change", async function () {
  const file = fileInput.files[0];
  if (!file) return;

  interruptPlayback("已切换文件，停止当前播放");

  if (file.name.endsWith(".txt")) {
    const reader = new FileReader();
    reader.onload = function (e) {
      textInput.value = e.target.result;
      currentFileName = file.name.replace(/\.[^.]+$/, "");
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
      if (!response.ok) {
        setStatus(data.error || "PDF 解析失败 ❌", "bad", { busy: false });
        return;
      }
      textInput.value = data.text || "";
      currentFileName = file.name.replace(/\.[^.]+$/, "");
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
      currentFileName = file.name.replace(/\.[^.]+$/, "");
      setStatus("Word 已载入 ✅", "ok", { busy: false });
    } catch (error) {
      console.error(error);
      setStatus("Word 文件读取失败 ❌", "bad", { busy: false });
    }
    return;
  }

  setStatus("暂不支持该文件类型", "bad", { busy: false });
});

// ── Generate ──────────────────────────────────────────────────
generateBtn?.addEventListener("click", async function () {
  let text = textInput.value.trim();
  if (!text) {
    alert("请输入文字");
    return;
  }

  // 识别 YouTube 链接，自动提取字幕
  const isYouTube = /youtube\.com\/(watch|live)|youtu\.be\//.test(text);
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
      modeSelect.value  = "translate";
      voiceSelect.value = "young_female";
      setStatus("字幕已提取，准备生成...", "info");
    } catch (error) {
      console.error(error);
      setStatus("YouTube 字幕提取失败 ❌：" + error.message, "bad", { busy: false });
      return;
    }
  }

  // 分段前清理电子书开头目录/元信息
  const cleaned = cleanBookTextForReading(text);
  if (cleaned && cleaned.trim().length > 0) {
    text = cleaned;
    textInput.value = cleaned;
  }

  // 1) 打断上一轮
  interruptPlayback("已打断，按当前设置重新生成…");

  // 2) 新任务 id
  currentJobId += 1;
  const jobId = currentJobId;

  // 加速启动：第一段切小
  const firstParts = splitTextIntoChunks(text, { maxLen: 420, minLen: 200 });

  if (firstParts.length > 1) {
    const first    = firstParts.shift();
    const restText = firstParts.join("\n\n");
    const restParts = splitTextIntoChunks(restText, { maxLen: 2200, minLen: 800 });
    chunks = [first, ...restParts];
  } else {
    chunks = firstParts;
  }

  currentIndex    = 0;
  maxReachedIndex = -1;
  rewrittenChunks = [];

  saveSession({ chunks, currentIndex, maxReachedIndex });
  saveToShelf();
  renderChunkNav();

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

// ── Play / Pause ──────────────────────────────────────────────
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
      isAutoPlaying = false;
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

// ── Audio events ──────────────────────────────────────────────
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

audioPlayer?.addEventListener("ended", async function () {

  if (sleepMode === "end") {
    interruptPlayback("定时关闭（本段结束）");
    sleepMode = null;
    return;
  }

  if (!isAutoPlaying) return;

  currentIndex += 1;
  saveSession({ currentIndex });

  if (audioCache[currentIndex]) {
    const url = audioCache[currentIndex];
    delete audioCache[currentIndex - 1];  // 释放已播放的

    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
    }

    currentAudioUrl = url;
    audioPlayer.src = url;
    audioPlayer.currentTime = 0;
    audioPlayer.playbackRate = parseFloat(speedSelect?.value || "1");

    maxReachedIndex = Math.max(maxReachedIndex, currentIndex);
    renderChunkNav();

    setStatus(`播放第 ${currentIndex + 1}/${chunks.length} 段`, "ok", {
      busy: true,
      step: currentIndex + 1,
      total: chunks.length
    });

    try {
      await audioPlayer.play();
    } catch (e) {
      console.log("audioCache play() 失败，重新生成:", e);
      // play() 失败时回退到 playChunk 重新尝试
      const jobId = currentJobId;
      try {
        await playChunk(currentIndex, jobId);
      } catch (e2) {
        if (e2?.name === "AbortError") return;
        setStatus("下一段生成失败 ❌（已停止）", "bad", { busy: false });
        isAutoPlaying = false;
      }
      return;
    }

    // 滑动窗口，继续填满
    fillWindow(currentIndex, currentJobId);

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
    if (e?.name === "NotAllowedError") {
      setStatus("已生成，点击 ▶ 继续播放", "ok", { busy: false });
    } else {
      setStatus("下一段生成失败 ❌（已停止）", "bad", { busy: false });
    }
    isAutoPlaying = false;
  }
});

// ── Session restore ───────────────────────────────────────────
window.addEventListener("load", function () {

  const session = loadSession();
  if (!session) return;

  try {
    textInput.value   = session.text || "";
    chunks            = session.chunks || [];
    currentIndex      = session.currentIndex || 0;
    maxReachedIndex   = session.maxReachedIndex ?? currentIndex;
    modeSelect.value  = session.mode  || "original";
    voiceSelect.value = session.voice || "young_female";
    speedSelect.value = session.speed || "1";

    if (session.currentTime != null) {
      restoreTime = session.currentTime;
    }

    // Restore current book id from shelf — 用文本 hash 匹配，避免 currentBookId 错位
    const shelf = loadShelf();
    const sessionText = session.text || "";
    const sessionHash = sessionText ? hashText(sessionText) : null;
    const matchedBook = sessionHash ? shelf.books.find(b => b.id === sessionHash) : null;
    currentBookId = matchedBook ? matchedBook.id : (shelf.currentBookId || null);
    // 同步修正 shelf.currentBookId
    if (matchedBook && shelf.currentBookId !== matchedBook.id) {
      shelf.currentBookId = matchedBook.id;
      saveShelf(shelf);
    }

    if (chunks.length > 0) {
      isAutoPlaying = false;
      renderChunkNav();
      // 恢复书名显示
      const bookForRestore = matchedBook || shelf.books.find(b => b.id === currentBookId);
      if (bookForRestore) updateNowPlayingTitle(bookForRestore.title);
      setStatus(
        `已恢复上次进度：第 ${currentIndex + 1}/${chunks.length} 段`,
        "ok",
        {
          step:  currentIndex,
          total: chunks.length
        }
      );
    }
  } catch (e) {
    console.log("恢复 session 失败", e);
  }

});

// ── Speed change ──────────────────────────────────────────────
speedSelect?.addEventListener("change", function () {
  audioPlayer.playbackRate = parseFloat(speedSelect.value);
});

// ── Sleep timer ───────────────────────────────────────────────
sleepTimer?.addEventListener("change", function () {

  const value = sleepTimer.value;

  sleepMode        = null;
  sleepTargetTime  = null;

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

// ── Shelf UI events ───────────────────────────────────────────
document.getElementById("shelfBtn")?.addEventListener("click", openSheet);
document.getElementById("sheetOverlay")?.addEventListener("click", closeSheet);
document.getElementById("addBookBtn")?.addEventListener("click", clearForNewBook);

// ── First visit ───────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const hasVisited = localStorage.getItem("ai_reader_visited");

  if (!hasVisited) {
    const defaultText = `
臣亮言：先帝创业未半而中道崩殂。今天下三分，益州疲弊，此诚危急存亡之秋也。
然侍卫之臣不懈于内，忠志之士忘身于外者，盖追先帝之殊遇，欲报之于陛下也。
诚宜开张圣听，以光先帝遗德，恢弘志士之气，不宜妄自菲薄，引喻失义，以塞忠谏之路也。
`;

    textInput.value   = defaultText.trim();
    modeSelect.value  = "story";
    voiceSelect.value = "elder_male";
    currentFileName   = "出师表节选";

    setTimeout(async () => {
      try {
        await generateBtn.click();
      } catch (e) {
        console.log("首次自动生成失败:", e);
        setStatus("下一段生成失败 ❌（已停止）", "bad", { busy: false });
        isAutoPlaying = false;
      }
    }, 800);

    localStorage.setItem("ai_reader_visited", "1");

  } else {
    modeSelect.value  = "original";
    voiceSelect.value = "young_female";
  }
});
