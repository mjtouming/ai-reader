import { generateAudioFromText } from './audioEngine.js?v=20261022-1';
import { hashText, migrateV1IfNeeded, saveTextRecord, loadTextRecord, deleteTextRecord } from './storage.js';
import { buildReadingChunks, resolvePlaybackChunks, savedChunksUsable } from './readingChunks.mjs?v=20261022-1';
import { cleanBookText } from './bookCleaner.mjs?v=20261022-1';
import { createTextDraft } from './textInputDraft.mjs?v=20261022-1';

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

// 用户点进正文框是为了粘贴新内容。先把框清空，原文留在 textDraft 里。
// 没粘贴也没输入就失焦时写回原文。切书、恢复进度这类程序化赋值走 writeTextInput，
// 不能被当成点击，也不能在失焦时被旧原文盖掉。
const textDraft = createTextDraft();
let textDraftPass = 0;

function readTextInput() {
  return textDraft.read(textInput?.value || "");
}

function writeTextInput(next) {
  if (!textInput) return;
  textDraftPass += 1;
  const value = next == null ? "" : String(next);
  textDraft.runWrite(() => {
    textInput.value = value;
  });
}

function reclearTextInput(pass) {
  if (pass !== textDraftPass || !textInput) return;
  if (!textDraft.shouldReclear(textInput.value, document.activeElement === textInput)) return;
  textInput.value = "";
  try { textInput.setSelectionRange(0, 0); } catch {}
}

if (textInput) {
  textInput.addEventListener("focus", () => {
    const decision = textDraft.onFocus(textInput.value);
    if (decision.type !== "clear") return;
    textInput.value = "";
    try { textInput.setSelectionRange(0, 0); } catch {}
    const pass = textDraftPass;
    // iOS 打开键盘时有时会把刚清掉的原文写回去，短窗口内再清一次。
    // 用户已经粘贴或输入之后 shouldReclear 为 false，不会把新内容清掉。
    requestAnimationFrame(() => reclearTextInput(pass));
    for (const ms of [30, 120, 300]) setTimeout(() => reclearTextInput(pass), ms);
  });

  textInput.addEventListener("blur", () => {
    const decision = textDraft.onBlur(textInput.value);
    textDraftPass += 1;
    if (decision.type === "restore") textInput.value = decision.value;
  });

  textInput.addEventListener("compositionstart", () => {
    textDraft.onCompositionStart();
  });

  textInput.addEventListener("compositionend", () => {
    textDraft.onCompositionEnd(textInput.value);
  });

  textInput.addEventListener("paste", () => {
    textDraft.onPaste();
  });

  textInput.addEventListener("beforeinput", (event) => {
    if (event.isComposing) return;
    textDraft.onUserInput(event.inputType || "");
  });

  textInput.addEventListener("input", (event) => {
    if (event.isComposing) return;
    textDraft.onUserInput(event.inputType || "");
  });
}

// 模式联动改声线时会同步触发 voice change；这段时间不要重启两遍。
let applyingLinkedVoice = false;

voiceSelect.addEventListener("change", () => {
  localStorage.setItem(VOICE_MANUAL_KEY, voiceSelect.value);
  if (applyingLinkedVoice) return;
  // 声线变了但改写稿仍可用，只重新合成，不丢掉上文。
  restartPlaybackIfActive("切换声线，重新生成第");
});

