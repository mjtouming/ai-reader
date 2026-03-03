console.log("服务器版本：upload-word 已加载");

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Node18+ 才有 global.fetch；低版本会是 undefined
const fetch = global.fetch;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
      if (!fetch) {
        // 你如果是 Node < 18，这里会提醒你升级
        return res.status(500).json({ error: "Node.js 版本过低：缺少内置 fetch。请升级到 Node 18+。" });
      }
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: "缺少 OPENAI_API_KEY（请在 .env 里设置）" });
      }

      const systemPrompt =
        mode === "story"
          ? "你是一位温暖、有点幽默感的播客主持人，把文本改写成更有“人味”的讲述：更口语化、更有趣、适当语气词、自然停顿（——、……、换行），句子更短。保持原意，不添加新信息，不要解释，只输出讲述版文本。"
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
    }

    // 2) edge-tts 生成 mp3
    const outDir = path.join(__dirname, "tts_cache");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(
      outDir,
      `tts_${Date.now()}_${Math.random().toString(16).slice(2)}.mp3`
    );

    console.log("✅ EDGE /tts hit:", { mode, voice, chars: inputText.length });

    await runEdgeTTS({
      inputText,
      voiceKey: voice || "young_female",
      outFile,
    });

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

    res.on("finish", () => {
      fs.unlink(outFile, () => {});
    });
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

/** ====== /fetch-url ====== */
app.post("/fetch-url", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "缺少 URL" });

    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(response.data);

    let text = "";
    $("p").each((i, el) => {
      text += $(el).text() + "\n";
    });

    if (!text.trim()) text = $("body").text();

    res.json({ text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "网页抓取失败" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});