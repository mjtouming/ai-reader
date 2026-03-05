console.log("服务器版本：upload-word 已加载");

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const crypto = require("crypto");

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

// Node18+ 才有 global.fetch；低版本会是 undefined
const fetch = global.fetch;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

/** ====== 工具：运行 edge-tts 脚本并生成 mp3 ====== */
function runEdgeTTS({ inputText, voiceKey, outFile }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "tts_edge.py");

    // ✅ Python 路径：mac/linux
    let pythonPath =
  process.env.PYTHON_PATH ||
  (fs.existsSync(path.join(__dirname, ".venv", "bin", "python"))
    ? path.join(__dirname, ".venv", "bin", "python")
    : "python3");
    if (pythonPath.includes(path.join(__dirname, ".venv")) && !fs.existsSync(pythonPath)) {
  return reject(new Error("pythonPath not found: " + pythonPath));
}

    const p = spawn(
      pythonPath,
      [scriptPath, (voiceKey || "young_female"), outFile],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    // ✅ 把全文通过 stdin 喂给 python
    p.stdin.write(inputText, "utf8");
    p.stdin.end();

    p.on("error", (err) => {
      reject(new Error("spawn error: " + err.message));
    });

    p.on("close", (code) => {
      console.log("🐍 python exit code:", code);
      if (stdout.trim()) console.log("🐍 python stdout:\n" + stdout.trim());
      if (stderr.trim()) console.log("🐍 python stderr:\n" + stderr.trim());

      if (code === 0) return resolve();
      reject(new Error(`edge-tts failed (code ${code})`));
    });
  });
}

function createRewriteKey(text, mode) {
  return crypto
    .createHash("sha1")
    .update(text + "|" + mode)
    .digest("hex");
}

/** ====== /tts ====== */
app.post("/tts", async (req, res) => {
  const { text, mode, voice } = req.body;

try {

  let inputText = text || "";

  if (!inputText.trim()) {
    return res.status(400).json({ error: "text is empty" });
  }

    // 1) story / translate：用 OpenAI 做文本处理（保持你现有逻辑）
    if (mode === "story" || mode === "translate") {
      const cacheKey = createRewriteKey(inputText, mode);

      if (rewriteCache[cacheKey]) {
        console.log("⚡ rewrite cache hit");
        inputText = rewriteCache[cacheKey];
      } else {
        if (!fetch) {
          return res
            .status(500)
            .json({ error: "Node.js 版本过低：缺少内置 fetch。请升级到 Node 18+。" });
        }
        if (!process.env.OPENAI_API_KEY) {
          return res.status(500).json({ error: "缺少 OPENAI_API_KEY（请在 .env 里设置）" });
        }

        const systemPrompt =
          mode === "story"
            ? `你是一位成熟、克制、非常会讲故事的说书先生（深夜电台/茶馆风格）。你的任务：把用户文本改写成“更好听、更顺口、更像真人讲述”的版本。

        【硬性底线（必须遵守）】
           - 绝对保持原意，不新增事实、不虚构细节、不补剧情、不改时间地点人物关系。
           - 不做解释、不做分析、不总结，不输出任何提示语，只输出改写后的正文。
           - 不要每段都用同一种语气词开头（禁：每段都“哎/欸/嗯/你知道吗/其实”）。
           - 避免“播客开场白/欢迎收听/大家好”这类主持腔（除非原文就是这个）。

        【说书风格（可执行规则）】
           1) 口语化但不油：像面对面讲给一个听众，不用书面连接词堆砌（例如“因此、从而、综上”少用）。
           2) 节奏：短句为主，长句拆开；关键处用停顿符号制造呼吸感：——、……、换行。
           3) 画面感来自“措辞与节奏”，不是加新信息：允许把原文抽象词换成更具象的同义表达，但不增加事实。
           4) 轻幽默与轻点评：允许少量（每 200~400 字 1 次）短点评/感叹，用来带情绪，但不能抢戏、不能频繁。
              例如：“这事儿听着简单……真做起来未必。”/“说到这儿，你大概也能猜到后面不好收场。”
           5) 承上启下：如果段落是连续叙述，开头要接住上一段，不要像新故事重开。
              可用 6~16 字的承接句（少而精）：如“话说回来……”“说到这里……”“紧接着……”“再往下，就更关键了。”
           6) 开头策略：优先用“定位句”开场（时间/人物/场景/主题），不要用叹词硬开场。
              好例：“这段话讲的是……”“先从……说起。”/“事情的转折在这里。”
           7) 结尾策略：段尾留一点余味，但不总结，不升华，不做“所以我们要…”。

         【语言与格式】
            - 适合朗读：尽量避免连续生僻字堆、长串括号、复杂引用格式；必要的专有名词保留。
            - 每段控制在 2~5 句左右，必要时换行。
            - 可以保留原文的引号/对话，并把对话更口语、更顺口（不改变含义）。

         【输出】 
            只输出改写后的讲述正文。`
              : "把用户文本翻译成现代中文白话（如果是英文则翻译成中文）。要求：忠实原意，语言自然易懂，可朗读；不要添加新信息；不要解释；只输出翻译后的正文。";

        const temperature = mode === "story" ? 1.0 : 0.3;

        const rewriteResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: inputText },
            ],
            temperature,
          }),
        });

        if (!rewriteResponse.ok) {
          const errText = await rewriteResponse.text();
          throw new Error("OpenAI rewrite failed: " + errText);
        }

        const rewriteData = await rewriteResponse.json();
        inputText = rewriteData?.choices?.[0]?.message?.content?.trim() || inputText;

        rewriteCache[cacheKey] = inputText;

        fs.writeFileSync(
           rewriteCachePath,
           JSON.stringify(rewriteCache, null, 2)
        );

        // ⚠️ 先不写入 cache（下一步再加写入，避免你一次改太多）
      }
    }

    // ===== TTS cache key =====
  const ttsKey = crypto
    .createHash("sha1")
    .update(inputText + "|" + (voice || "young_female"))
    .digest("hex");

    // 2) edge-tts 生成 mp3
    const outDir = path.join(__dirname, "tts_cache");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, `tts_${ttsKey}.mp3`);

    console.log("🎧 TTS request:", { mode, voice, chars: inputText.length });

    // ===== TTS cache hit =====
if (fs.existsSync(outFile)) {

  console.log("⚡ TTS cache hit");

} else {

  await runEdgeTTS({
    inputText,
    voiceKey: voice || "young_female",
    outFile,
  });

}

    // 3) 确认文件存在
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      throw new Error("edge-tts did not produce output file or file is empty: " + outFile);
    }

    // 4) 返回音频流
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
    console.error("❌ /tts error:", error);
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
  }
});

/** ====== /upload-pdf ====== */
app.post("/upload-pdf", upload.single("file"), async (req, res) => {
  console.log("收到 PDF 上传请求");
  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(dataBuffer);
    res.json({ text: data.text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "PDF 解析失败" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});