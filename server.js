console.log("灵听 server 启动中…");

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const multer = require("multer");
const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const WebSocket = require("ws");

// ===== rewrite cache =====
const rewriteCachePath = path.join(__dirname, "rewrite_cache.json");
let rewriteCache = {};

if (fs.existsSync(rewriteCachePath)) {
  try {
    rewriteCache = JSON.parse(fs.readFileSync(rewriteCachePath, "utf8"));
  } catch {
    rewriteCache = {};
  }
}

// rewrite cache 落盘策略：防抖 5s 批量写 + 条数上限（超出淘汰最旧条目）
// 旧条目排前（从文件加载的在先、新写入的在后），按插入序近似 LRU
const REWRITE_CACHE_MAX = 5000;
let rewriteCacheDirty = false;
let rewriteCacheSaveTimer = null;

function pruneRewriteCache() {
  const keys = Object.keys(rewriteCache);
  if (keys.length <= REWRITE_CACHE_MAX) return;
  const removeCount = keys.length - REWRITE_CACHE_MAX + 500;
  for (let i = 0; i < removeCount; i++) delete rewriteCache[keys[i]];
  console.log(`🧹 rewrite cache 超限，淘汰 ${removeCount} 条最旧记录`);
}

function scheduleRewriteCacheSave() {
  rewriteCacheDirty = true;
  pruneRewriteCache();
  if (rewriteCacheSaveTimer) return;
  rewriteCacheSaveTimer = setTimeout(() => {
    rewriteCacheSaveTimer = null;
    if (!rewriteCacheDirty) return;
    rewriteCacheDirty = false;
    try {
      fs.writeFileSync(rewriteCachePath, JSON.stringify(rewriteCache, null, 2));
    } catch (e) {
      console.log("rewrite cache 写入失败:", e.message);
    }
  }, 5000);
}

// ===== tts_cache 启动清理（只增不减会吃满磁盘）=====
const TTS_CACHE_MAX_BYTES =
  Number(process.env.TTS_CACHE_MAX_BYTES) || 2 * 1024 * 1024 * 1024;

function cleanupTtsCache() {
  const outDir = path.join(__dirname, "tts_cache");
  if (!fs.existsSync(outDir)) return;
  try {
    const files = fs.readdirSync(outDir).map((f) => {
      const p = path.join(outDir, f);
      let st;
      try { st = fs.statSync(p); } catch { return null; }
      return st.isFile() ? { p, size: st.size, mtime: st.mtimeMs } : null;
    }).filter(Boolean);

    let total = files.reduce((s, f) => s + f.size, 0);
    console.log(`🧹 tts_cache：${files.length} 个文件，共 ${(total / 1048576).toFixed(1)}MB`);

    if (total <= TTS_CACHE_MAX_BYTES) return;

    files.sort((a, b) => a.mtime - b.mtime);
    const target = TTS_CACHE_MAX_BYTES * 0.9;
    let removed = 0;
    for (const f of files) {
      if (total <= target) break;
      try { fs.unlinkSync(f.p); total -= f.size; removed++; } catch {}
    }
    console.log(`🧹 tts_cache 超限（上限 ${(TTS_CACHE_MAX_BYTES / 1073741824).toFixed(1)}GB），已删除 ${removed} 个最旧文件`);
  } catch (e) {
    console.log("tts_cache cleanup error:", e.message);
  }
}
cleanupTtsCache();

const fetch = global.fetch;

// ===== TTS 阶段推送（WebSocket）=====
// /tts 单段处理可达数十秒，通过 WS 推送"改写中/合成中"阶段事件，前端可实时显示进度
const stageWssList = [];

function attachStageWss(server, label) {
  try {
    const wss = new WebSocket.Server({ server });
    stageWssList.push(wss);
    console.log("WebSocket 阶段推送已挂载:", label);
  } catch (e) {
    console.log(`WebSocket 挂载失败(${label}):`, e.message);
  }
}