modeSelect.addEventListener("change", () => {
  const manualVoice = localStorage.getItem(VOICE_MANUAL_KEY);
  applyingLinkedVoice = true;
  try {
    if (manualVoice) {
      if (voiceSelect.value !== manualVoice) voiceSelect.value = manualVoice;
    } else if (modeSelect.value === "story") {
      if (voiceSelect.value !== "elder_male") voiceSelect.value = "elder_male";
    } else if (voiceSelect.value !== "young_female") {
      voiceSelect.value = "young_female";
    }
  } finally {
    applyingLinkedVoice = false;
  }
  // 模式变了，旧改写稿不能再当 previous。
  restartPlaybackIfActive("切换模式，重新生成第", { clearRewrites: true });
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
let activeGenIndex   = -1;  // 正在等待生成的段（B2 阶段推送过滤用）
let audioCache       = {};   // index → url（只放已经生成好、还没拿去播的）
let inflight         = new Map(); // index → { token, jobId, promise, epoch } 同一段只有一个在途请求
let contextReady     = [];   // 该段改写上下文已落地，下一段才允许带 previous 出发
let playbackEpoch    = 0;    // interrupt 时递增，迟到的响应不能写进新一轮
let preGenerateAbort = new AbortController();
const PRE_WINDOW     = 4;    // 向前预生成的段数（仍按顺序，不并发抢上文）
let lastSessionSave  = 0;
let lastSavedTextSig = null;   // 已写入 IndexedDB 的全文指纹，避免每 2 秒重复全量写
let storageWarnShown = false;  // 存储写入失败只提示一次
let currentBookText  = null;   // 当前书（currentBookId）对应的全文，精确判断"文本是否属于当前书"
let currentFrontMatter = null; // 本次加载洗掉的前置页，原文在 IndexedDB，不进 localStorage
let chunksFromCleaned = false; // 当前分段是不是用清洗后的文本生成的
let userInputEpoch = 0;        // 用户换了文本之后，迟到的 session 恢复不能再覆盖
let sessionRestoreStarted = false;

function noteUserInput() {
  userInputEpoch += 1;
}

// ── Keys ──────────────────────────────────────────────────────
// v2：localStorage 只存元数据，全文在 IndexedDB（storage.js texts store）
const SESSION_KEY = "ai_reader_session_v2";
const SHELF_KEY   = "ai_reader_shelf_v2";
let currentBookId = null;

function sameBookText(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

// 书架/会话写 IndexedDB 时只附一个短指针。原文记录单独放在 texts store。
function textRecord(text, chunkList, fileName, explicitRef) {
  const rec = { text, chunks: chunkList, fileName: fileName || null };
  const ref = explicitRef || (
    currentFrontMatter && sameBookText(text, currentFrontMatter.cleaned)
      ? currentFrontMatter.refId
      : null
  );
  if (ref) rec.frontMatterRef = ref;
  return rec;
}

// ── Session ───────────────────────────────────────────────────
// v2：localStorage 只存元数据指针（refId + 进度），全文按需写入 IndexedDB
function saveSession() {
  try {
    const prev  = loadSession() || {};
    const text  = readTextInput();
    const refId = currentRefId(text);
    const data = {
      ...prev,
      refId,
      currentIndex,
      maxReachedIndex,
      currentTime: audioPlayer?.currentTime || 0,
      mode:  modeSelect?.value  || "original",
      voice: voiceSelect?.value || "young_female",
      speed: speedSelect?.value || "1",
      updatedAt: Date.now()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));

    // 全文有变化才写 IndexedDB，避免每 2 秒全量重复写
    const sig = refId + ":" + text.length + ":" + chunks.length;
    if (refId && sig !== lastSavedTextSig) {
      lastSavedTextSig = sig;
      saveTextRecord(refId, textRecord(text, chunks, currentFileName)).catch(e => {
        console.log("saveTextRecord error:", e);
        if (!storageWarnShown) {
          storageWarnShown = true;
          setStatus("本地存储写入失败，进度可能无法恢复", "bad");
        }
      });
    }

    updateShelfProgress();
  } catch (e) {
    console.log("saveSession error:", e);
    if (!storageWarnShown) {
      storageWarnShown = true;
      setStatus("本地保存失败（存储空间不足？）", "bad");
    }
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

// 会话全文的 IndexedDB 记录 key：当前文本与当前书全文完全一致时用书籍 id，
// 否则（纯粘贴未入库/换了文本/书架满）用文本 hash 立独立记录。
// 必须精确比较文本，长度对比会让"同长度不同文"错认成同一本书，覆盖书的内容。
function currentRefId(text) {
  if (!text) return null;
  if (currentBookId && currentBookText === text) return currentBookId;
  return hashText(text);
}

function deriveTitle() {
  if (currentFileName) return currentFileName;
  const text = readTextInput().trim();
  if (text.length > 0) {
    return text.slice(0, 10).replace(/\s+/g, "") + (text.length > 10 ? "…" : "");
  }
  const today = new Date().toISOString().slice(0, 10);
  return `未命名书籍 ${today}`;
}

async function saveToShelf() {
  const text = readTextInput().trim();
  if (!text || !chunks.length) return;

  const newId = hashText(text);
  const shelf = loadShelf();
  // 优先按新 hash 匹配；当前书全文完全一致时沿用旧 id——兼容 v1 迁移来的旧 id
  let existing =
    shelf.books.find(b => b.id === newId) ||
    (currentBookId && currentBookText === text
      ? shelf.books.find(b => b.id === currentBookId)
      : null);

  if (!existing && shelf.books.length >= 10) {
    alert("书架已满（最多 10 本），请打开书架删除旧书再继续");
    return;
  }

  // 书籍 id 保持稳定：已存在的书沿用原 id（含 v1 迁移来的旧 id）
  const id = existing ? existing.id : newId;
  const book = {
    id,
    title:       deriveTitle(),
    fileName:    currentFileName || null,
    textLength:  text.length,
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

  // 全文写 IndexedDB（书架 localStorage 只存上面的元数据）
  try {
    await saveTextRecord(id, textRecord(text, chunks, currentFileName || null));
    lastSavedTextSig = id + ":" + text.length + ":" + chunks.length;
  } catch (e) {
    console.log("saveTextRecord error:", e);
    if (!storageWarnShown) {
      storageWarnShown = true;
      setStatus("书籍全文保存失败（本地存储异常）", "bad");
    }
  }

  if (existing) {
    Object.assign(existing, book);
  } else {
    shelf.books.unshift(book);
  }

  currentBookId       = id;
  currentBookText     = text;
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

async function loadBook(book) {
  interruptPlayback();
  currentFrontMatter = null;
  chunksFromCleaned = false;
  hideFrontMatterBar();

  // 全文从 IndexedDB 取（localStorage 只存元数据）
  let rec = null;
  try { rec = await loadTextRecord(book.id); } catch {}
  const text = rec?.text || "";
  if (!text) {
    setStatus(`《${book.title}》原文数据缺失（本地缓存被清理），请重新导入文本`, "bad");
    return;
  }

  writeTextInput(text);
  currentFileName   = rec?.fileName || book.fileName || null;
  modeSelect.value  = (book.mode === "translate" ? "original" : book.mode) || "original";
  voiceSelect.value = book.voice || "young_female";
  speedSelect.value = book.speed || "1";

  // 已保存的分段原样沿用，旧的 currentIndex 仍然指向同一段。
  // 没有分段（v1 迁移来的书）才用旧算法重建，不用新的渐进规则重切。
  const savedChunks = Array.isArray(rec?.chunks) ? rec.chunks : null;
  const reused = savedChunksUsable(savedChunks);
  chunks = resolvePlaybackChunks(text, reused ? savedChunks : null);
  await rememberFrontMatter(rec, text);
  if (!reused && chunks.length) {
    saveTextRecord(book.id, textRecord(text, chunks, currentFileName, rec?.frontMatterRef)).catch(e => {
      console.log("saveTextRecord error:", e);
    });
  }

  rewrittenChunks = [];
  contextReady    = [];
  currentIndex    = Math.min(book.currentIndex || 0, Math.max(0, chunks.length - 1));
  maxReachedIndex = book.maxReachedIndex ?? currentIndex;
  restoreTime     = book.currentTime || 0;
  currentBookId   = book.id;
  currentBookText = text;
  // IDB 里已有该书全文，标记指纹避免 saveSession 立刻重复写
  lastSavedTextSig = book.id + ":" + text.length + ":" + chunks.length;

  saveSession();
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
  if (currentBookId === id) {
    currentBookId   = null;
    currentBookText = null;
    currentFrontMatter = null;
    chunksFromCleaned = false;
    hideFrontMatterBar();
  }
  loadTextRecord(id).then(rec => {
    if (rec?.frontMatterRef) deleteTextRecord(rec.frontMatterRef).catch(() => {});
    return deleteTextRecord(id);
  }).catch(() => {});
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
    const modeLabel = book.mode === "story" ? "故事" : "原文";
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
    item.addEventListener("click", () => {
      loadBook(book).catch(() => setStatus("打开书籍失败 ❌", "bad", { busy: false }));
      closeSheet();
    });
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
  noteUserInput();
  interruptPlayback("准备添加新书");
  writeTextInput("");
  chunks          = [];
  rewrittenChunks = [];
  contextReady    = [];
  currentIndex    = 0;
  maxReachedIndex = -1;
  currentBookId   = null;
  currentBookText = null;
  currentFileName = null;
  currentFrontMatter = null;
  chunksFromCleaned = false;
  hideFrontMatterBar();
  renderChunkNav();
  setStatus("请粘贴文字或上传文件", "info");
  closeSheet();
  fileInput?.click();
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
  saveSession();
  try {
    await playChunk(currentIndex, jobId);
  } catch (e) {
    if (e?.name === "AbortError") {
      // 跳转途中又被换声线/换书打断时，不能把新任务的连播标志清掉。
      if (jobId === currentJobId) isAutoPlaying = false;
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
    // busy=true 仅在"生成中"禁用按钮；播放中必须保持可点击（粘贴新文本重新生成）
    generateBtn.disabled = opts.busy;
  }
  if (progressBar && opts.total != null) {
    progressBar.max   = opts.total;
    progressBar.value = opts.step ?? 0;
  }
}

// ── 前置内容：只在加载书籍文件时清洗，粘贴和 YouTube 不走这里 ──
function hideFrontMatterBar() {
  document.getElementById("frontMatterBar")?.setAttribute("hidden", "");
  document.getElementById("frontMatterPreview")?.setAttribute("hidden", "");
  const view = document.getElementById("frontMatterView");
  if (view) view.textContent = "查看";
}

function showFrontMatterBar(removedChars) {
  const count = document.getElementById("frontMatterCount");
  if (count) count.textContent = String(removedChars);
  const view = document.getElementById("frontMatterView");
  if (view) view.textContent = "查看";
  document.getElementById("frontMatterBar")?.removeAttribute("hidden");
  document.getElementById("frontMatterPreview")?.setAttribute("hidden", "");
}

function compactChars(value) {
  return String(value || "").replace(/\s/g, "").length;
}

async function rememberFrontMatter(record, cleanedText) {
  currentFrontMatter = null;
  chunksFromCleaned = false;
  hideFrontMatterBar();
  if (!record?.frontMatterRef || !cleanedText) return;
  let fm = null;
  try { fm = await loadTextRecord(record.frontMatterRef); } catch {}
  if (!fm?.text) return;
  currentFrontMatter = {
    refId: record.frontMatterRef,
    original: fm.text,
    removed: fm.removed || "",
    removedChars: fm.removedChars || Math.max(0, compactChars(fm.text) - compactChars(cleanedText)),
    cleaned: cleanedText
  };
  chunksFromCleaned = true;
  showFrontMatterBar(currentFrontMatter.removedChars);
}

async function acceptBookFile(rawText, source, extra = {}) {
  let result;
  try {
    result = cleanBookText(rawText || "", {
      source,
      pages: extra.pages,
      toc: extra.toc
    });
  } catch (error) {
    console.log("clean book text error:", error);
    result = { text: rawText || "", original: rawText || "", changed: false, removedChars: 0 };
  }

  writeTextInput(result.text || "");
  currentFrontMatter = null;
  chunksFromCleaned = false;
  hideFrontMatterBar();
  if (!result.changed || !result.removedChars) return;

  const refId = "fm:" + hashText(result.original);
  currentFrontMatter = {
    refId,
    original: result.original,
    removed: result.removed || "",
    removedChars: result.removedChars,
    cleaned: result.text
  };
  try {
    await saveTextRecord(refId, {
      text: result.original,
      removed: result.removed || "",
      removedChars: result.removedChars,
      fileName: currentFileName || null
    });
  } catch (error) {
    console.log("save front matter error:", error);
  }
  showFrontMatterBar(result.removedChars);
}

async function restoreFrontMatterText() {
  if (!currentFrontMatter) return;
  const original = currentFrontMatter.original;
  const cleaned = currentFrontMatter.cleaned;
  const refId = currentFrontMatter.refId;
  const rebuild = chunks.length > 0 && (
    chunksFromCleaned || sameBookText(currentBookText, cleaned)
  );
  writeTextInput(original);
  currentFrontMatter = null;
  chunksFromCleaned = false;
  hideFrontMatterBar();
  deleteTextRecord(refId).catch(() => {});

  if (!rebuild) {
    setStatus("已恢复原文", "ok", { busy: false });
    return;
  }

  interruptPlayback("已恢复原文，重新分段生成…");
  chunks = buildReadingChunks(original);
  currentIndex = 0;
  maxReachedIndex = -1;
  rewrittenChunks = [];
  contextReady = [];

  if (currentBookId && sameBookText(currentBookText, cleaned)) {
    currentBookText = original;
    const shelf = loadShelf();
    const book = shelf.books.find(item => item.id === currentBookId);
    if (book) {
      book.textLength = original.length;
      book.totalChunks = chunks.length;
      book.currentIndex = 0;
      book.maxReachedIndex = 0;
      book.currentTime = 0;
      book.updatedAt = Date.now();
      saveShelf(shelf);
    }
    try {
      await saveTextRecord(currentBookId, {
        text: original,
        chunks,
        fileName: currentFileName || null
      });
      lastSavedTextSig = currentBookId + ":" + original.length + ":" + chunks.length;
    } catch (error) {
      console.log("saveTextRecord error:", error);
    }
  }

  renderChunkNav();
  saveSession();
  if (!chunks.length) {
    setStatus("已恢复原文", "ok", { busy: false });
    return;
  }

  isAutoPlaying = true;
  currentJobId += 1;
  const jobId = currentJobId;
  setStatus("已恢复原文，重新分段生成…", "info", {
    busy: true,
    loading: true,
    step: 1,
    total: chunks.length
  });
  try {
    await playChunk(0, jobId);
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error(error);
    setStatus("恢复原文后生成失败 ❌", "bad", { busy: false });
    isAutoPlaying = false;
  }
}

document.getElementById("frontMatterView")?.addEventListener("click", () => {
  const panel = document.getElementById("frontMatterPreview");
  const body = document.getElementById("frontMatterPreviewBody");
  const view = document.getElementById("frontMatterView");
  if (!panel || !currentFrontMatter) return;
  if (panel.hasAttribute("hidden")) {
    if (body) body.textContent = currentFrontMatter.removed || "（没有可显示的片段）";
    panel.removeAttribute("hidden");
    if (view) view.textContent = "收起";
  } else {
    panel.setAttribute("hidden", "");
    if (view) view.textContent = "查看";
  }
});

document.getElementById("frontMatterRestore")?.addEventListener("click", () => {
  restoreFrontMatterText().catch(error => {
    console.error(error);
    setStatus("恢复原文失败 ❌", "bad", { busy: false });
  });
});

// 粗判文本是否需要"先翻译"（外语 或 文言文）——只看开头一小段，纯本地正则，不调用任何接口
function textLikelyNeedsTranslation(text) {
  if (!text) return false;
  const sample = String(text).slice(0, 200);
  const meaningfulChars = sample.replace(/[\s\d\p{P}]/gu, "");
  if (!meaningfulChars) return false;

  const cjkCount = (sample.match(/[一-龥]/g) || []).length;
  const cjkRatio = cjkCount / meaningfulChars.length;

  // 中文字符占比不够高 → 当外语处理，需要翻译
  if (cjkRatio < 0.6) return true;

  // 中文为主，但可能是文言文：典型文言虚词出现次数达到阈值
  const classicalMarkers = sample.match(/[之乎者也矣焉哉兮曰]/g) || [];
  if (classicalMarkers.length >= 2) return true;

  return false;
}

// ── TTS 阶段事件（服务端 WS 推送，B2）──
// 只显示"当前正在等待的段"的阶段；预生成段的阶段事件被过滤，避免覆盖播放状态
window.addEventListener("tts-stage", (e) => {
  const { stage, chunkIndex } = e.detail || {};
  if (typeof chunkIndex !== "number" || chunkIndex - 1 !== activeGenIndex) return;
  const label = stage === "rewrite" ? "AI 改写中" : stage === "tts" ? "语音合成中" : null;
  if (!label) return;
  setStatus(`第 ${activeGenIndex + 1}/${chunks.length} 段 · ${label}…`, "info", {
    busy: true,
    loading: true,
    step: activeGenIndex + 1,
    total: chunks.length
  });
});

// ── Playback core ─────────────────────────────────────────────
function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function restartPlaybackIfActive(statusLabel, opts = {}) {
  if (!(chunks.length > 0 && audioPlayer && (audioPlayer.src || isAutoPlaying))) return;
  const resumeIndex = currentIndex;
  if (opts.clearRewrites) {
    rewrittenChunks = [];
    contextReady = [];
  }
  interruptPlayback("");
  setStatus(`${statusLabel} ${resumeIndex + 1} 段…`, "info", { busy: true, loading: true });
  isAutoPlaying = true;
  currentJobId += 1;
  const jobId = currentJobId;
  playChunk(resumeIndex, jobId).catch(e => {
    if (e?.name !== "AbortError") {
      const fail = statusLabel.startsWith("切换声线") ? "切换声线失败 ❌" : "切换后重新生成失败 ❌";
      setStatus(fail, "bad", { busy: false });
      isAutoPlaying = false;
    }
  });
}

function interruptPlayback(reason = "") {
  isAutoPlaying = false;
  restoreTime  = 0;   // 恢复进度只在"继续播放"路径生效，任何打断/跳段/换书都不得带入旧秒数
  playbackEpoch += 1;
  activeGenIndex = -1;

  if (currentAbort) {
    try { currentAbort.abort(); } catch {}
    currentAbort = null;
  }

  // 取消所有预生成请求。epoch 让已经返回、但还没写入缓存的响应也作废。
  preGenerateAbort.abort();
  preGenerateAbort = new AbortController();
  for (const url of Object.values(audioCache)) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  audioCache = {};
  inflight.clear();

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

// 同一段只发一个 /tts。播放方若发现该段已在预生成，就等它，不再另起一条（另起会重新计费，等待也从头算）。
function ensureChunkAudio(index, jobId, opts = {}) {
  if (jobId !== currentJobId) return Promise.reject(abortError());
  const cached = audioCache[index];
  if (cached) {
    return Promise.resolve({ url: cached, rewritten: rewrittenChunks[index] || null });
  }
  const existing = inflight.get(index);
  if (existing && existing.jobId === jobId) {
    console.log("复用在途请求", index + 1);
    return existing.promise;
  }

  const token = {};
  const epoch = playbackEpoch;
  const promise = runChunkRequest(index, jobId, epoch, token, opts);
  inflight.set(index, { token, jobId, promise, epoch });
  return promise;
}

async function runChunkRequest(index, jobId, epoch, token, opts) {
  const foreground = !!opts.foreground;
  let ok = false;
  try {
    // 上一段的改写稿还没回来时不能先发下一段，否则 story 的 previous 是空的。
    if (index > 0 && !contextReady[index - 1]) {
      const prev = inflight.get(index - 1);
      if (prev && prev.jobId === jobId && prev.epoch === epoch) {
        try { await prev.promise; } catch {}
      }
      if (jobId !== currentJobId || epoch !== playbackEpoch) throw abortError();
    }

    const mode = modeSelect?.value || "original";
    const voice = voiceSelect?.value || "young_female";
    const alreadyRewritten = !!rewrittenChunks[index];
    const textToSend = rewrittenChunks[index] || chunks[index];
    // 原文模式第一段为了起播快可以跳过改写；开头是外语/文言文时不能跳，否则会读出没翻译的原文。
    const isOriginalFirstChunk = index === 0 && mode === "original";
    const skipRewrite = alreadyRewritten ||
      (isOriginalFirstChunk && !textLikelyNeedsTranslation(textToSend));
    const previous = index > 0 ? (rewrittenChunks[index - 1] || null) : null;

    const signal = preGenerateAbort.signal;
    if (signal.aborted || epoch !== playbackEpoch) throw abortError();

    // 响应头里的改写稿一到就放行下一段。不能等 MP3 下完：慢链路上正文时间和成片差不多，
    // 等下完再预取，播放永远追不上。
    const notifyContext = (rewritten) => {
      if (jobId !== currentJobId || epoch !== playbackEpoch) return;
      if (rewritten && !rewrittenChunks[index]) rewrittenChunks[index] = rewritten;
      if (contextReady[index]) return;
      contextReady[index] = true;
      // 前台这段要等 play() 成功后再预生成，避免和首次起播抢 Safari 的自动播放许可。
      if (!foreground) fillWindow(currentIndex, jobId);
    };

    const result = await generateAudioFromText(
      textToSend,
      mode,
      voice,
      signal,
      previous,
      index + 1,
      chunks.length,
      skipRewrite,
      notifyContext
    );

    if (jobId !== currentJobId || epoch !== playbackEpoch || signal.aborted) {
      try { if (result?.url) URL.revokeObjectURL(result.url); } catch {}
      throw abortError();
    }

    if (result.rewritten && !rewrittenChunks[index]) {
      rewrittenChunks[index] = result.rewritten;
    }
    contextReady[index] = true;
    audioCache[index] = result.url;
    ok = true;
    return { url: result.url, rewritten: rewrittenChunks[index] || result.rewritten || null };
  } finally {
    const cur = inflight.get(index);
    if (cur && cur.token === token) inflight.delete(index);
    // 前台这段要等 play() 成功后再预生成，避免和首次起播抢 Safari 的自动播放许可。
    if (ok && !foreground && jobId === currentJobId && epoch === playbackEpoch) {
      fillWindow(currentIndex, jobId);
    }
  }
}

async function playChunk(index, jobId) {
  if (jobId !== currentJobId) return;
  const total = chunks.length;
  if (index >= total) {
    setStatus("全部播放完成 ✅", "ok", {
      busy: false,
      step: total,
      total
    });
    isAutoPlaying = false;
    return;
  }

  const epoch = playbackEpoch;
  let audioUrl = audioCache[index] || null;

  if (audioUrl) {
    delete audioCache[index];
  } else {
    setStatus(`正在生成第 ${index + 1}/${total} 段...`, "info", {
      busy: true,
      loading: true,
      step: index + 1,
      total
    });

    currentAbort = preGenerateAbort;
    activeGenIndex = index;
    let result;
    try {
      result = await ensureChunkAudio(index, jobId, { foreground: true });
    } catch (e) {
      activeGenIndex = -1;
      if (e?.name === "AbortError") {
        console.log("生成被取消");
        return;
      }
      throw e;
    }
    activeGenIndex = -1;
    if (jobId !== currentJobId || epoch !== playbackEpoch) return;
    audioUrl = result?.url || null;
    if (audioUrl && audioCache[index] === audioUrl) delete audioCache[index];
  }

  if (jobId !== currentJobId || epoch !== playbackEpoch) return;
  if (!audioUrl) throw new Error("audioUrl is null (TTS failed)");
  // 缓存命中时没有改写稿，也要放行后面的预生成，避免窗口卡死。
  if (!contextReady[index]) contextReady[index] = true;

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
    busy: false,
    step: index + 1,
    total
  });

  try {
    await audioPlayer.play();
  } catch (e) {
    console.log("play() 被浏览器拒绝或异常:", e);
    if (audioPlayer.paused) {
      // Safari 自动播放被拦截，提示用户手动点击。此时不要抢着发下一段。
      setStatus("已生成，点击 ▶ 继续播放", "ok", { busy: false });
      isAutoPlaying = false;
      return;
    }
    console.log("实际已播放，忽略错误");
  }

  if (jobId !== currentJobId || epoch !== playbackEpoch) return;
  fillWindow(index, jobId);
}

// 从正在播的段往后补窗口。已经在途的段用 break 而不是 continue：
// 跳过它会并行发出下一段，story 的 previous 还没回来。
function fillWindow(fromIndex, jobId) {
  if (jobId !== currentJobId) return;
  const last = Math.min(chunks.length - 1, fromIndex + PRE_WINDOW);
  for (let i = fromIndex + 1; i <= last; i++) {
    if (audioCache[i]) continue;
    if (inflight.has(i)) break;
    if (i > 0 && !contextReady[i - 1]) break;
    ensureChunkAudio(i, jobId).catch(e => {
      if (e?.name === "AbortError") return;
      console.log("preGenerate error:", e);
    });
    break;
  }
}

// ── File upload ───────────────────────────────────────────────
fileInput?.addEventListener("change", async function () {
  const file = fileInput.files[0];
  if (!file) return;

  noteUserInput();
  interruptPlayback("已切换文件，停止当前播放");

  if (file.name.endsWith(".txt")) {
    const reader = new FileReader();
    reader.onload = async function (e) {
      currentFileName = file.name.replace(/\.[^.]+$/, "");
      await acceptBookFile(e.target.result || "", "txt");
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
      currentFileName = file.name.replace(/\.[^.]+$/, "");
      await acceptBookFile(data.text || "", "pdf", { pages: data.pages, toc: data.toc });
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
      currentFileName = file.name.replace(/\.[^.]+$/, "");
      await acceptBookFile(data.text || "", "docx");
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
  noteUserInput();
  let text = readTextInput().trim();
  if (!text) {
    alert("请输入文字");
    return;
  }

  // 识别 YouTube 链接，自动提取字幕。字幕不是书籍文件，不清洗。
  const isYouTube = /youtube\.com\/(watch|live)|youtu\.be\//.test(text);
  if (isYouTube) {
    currentFrontMatter = null;
    chunksFromCleaned = false;
    hideFrontMatterBar();
    setStatus("正在提取 YouTube 字幕...", "info", { busy: true });
    let ytData = null;
    let ytError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch("/fetch-youtube", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: text })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "失败");
        ytData = data;
        ytError = null;
        break;
      } catch (error) {
        ytError = error;
        // 只有网络层面的失败（请求根本没到服务器，比如手机信号瞬断）才重试一次；
        // 服务端已经明确返回的错误（比如真的无字幕）不重试，重试也没用
        const isNetworkError = error instanceof TypeError;
        if (attempt < 2 && isNetworkError) {
          setStatus("网络波动，正在重试...", "info", { busy: true });
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        break;
      }
    }
    if (ytError) {
      console.error(ytError);
      setStatus("YouTube 字幕提取失败 ❌：" + ytError.message, "bad", { busy: false });
      return;
    }
    writeTextInput(ytData.text || "");
    text = readTextInput();
    modeSelect.value  = "original";
    setStatus("字幕已提取，准备生成...", "info");
  }

  // 粘贴文本不清洗。书籍文件在载入时已经洗过；这里只在用户把文本改掉之后收起提示。
  if (currentFrontMatter && !sameBookText(text, currentFrontMatter.cleaned) && !sameBookText(text, currentFrontMatter.original)) {
    currentFrontMatter = null;
    chunksFromCleaned = false;
    hideFrontMatterBar();
  }

  // 1) 打断上一轮
  interruptPlayback("已打断，按当前设置重新生成…");

  // 2) 新任务 id
  currentJobId += 1;
  const jobId = currentJobId;

  // 段长逐段放大（约 150 起，1.6 倍封顶，最长 2200），让播放盖住下一段生成。
  chunks = buildReadingChunks(text);
  chunksFromCleaned = !!(currentFrontMatter && sameBookText(text, currentFrontMatter.cleaned));

  currentIndex    = 0;
  maxReachedIndex = -1;
  rewrittenChunks = [];
  contextReady    = [];

  await saveToShelf();
  saveSession();
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
      isAutoPlaying = true;
      fillWindow(currentIndex, currentJobId);
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
  saveSession();

  // 一律走 playChunk：缓存命中直接播，在途请求则等待，不会再发第二条 /tts。
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
window.addEventListener("load", async function () {
  if (sessionRestoreStarted) return;
  sessionRestoreStarted = true;
  const epochAtStart = userInputEpoch;

  // v1（localStorage 存全文）→ v2（全文在 IndexedDB）一次性迁移
  await migrateV1IfNeeded();

  // 生成/播放已在途则跳过恢复：load 事件可能晚于首次引导的自动生成
  // （DOMContentLoaded+800ms 触发 click，实测 load 晚 ~850ms 才到）。
  // 此时 session 是引导刚写的，若继续恢复会把「播放中」状态错误覆盖成
  // 「已恢复上次进度」，并把 isAutoPlaying 重置为 false 破坏自动连播。
  // 上传文件同样会改掉文本框，迟到的恢复不能把刚载入的书盖掉。
  if (currentJobId > 0 || epochAtStart !== userInputEpoch) return;

  const session = loadSession();
  if (!session) return;

  try {
    currentIndex      = session.currentIndex || 0;
    maxReachedIndex   = session.maxReachedIndex ?? currentIndex;
    modeSelect.value  = (session.mode === "translate" ? "original" : session.mode) || "original";
    voiceSelect.value = session.voice || "young_female";
    speedSelect.value = session.speed || "1";

    if (session.currentTime != null) {
      restoreTime = session.currentTime;
    }

    // 全文从 IndexedDB 取回。已存的书保持原样，不按新的清洗规则重切。
    let restoredText   = "";
    let restoredChunks = [];
    let restoredRecord = null;
    if (session.refId) {
      const rec = await loadTextRecord(session.refId);
      restoredRecord = rec;
      if (rec) {
        restoredText   = rec.text || "";
        restoredChunks = Array.isArray(rec.chunks) ? rec.chunks : [];
      }
    }
    if (currentJobId > 0 || epochAtStart !== userInputEpoch) return;
    writeTextInput(restoredText);
    // 有保存的分段就沿用。没有分段时按旧算法重建，避免新规则把旧的段索引错位。
    let rebuiltChunks = false;
    if ((!restoredChunks || restoredChunks.length === 0) && restoredText) {
      restoredChunks = resolvePlaybackChunks(restoredText, null);
      rebuiltChunks = restoredChunks.length > 0;
    }
    chunks = restoredChunks;
    contextReady = [];
    if (rebuiltChunks && session.refId) {
      saveTextRecord(session.refId, textRecord(
        restoredText,
        restoredChunks,
        null,
        restoredRecord?.frontMatterRef
      )).catch(e => console.log("saveTextRecord error:", e));
    }
    await rememberFrontMatter(restoredRecord, restoredText);
    lastSavedTextSig = restoredText
      ? session.refId + ":" + restoredText.length + ":" + restoredChunks.length
      : null;

    // refId 即书籍 id；匹配不上时回退 shelf.currentBookId（但文本归属未知，不设 currentBookText）
    const shelf = loadShelf();
    const matchedBook = session.refId
      ? (shelf?.books || []).find(b => b.id === session.refId)
      : null;
    currentBookId   = matchedBook ? matchedBook.id : (shelf?.currentBookId || null);
    currentBookText = matchedBook ? restoredText : null;
    // 同步修正 shelf.currentBookId
    if (matchedBook && shelf.currentBookId !== matchedBook.id) {
      shelf.currentBookId = matchedBook.id;
      saveShelf(shelf);
    }

    if (chunks.length > 0) {
      isAutoPlaying = false;
      renderChunkNav();
      // 恢复书名显示
      const bookForRestore = matchedBook || (shelf?.books || []).find(b => b.id === currentBookId);
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

    writeTextInput(defaultText.trim());
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
