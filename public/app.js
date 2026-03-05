import { generateAudioFromText } from './audioEngine.js';
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
let currentIndex = 0;
let isAutoPlaying = false;
let sleepTimerId = null;
let sleepMode = null;

/** ✅ 新增：用于“可中断生成”的控制 */
let currentAbort = null;     // AbortController
let currentJobId = 0;        // 每次点击生成+1，旧任务结果全部作废
let currentAudioUrl = null;  // 释放 objectURL，避免内存泄漏
let nextAudioUrl = null;
let nextAbort = null;
let nextNextAudioUrl = null;
const SESSION_KEY = "ai_reader_session_v1";

function saveSession(patch = {}) {
  try {
    const prev = loadSession() || {};
    const data = {
      text: textInput?.value || "",
      chunks,
      currentIndex,
      currentTime: audioPlayer?.currentTime || 0,
      mode: modeSelect?.value || "original",
      voice: voiceSelect?.value || "young_female",
      speed: speedSelect?.value || "1",
      ...prev,
      ...patch,
      updatedAt: Date.now()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {}
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

// ✅ 新增：电子书“开头垃圾信息/目录”清理（所有模式都生效）
// 目标：删掉作者/出版社/ISBN/版权页，以及开头连续的“第一章 第二章 …”目录块
// 策略：只处理“开头一段”，非常保守，避免误删正文
function cleanBookTextForReading(rawText) {
  const text = (rawText || "").replace(/\r/g, "").trim();
  if (!text) return "";

  // 只扫描开头 N 行，避免误伤正文中间内容
  const MAX_HEAD_LINES = 220;
  const lines = text.split("\n");

  const head = lines.slice(0, MAX_HEAD_LINES);
  const tail = lines.slice(MAX_HEAD_LINES);

  // 1) 清理开头元信息（作者/出版社/ISBN/版权等）
  // 只删“看起来像元信息的一整行”
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

  // 2) 识别“目录块”：开头连续多行的章节标题
  // 例：第一章 / 第十二章 / Chapter 1 / 1. / 第一回 / 楔子 / 序章
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

  // 先把 head 做一遍“元信息删除”
  let cleanedHead = [];
  for (let i = 0; i < head.length; i++) {
    const line = head[i].trim();
    if (!line) {
      cleanedHead.push(""); // 保留空行结构
      continue;
    }
    // 删除非常明确的元信息行
    if (metaLineRe.test(line)) continue;

    cleanedHead.push(head[i]);
  }

  // 再尝试删除“目录块”
  // 规则：从头开始找，出现（目录/章节标题）密度很高的一段，就判定为目录块并删掉
  // 判定方式：在一个窗口里，tocLineRe 命中 >= 6 行，并且命中占比 >= 60%
  const WINDOW = 18;
  let cutStart = -1;
  let cutEnd = -1;

  const headLines = cleanedHead;

  // 找目录块起点（更保守：必须在前 120 行内出现）
  const SEARCH_LIMIT = Math.min(120, headLines.length);

  for (let i = 0; i < SEARCH_LIMIT; i++) {
    // 找到 “目录” 这一行，优先从这里开始判定
    const t = (headLines[i] || "").trim();
    if (/^(目录|目\s*录|contents)\s*$/i.test(t)) {
      cutStart = i;
      break;
    }
  }

  // 如果没找到“目录”行，就用窗口密度找一段目录块（更保守：只在前 80 行找）
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

  // 有目录块起点，就继续往下扩展，直到连续多行都不像目录为止
  if (cutStart !== -1) {
    let i = cutStart;
    let looseCount = 0;

    for (; i < headLines.length; i++) {
      const line = (headLines[i] || "").trim();

      // 空行不算结束（目录里常有空行）
      if (!line) continue;

      if (tocLineRe.test(line) || /^(目录|目\s*录|contents)\s*$/i.test(line)) {
        looseCount = 0;
        continue;
      } else {
        // 连续多行不匹配就认为目录结束
        looseCount++;
        if (looseCount >= 3) {
          cutEnd = i; // i 这一行开始算正文
          break;
        }
      }
    }

    // 如果一直到末尾都是目录样式，那就全部当目录删掉
    if (cutEnd === -1) cutEnd = headLines.length;

    // 删掉目录块
    const kept = headLines.slice(0, cutStart).concat(headLines.slice(cutEnd));
    cleanedHead = kept;
  }

  // 合并回正文：head + tail
  const merged = cleanedHead.concat(tail).join("\n");

  // 最后做一次简单的空行压缩（最多保留 2 个连续空行）
  return merged
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ✅ 新增：立刻停止当前播放/队列/网络请求，并清理资源 */
function interruptPlayback(reason = "") {
  isAutoPlaying = false;

  // 取消正在进行的 TTS 请求
  if (currentAbort) {
    try { currentAbort.abort(); } catch {}
    currentAbort = null;
  }

  // ✅ 清理预生成中的请求
if (nextAbort) {
  try { nextAbort.abort(); } catch {}
  nextAbort = null;
}

// ✅ 释放预生成的音频URL（nextAudioUrl）
if (nextAudioUrl) {
  try { URL.revokeObjectURL(nextAudioUrl); } catch {}
}
nextAudioUrl = null;

// ✅ 如果你有 nextNextAudioUrl（第二个预生成缓存），也要清理
if (typeof nextNextAudioUrl !== "undefined" && nextNextAudioUrl) {
  try { URL.revokeObjectURL(nextNextAudioUrl); } catch {}
}
nextNextAudioUrl = null;

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
  abort.signal,
  chunks[index - 1] || null
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

  try {
   preGenerateNext(index + 1, jobId);
   await audioPlayer.play();
   

} catch (e) {
  console.log("play() 被浏览器拒绝或异常:", e);

  // 如果实际上已经在播放，就不要报错
  if (!audioPlayer.paused) {
    console.log("实际已播放，忽略错误");
    return;
  }

  throw e; // 真的失败才抛
}
}

async function preGenerateNext(index, jobId) {

  if (index >= chunks.length) return;

  const mode = modeSelect?.value || "original";
  const voice = voiceSelect?.value || "young_female";

  const abort = new AbortController();
  nextAbort = abort;

  try {

    const url = await generateAudioFromText(
      chunks[index],
      mode,
      voice,
      abort.signal,
      chunks[index - 1] || null
    );

    // 如果已经开启了新任务，旧任务结果直接丢弃
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
  let text = textInput.value;
  if (!text) {
    alert("请输入文字");
    return;
  }

  // ✅ 新增：分段前清理“电子书开头目录/元信息”（所有模式都生效）
const cleaned = cleanBookTextForReading(text);
if (cleaned && cleaned.trim().length > 0) {
  text = cleaned;
  // 回写文本框：方便你肉眼确认“目录确实被删掉了”
  textInput.value = cleaned;
}

  // 1) 立刻打断上一轮
  interruptPlayback("已打断，按当前设置重新生成…");

  // 2) 新开一轮任务 id
  currentJobId += 1;
  const jobId = currentJobId;

  // ✅ 加速启动：第一段切小（更快改写+更快出第一段音频）
//    后续仍然用大段，保证整体效率
const firstParts = splitTextIntoChunks(text, { maxLen: 420, minLen: 200 });

if (firstParts.length > 1) {
  const first = firstParts.shift(); // 第一段（短）
  const restText = firstParts.join("\n\n"); // 剩余文本重新拼回去

  const restParts = splitTextIntoChunks(restText, { maxLen: 2200, minLen: 800 });

  chunks = [first, ...restParts];
} else {
  chunks = firstParts;
}
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
const playPauseBtn = document.getElementById("playPauseBtn");

playPauseBtn?.addEventListener("click", function () {

  if (audioPlayer.paused) {

    audioPlayer.play();
    playPauseBtn.innerText = "⏸ 暂停";

  } else {

    audioPlayer.pause();
    playPauseBtn.innerText = "▶️ 播放";

  }

});

// 自动保存播放进度（保持）
let lastSessionSave = 0;

audioPlayer?.addEventListener("timeupdate", function () {

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

// 页面加载时恢复播放进度（保持）
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
  audioPlayer.currentTime = session.currentTime;
}

    if (chunks.length > 0) {
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

// ✅ 语速：立刻生效（保持）
speedSelect?.addEventListener("change", function () {
  audioPlayer.playbackRate = parseFloat(speedSelect.value);
});

// ✅ 自动播放下一段：带 jobId 防止串线
audioPlayer?.addEventListener("ended", async function () {

  if (sleepMode === "end") {
  interruptPlayback("定时关闭（本段结束）");
  sleepMode = null;
  return;
}

  if (!isAutoPlaying) return;

  currentIndex += 1;

  saveSession({
    currentIndex
  });

  if (nextAudioUrl) {

  const url = nextAudioUrl;

  if (currentAudioUrl) {
  try { URL.revokeObjectURL(currentAudioUrl); } catch {}
  }

  nextAudioUrl = nextNextAudioUrl;
  nextNextAudioUrl = null;

  currentAudioUrl = url;

  audioPlayer.src = url;
  audioPlayer.playbackRate = parseFloat(speedSelect?.value || "1");
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
window.addEventListener("DOMContentLoaded", () => {
  const hasVisited = localStorage.getItem("ai_reader_visited");

  if (!hasVisited) {
    // ===== 第一次进入 =====

    const defaultText = `
臣亮言：先帝创业未半而中道崩殂。今天下三分，益州疲弊，此诚危急存亡之秋也。
然侍卫之臣不懈于内，忠志之士忘身于外者，盖追先帝之殊遇，欲报之于陛下也。
诚宜开张圣听，以光先帝遗德，恢弘志士之气，不宜妄自菲薄，引喻失义，以塞忠谏之路也。
`;

    textInput.value = defaultText.trim();

    // 默认故事模式 + 老年男
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
    // ===== 第二次及以后 =====

    modeSelect.value = "original";
    voiceSelect.value = "young_female";
  }
});

sleepTimer?.addEventListener("change", function () {

  const value = sleepTimer.value;

  if (sleepTimerId) {
    clearTimeout(sleepTimerId);
    sleepTimerId = null;
  }

  sleepMode = null;

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

  sleepTimerId = setTimeout(() => {

    interruptPlayback("定时关闭");

  }, seconds * 1000);

  setStatus(`已设置 ${seconds / 60} 分钟后关闭`, "info");

});