function broadcastStage(payload) {
  if (!stageWssList.length || !payload?.requestId) return;
  const msg = JSON.stringify(payload);
  for (const wss of stageWssList) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(msg); } catch {}
      }
    });
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const publicPath = path.join(__dirname, "public");
console.log("Static path:", publicPath);
app.use(express.static(publicPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

/** ====== 工具：运行 edge-tts 脚本并生成 mp3 ====== */

async function runFishAudioTTS({ inputText, outFile }) {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: inputText,
      reference_id: "54a5170264694bfc8e9ad98df7bd89c3",
      format: "mp3",
      streaming: false
    })
  });
  if (!response.ok) throw new Error("Fish Audio API error: " + response.status);
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outFile, Buffer.from(buffer));
}

function runEdgeTTS({ inputText, voiceKey, outFile }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "tts_edge.py");

    let pythonPath =
      process.env.PYTHON_PATH ||
      (fs.existsSync(path.join(__dirname, ".venv", "bin", "python"))
        ? path.join(__dirname, ".venv", "bin", "python")
        : "python3");

    if (
      pythonPath.includes(path.join(__dirname, ".venv")) &&
      !fs.existsSync(pythonPath)
    ) {
      return reject(new Error("pythonPath not found: " + pythonPath));
    }

    const p = spawn(
      pythonPath,
      [scriptPath, voiceKey || "young_female", outFile],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.stdin.write(inputText, "utf8");
    p.stdin.end();

    // edge-tts 网络挂起时进程可能永不退出，180s 强杀避免请求悬挂
    const killTimer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
    }, 180000);

    p.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error("spawn error: " + err.message));
    });

    p.on("close", (code) => {
      clearTimeout(killTimer);
      console.log("🐍 python exit code:", code);
      if (stdout.trim()) console.log("🐍 python stdout:\n" + stdout.trim());
      if (stderr.trim()) console.log("🐍 python stderr:\n" + stderr.trim());

      if (code === 0) return resolve();
      reject(new Error(`edge-tts failed (code ${code})`));
    });
  });
}

async function runCosyVoiceTTS({ inputText, voiceKey, outFile }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY not set in .env");

  const voiceMap = {
    young_female: "longyue_v3",
    girl:         "longhuhu_v3",
    young_male:   "longxiu_v3",
    elder_male:   "longsanshu_v3",
  };

  const voice = voiceMap[voiceKey] || voiceMap["young_female"];
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutMs = Math.max(180000, Math.ceil(inputText.length / 1000) * 120000);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // The non-realtime HTTP API is designed for complete passages such as
    // audiobooks. Sending the whole passage in one request preserves prosody
    // and avoids the per-message truncation seen on the realtime WebSocket API.
    const response = await fetch(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "cosyvoice-v3-flash",
          input: {
            text: inputText,
            voice,
            format: "mp3",
          },
        }),
        signal: controller.signal,
      }
    );

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`CosyVoice HTTP ${response.status}: ${raw}`);
    }

    const result = JSON.parse(raw);
    const audioUrl = result?.output?.audio?.url;
    if (!audioUrl || result?.output?.finish_reason !== "stop") {
      throw new Error(`CosyVoice returned an incomplete result: ${raw}`);
    }

    const audioResponse = await fetch(audioUrl, { signal: controller.signal });
    if (!audioResponse.ok) {
      throw new Error(`CosyVoice audio download failed: HTTP ${audioResponse.status}`);
    }

    const audio = Buffer.from(await audioResponse.arrayBuffer());
    if (audio.length <= 100) {
      throw new Error(`CosyVoice returned empty audio: ${audio.length} bytes`);
    }

    fs.writeFileSync(outFile, audio);
    console.log(
      `🎙️ CosyVoice HTTP done in ${Date.now() - startTime}ms, voice=${voice}, ` +
      `chars=${inputText.length}, billed=${result?.usage?.characters}, size=${audio.length}`
    );
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`CosyVoice HTTP timeout (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function loadRewriteLib() {
  if (!loadRewriteLib.promise) {
    loadRewriteLib.promise = import("./public/rewritePrompts.mjs");
  }
  return loadRewriteLib.promise;
}

async function rewriteForTts({ text, mode, previous, chunkIndex, totalChunks, nextPreview, whole, requestId }) {
  const lib = await loadRewriteLib();
  const modeName = mode || "announcer";
  const variant = modeName === "story" && whole ? "whole" : "";
  const cacheKey = crypto.createHash("sha1").update(lib.rewriteKeyMaterial(text, modeName, variant)).digest("hex");
  if (rewriteCache[cacheKey]) {
    console.log("⚡ rewrite cache hit");
    return { text: rewriteCache[cacheKey], state: "cache" };
  }
  if (!fetch) {
    throw new Error("Node.js 版本过低：缺少内置 fetch。请升级到 Node 18+。");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY（请在 .env 里设置）");
  }

  const settings = lib.selectRewriteSettings(modeName);
  const idx = Number(chunkIndex) || 0;
  const total = Number(totalChunks) || 0;
  const chunkLabel = whole
    ? "全文"
    : idx > 0 && total > 0
      ? `${idx}/${total}`
      : idx > 0
        ? `${idx}/?`
        : `?/?`;
  console.log(`rewrite meta: role=${settings.roleName} chunk=${chunkLabel} previous=${previous ? "YES" : "NO"}`);
  broadcastStage({ requestId, chunkIndex: idx, stage: "rewrite" });

  const userContent = modeName === "story"
    ? lib.buildStoryUserContent({
        source: text,
        previous: previous || "",
        chunkLabel,
        nextPreview: whole ? "" : nextPreview,
        whole: !!whole
      })
    : lib.buildPlainUserContent({
        roleName: settings.roleName,
        chunkLabel,
        previous: previous || "",
        source: text
      });

  const rewriteResponse = await fetch(
    "https://api.deepseek.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: settings.temperature,
      }),
      signal: AbortSignal.timeout(120000),
    }
  );

  if (!rewriteResponse.ok) {
    const errText = await rewriteResponse.text();
    throw new Error("OpenAI rewrite failed: " + errText);
  }

  const rewriteData = await rewriteResponse.json();
  const rewritten = rewriteData?.choices?.[0]?.message?.content?.trim() || text;
  rewriteCache[cacheKey] = rewritten;
  scheduleRewriteCacheSave();
  return { text: rewritten, state: "live" };
}

function logTts(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// 合成完成后的 MP3。客户端用 <audio> 直接拉这个地址，可以边下边播。
app.get("/tts-audio/:key", (req, res) => {
  const key = String(req.params.key || "");
  if (!/^[a-f0-9]{40}$/.test(key)) {
    res.status(404).end();
    return;
  }
  const file = path.join(__dirname, "tts_cache", `tts_${key}.mp3`);
  if (!fs.existsSync(file)) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode || 404).end();
    }
  });
});

// ====== /tts ======
app.post("/tts", async (req, res) => {
  const {
    text,
    mode,
    voice,
    previous,
    chunkIndex,
    totalChunks,
    skipRewrite,
    requestId,
    delivery,
    nextPreview,
  } = req.body || {};
  const idx = Number.isFinite(Number(chunkIndex)) ? Number(chunkIndex) : 0;
  const total = Number.isFinite(Number(totalChunks)) ? Number(totalChunks) : 0;
  const reqLabel = requestId || "-";
  const startedAt = Date.now();
  let rewriteMs = 0;
  let synthMs = 0;
  let rewriteState = skipRewrite ? "skip" : "live";
  logTts(`/tts start chunk=${idx}/${total || "?"} req=${reqLabel} mode=${mode || "-"} voice=${voice || "-"} chars=${String(text || "").length} skipRewrite=${!!skipRewrite}`);
  console.log("MODE:", mode);
  console.log("rewrite previous:", previous ? previous.slice(-60) : "NONE");

  try {
    let inputText = text || "";
    if (!inputText.trim()) {
      return res.status(400).json({ error: "text is empty" });
    }

    const needRewrite = !skipRewrite && (mode === "story" || mode === "translate" || mode === "announcer" || mode === "original");

    const rewriteStarted = Date.now();
    if (needRewrite) {
      const rewritten = await rewriteForTts({
        text: inputText,
        mode,
        previous,
        chunkIndex: idx,
        totalChunks: total,
        nextPreview,
        whole: false,
        requestId
      });
      inputText = rewritten.text;
      rewriteState = rewritten.state;
    }
    rewriteMs = Date.now() - rewriteStarted;

    // 破折号只在送去合成前替换。改写缓存仍保留模型原文，所以 ttsKey 用 spokenText。
    const speech = await loadRewriteLib();
    const spokenText = speech.normalizeDashesForSpeech(inputText);

    // ===== TTS cache key =====
    const ttsProvider = process.env.TTS_PROVIDER || "edge";
    const ttsCacheSalt = ttsProvider === "cosyvoice" ? "|cosyvoice-http-v1" : "";
    const ttsKey = crypto
      .createHash("sha1")
      .update(spokenText + "|" + (voice || "young_female") + ttsCacheSalt)
      .digest("hex");

    const outDir = path.join(__dirname, "tts_cache");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, `tts_${ttsKey}.mp3`);

    console.log("🎧 TTS request:", { mode, voice, chars: spokenText.length });

    let needGenerate = true;
    const synthStarted = Date.now();

    if (fs.existsSync(outFile)) {
      const stat = fs.statSync(outFile);
      if (stat.size > 100) {
        console.log("⚡ TTS cache hit");
        needGenerate = false;
      } else {
        console.log("⚠️ empty TTS cache detected, deleting:", outFile);
        fs.unlinkSync(outFile);
      }
    }

    if (needGenerate) {
      broadcastStage({ requestId, chunkIndex: idx, stage: "tts" });
      if (ttsProvider === "fish") {
        await runFishAudioTTS({ inputText: spokenText, outFile });
      } else if (ttsProvider === "cosyvoice") {
        await runCosyVoiceTTS({
          inputText: spokenText,
          voiceKey: voice || "young_female",
          outFile,
        });
      } else {
        await runEdgeTTS({
          inputText: spokenText,
          voiceKey: voice || "young_female",
          outFile,
        });
      }
    }

    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      throw new Error("edge-tts did not produce output file or file is empty: " + outFile);
    }
    synthMs = Date.now() - synthStarted;

    const audioBytes = fs.statSync(outFile).size;
    const wantsUrl = delivery === "url";
    logTts(`/tts done chunk=${idx}/${total || "?"} req=${reqLabel} mode=${mode || "-"} voice=${voice || "-"} chars=${spokenText.length} rewriteMs=${rewriteMs} synthMs=${synthMs} audioBytes=${audioBytes} delivery=${wantsUrl ? "url" : "inline"} cache=${needGenerate ? "miss" : "hit"} rewrite=${rewriteState}`);

    res.setHeader("X-Rewritten-Text", encodeURIComponent(inputText));
    res.setHeader("X-Audio-Url", `/tts-audio/${ttsKey}`);
    res.setHeader("Cache-Control", "no-store");

    // 新客户端只拿地址，MP3 由 <audio> 拉 /tts-audio，预取不用等正文下完。
    if (wantsUrl) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Length", "0");
      res.status(200).end();
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");

    const stream = fs.createReadStream(outFile);

    stream.on("error", (err) => {
      console.error("❌ createReadStream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Audio file read failed" });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] /tts error chunk=${idx}/${total || "?"} req=${reqLabel} rewriteMs=${rewriteMs} synthMs=${synthMs} elapsedMs=${Date.now() - startedAt} ${error?.message || error}`);
    res.status(500).json({
      error: String(error?.message || error),
    });
  }
});

// 短文故事模式：一次改写全文，切段和合成仍由客户端逐段请求 /tts。
app.post("/rewrite-story", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is empty" });
  try {
    const lib = await loadRewriteLib();
    if (text.length > lib.STORY_WHOLE_MAX) {
      return res.status(400).json({ error: "text too long for whole rewrite" });
    }
    const started = Date.now();
    logTts(`/rewrite-story start chars=${text.length}`);
    const rewritten = await rewriteForTts({
      text,
      mode: "story",
      previous: "",
      chunkIndex: 1,
      totalChunks: 1,
      nextPreview: "",
      whole: true,
      requestId: req.body?.requestId
    });
    logTts(`/rewrite-story done chars=${rewritten.text.length} rewrite=${rewritten.state} ms=${Date.now() - started}`);
    res.json({ text: rewritten.text });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] /rewrite-story error ${error?.message || error}`);
    res.status(500).json({ error: String(error?.message || error) });
  }
});

/** ====== /upload-word ====== */
app.post("/upload-word", upload.single("file"), async (req, res) => {
  try {
    const result = await mammoth.extractRawText({ path: req.file.path });
    res.json({ text: result.value });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Word 解析失败" });
  } finally {
    // 上传临时文件用完即删，避免 uploads/ 无限堆积
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

/** ====== /upload-pdf ====== */
app.post("/upload-pdf", upload.single("file"), async (req, res) => {
  console.log("收到 PDF 上传请求");
  try {
    const scriptPath = path.join(__dirname, "pdf_extract.py");
    let pythonPath = process.env.PYTHON_PATH ||
      (fs.existsSync(path.join(__dirname, ".venv", "bin", "python"))
        ? path.join(__dirname, ".venv", "bin", "python") : "python3");

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const { execFile } = require("child_process");
      execFile(pythonPath, [scriptPath, req.file.path], { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

    const result = JSON.parse(stdout.trim());
    if (result.error) {
      return res.status(422).json({ error: result.error });
    }
    res.json({
      text: result.text,
      pages: Array.isArray(result.pages) ? result.pages : [],
      toc: Array.isArray(result.toc) ? result.toc : []
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "PDF 解析失败" });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// ====== 工具：清理 VTT 字幕，提取纯文本 ======
function cleanVTT(raw) {
  const lines = raw.split("\n");
  const result = [];
  let lastLine = "";

  for (const line of lines) {
    const t = line.trim();

    if (!t) continue;
    if (t.startsWith("WEBVTT")) continue;
    if (t.startsWith("Kind:")) continue;
    if (t.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}:\d{2}/.test(t)) continue;
    if (/^\d+$/.test(t)) continue;

    const clean = t.replace(/<[^>]+>/g, "").trim();
    if (!clean) continue;

    if (clean === lastLine) continue;
    lastLine = clean;

    result.push(clean);
  }

  const merged = [];
  for (let i = 0; i < result.length; i += 5) {
    merged.push(result.slice(i, i + 5).join(" "));
  }

  return merged.join("\n");
}

/** ====== /fetch-youtube ====== */
app.post("/fetch-youtube", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  function getYtDlpErrorMessage(err, stderr) {
    const detail = [err?.message, stderr].filter(Boolean).join("\n");
    const lower = detail.toLowerCase();

    if (err?.code === "ENOENT") {
      return "服务器缺少 yt-dlp 命令，请检查安装";
    }
    if (err?.killed || lower.includes("timed out")) {
      return "YouTube 字幕提取超时，请稍后重试";
    }
    if (
      lower.includes("sign in to confirm") ||
      lower.includes("not a bot") ||
      lower.includes("cookies") ||
      lower.includes("no longer valid") ||
      lower.includes("rotated")
    ) {
      return "YouTube 登录态失效，请重新上传 cookies.txt";
    }
    return "视频无可用英文字幕";
  }

  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
  const tmpBase = path.join(os.tmpdir(), `yt_sub_${Date.now()}`);
  const tmpFile = `${tmpBase}.en.vtt`;

  const args = [
    "--cookies", path.join(__dirname, "cookies.txt"),
    "--remote-components", "ejs:github",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", "en",
    "--print", "%(title)s",
    "--sub-format", "vtt",
    "--skip-download",
    "--output", tmpBase,
    url
  ];

  console.log("🎬 yt-dlp 开始提取字幕:", url);

  execFile(ytDlpPath, args, { timeout: 100000 }, (err, stdout, stderr) => {
    if (!fs.existsSync(tmpFile)) {
      if (err) console.error("yt-dlp error:", err);
      console.error("yt-dlp stderr:", stderr);
      return res.status(500).json({ error: getYtDlpErrorMessage(err, stderr) });
    }

    try {
      const raw = fs.readFileSync(tmpFile, "utf8");
      const text = cleanVTT(raw);

      try { fs.unlinkSync(tmpFile); } catch {}

      console.log("🎬 字幕提取成功，字符数:", text.length);
      // 合并段落内换行：单个换行合并掉，双换行保留为段落分隔
      const mergedText = text.replace(/([^\n])\n([^\n])/g, "$1$2").replace(/\n{3,}/g, "\n\n");
      const title = String(stdout || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || "";
      res.json({ text: mergedText, title });
    } catch (e) {
      res.status(500).json({ error: "字幕解析失败: " + e.message });
    }
  });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
attachStageWss(httpServer, `http:${PORT}`);
// HTTPS 直连
const http = require("http");
const https = require("https");
const tls = require("tls");
try {
  const sonaTlsOptions = {
    key: fs.readFileSync("/etc/letsencrypt/live/sona.solonova.top/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/sona.solonova.top/fullchain.pem"),
  };
  const travelTlsOptions = {
    key: fs.readFileSync("/etc/letsencrypt/live/travel.solonova.top/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/travel.solonova.top/fullchain.pem"),
  };
  const englishTlsOptions = {
    key: fs.readFileSync("/etc/letsencrypt/live/english.solonova.top/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/english.solonova.top/fullchain.pem"),
  };
  const siteTlsOptions = {
    "travel.solonova.top": travelTlsOptions,
    "english.solonova.top": englishTlsOptions,
  };
  const httpsOptions = {
    ...sonaTlsOptions,
    SNICallback(servername, callback) {
      const options = siteTlsOptions[servername] || sonaTlsOptions;
      callback(null, tls.createSecureContext(options));
    },
  };
  const httpsServer = https.createServer(httpsOptions, (req, res) => {
    const hostname = (req.headers.host || "").split(":", 1)[0].toLowerCase();
    if (hostname === "travel.solonova.top" || hostname === "english.solonova.top") {
      const proxyReq = http.request({
        hostname: "127.0.0.1",
        port: 8089,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: hostname },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on("error", (error) => {
        console.error(`${hostname} proxy error:`, error.message);
        if (!res.headersSent) res.writeHead(502);
        res.end("Bad Gateway");
      });
      req.pipe(proxyReq);
      return;
    }
    app(req, res);
  }).listen(443, "0.0.0.0", () => {
    console.log("HTTPS running for sona.solonova.top, travel.solonova.top, and english.solonova.top");
  });
  attachStageWss(httpsServer, "https:443");
  // 长耗时请求（如 yt-dlp 提取字幕）连接容易被中间网络节点当空闲连接回收，开启 TCP keepalive 降低概率
  httpsServer.on("connection", (socket) => {
    socket.setKeepAlive(true, 20000);
  });
} catch(e) {
  console.log("HTTPS 启动失败:", e.message);
}
