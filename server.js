console.log("服务器版本：upload-word 已加载");

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process"); // ✅ 新增 execFile
const crypto = require("crypto");
const os = require("os"); // ✅ 新增 os

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
// ===== 静态文件 =====
const publicPath = path.join(__dirname, "public");

console.log("Static path:", publicPath);

app.use(express.static(publicPath));

// Railway 有时会把根路由交给 server，需要手动返回 index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

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

/** ====== Prompt（v1） ====== */
const COMMON_RULES = `
你是"用于朗读的文本编辑器"，不是聊天机器人。
必须遵守：
1) 只输出最终可朗读正文，禁止解释、禁止列规则、禁止自我评价、禁止任何前后缀。
2) 不得编造事实：不添加原文没有的新人物/新事件/新数据/新因果。
3) 朗读友好：尽量短句、自然停顿、去掉网页口吻（如"点击这里/如上图/见链接"）。
4) 连续性：如果提供了上一段内容，必须承接；禁止每段都重新开场/重复标题/重复背景。
5) 遇到病句/不通顺：允许小幅改写让其顺畅，但不得改变原意。
6) 输入为古文/外文：先翻译成现代中文，再做朗读化处理。
7) 专有名词与数字：尽量朗读化（日期/百分比/单位更自然）。
`;

const ANNOUNCER_PROMPT = `
${COMMON_RULES}

【角色：播音员】
定位：专业播音员/纪录片旁白。忠于原文、克制、不点评、不玩梗。
目标：读起来像真人在朗读，顺、稳、自然，尽量去"AI味"。

规则：
- 不加观点、不加评论、不加笑点、不加"主持人开场白"（禁：大家好/欢迎收听/今天我们来聊）。
- 允许轻量润色：拆长句、调语序、补必要主语，使更顺口。
- 不做额外总结；除非原文在总结。
输出：只输出最终朗读正文。
`;

const STORY_PROMPT = `
${COMMON_RULES}

你是一位专业说书人。

你的任务不是改写原文。

而是：

阅读下面的小说内容，
然后用"说书人"的方式，
重新讲一遍这个故事。

目标：

让听众感觉
有人在现场讲故事。

而不是在朗读文字。

------------------------------------------------

【允许】

可以：

- 重组句子
- 大幅口语化
- 增加停顿
- 加入讲述语气
- 加入轻微调侃
- 加入简短点评

只要：

人物不变  
事件不变  
剧情顺序不变  

即可。

------------------------------------------------

【说书风格】

语言要：

口语化  
有节奏  
有停顿  

鼓励使用：

短句。

例如：

那天晚上。

事情有点不对劲。

屋子里很安静。

安静得——

连风声都听得见。

------------------------------------------------

【说书表达】

允许出现：

要说这事  
你再看  
事情到了这一步  
结果呢  
这就有意思了  

------------------------------------------------

【禁止】

不要新增人物  
不要新增关键剧情  
不要改变结局  

------------------------------------------------

【连续性】

如果提供 previous_text：

自然衔接。

不要重新开场。

------------------------------------------------

【输出】

只输出讲述后的故事。

不要解释。
不要说明。
直接讲故事。
`;

const STORY_PROMPT_BACKUP = `
${COMMON_RULES}

【角色】

你是一位职业说书人。

讲故事的风格参考：

中国传统评书  
单口相声讲故事  
茶馆说书  

讲述气质类似：

郭德纲讲长篇故事  
袁阔成评书  
单口相声讲故事

目标：

让听众感觉 **有人在现场讲故事**。

而不是在朗读文字。

------------------------------------------------

【核心原则】

不要逐句改写原文。

而是：

读完原文后，
用说书人的方式 **重新讲一遍这个故事**。

允许：

- 重组结构
- 改写句子
- 简化描述
- 口语化
- 加入说书人表达
- 加入轻松评论
- 加入调侃

只要保持：

- 人物不变
- 事件不变
- 结果不变

即可。

------------------------------------------------

【说书节奏】

必须大量使用：

短句。

停顿。

自然口语。

示例节奏：

那天晚上。

事情啊。

有点不对劲。

屋子里很安静。

安静到什么程度？

你要是站在那儿——

连自己呼吸声都听得见。

------------------------------------------------

【允许加入的内容】

说书人可以加入：

轻点评  
轻调侃  
轻吐槽  

例如：

"这事要是换了别人，估计早就慌了。"

"你说这人胆子也是真不小。"

"事情啊，就从这儿开始变味了。"

但注意：

评论必须短。

不能长篇说教。

------------------------------------------------

【口语化表达】

鼓励使用：

要说这事  
你再看  
事情到了这一步  
有意思的是  
结果呢  
可问题来了  

这些都是说书人常见表达。

------------------------------------------------

【禁止】

不要：

新增人物  
新增关键剧情  
改变故事结局  

------------------------------------------------

【连续性】

如果存在 previous_text：

要自然衔接。

不要重新开场。

------------------------------------------------

【输出】

只输出讲述后的故事。

不要解释。

不要说明你在改写。

直接讲。
`;

const TRANSLATE_PROMPT = `
${COMMON_RULES}

【角色：翻译】
任务：把原文翻译成自然的现代中文白话，适合朗读。
- 古文：翻译成现代中文，尽量顺口，不要学术腔。
- 外文：翻译成自然中文。
输出：只输出翻译后的中文正文。
`;

// ====== /tts ======
app.post("/tts", async (req, res) => {
  // 【新增】：chunkIndex / totalChunks 为可选字段（前端不传也不影响）
  const {
    text,
    mode,
    voice,
    previous,
    chunkIndex,
    totalChunks,
  } = req.body;
  console.log("MODE:", mode);

  console.log("rewrite previous:", previous ? previous.slice(-60) : "NONE");

  try {
    let inputText = text || "";
    if (!inputText.trim()) {
      return res.status(400).json({ error: "text is empty" });
    }

    // 1) 文本处理（rewrite/translate）
    const needRewrite = mode === "story" || mode === "translate" || mode === "announcer" || mode === "original";

    if (needRewrite) {
      const cacheKey = createRewriteKey(inputText, mode || "announcer");

      if (rewriteCache[cacheKey]) {
        console.log("⚡ rewrite cache hit");
        inputText = rewriteCache[cacheKey];
      } else {
        if (!fetch) {
          return res.status(500).json({
            error: "Node.js 版本过低：缺少内置 fetch。请升级到 Node 18+。",
          });
        }

        if (!process.env.OPENAI_API_KEY) {
          return res
            .status(500)
            .json({ error: "缺少 OPENAI_API_KEY（请在 .env 里设置）" });
        }

        // 选择 prompt
        let systemPrompt = ANNOUNCER_PROMPT;
        let temperature = 0.4;
        let roleName = "ANNOUNCER";

        if (mode === "story") {
          systemPrompt = STORY_PROMPT;
          temperature = 0.9;
          roleName = "STORYTELLER";
        } else if (mode === "translate") {
          systemPrompt = TRANSLATE_PROMPT;
          temperature = 0.2;
          roleName = "TRANSLATE";
        } else {
          systemPrompt = ANNOUNCER_PROMPT;
          temperature = 0.4;
          roleName = "ANNOUNCER";
        }

        const idx = Number.isFinite(Number(chunkIndex)) ? Number(chunkIndex) : 0;
        const total = Number.isFinite(Number(totalChunks)) ? Number(totalChunks) : 0;

        const chunkLabel =
          idx > 0 && total > 0 ? `${idx}/${total}` : idx > 0 ? `${idx}/?` : `?/?`;

        console.log(
          `rewrite meta: role=${roleName} chunk=${chunkLabel} previous=${previous ? "YES" : "NO"}`
        );

        const prevText = previous ? String(previous).slice(-400) : "";
        const userContent = `
角色：${roleName}
段落序号：${chunkLabel}

上一段已朗读文本（可能为空）：
${prevText}

当前待处理原文：
${inputText}

要求：
- 严格遵守角色规则
- 忠于事实，不新增事实
- 输出只能是最终可朗读正文
`.trim();

        const rewriteResponse = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent },
              ],
              temperature,
            }),
          }
        );

        if (!rewriteResponse.ok) {
          const errText = await rewriteResponse.text();
          throw new Error("OpenAI rewrite failed: " + errText);
        }

        const rewriteData = await rewriteResponse.json();
        inputText =
          rewriteData?.choices?.[0]?.message?.content?.trim() || inputText;

        rewriteCache[cacheKey] = inputText;
        fs.writeFileSync(rewriteCachePath, JSON.stringify(rewriteCache, null, 2));
      }
    }

    // ===== TTS cache key =====
    const ttsKey = crypto
      .createHash("sha1")
      .update(inputText + "|" + (voice || "young_female"))
      .digest("hex");

    const outDir = path.join(__dirname, "tts_cache");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, `tts_${ttsKey}.mp3`);

    console.log("🎧 TTS request:", { mode, voice, chars: inputText.length });

    // ===== TTS cache 检查 =====
    let needGenerate = true;

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
      await runEdgeTTS({
        inputText,
        voiceKey: voice || "young_female",
        outFile,
      });
    }

    if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
      throw new Error("edge-tts did not produce output file or file is empty: " + outFile);
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-Rewritten-Text", encodeURIComponent(inputText));

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
    res.status(500).json({
      error: String(error?.message || error),
    });
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

// ====== 工具：清理 VTT 字幕，提取纯文本 ======
function cleanVTT(raw) {
  const lines = raw.split("\n");
  const result = [];
  let lastLine = "";

  for (const line of lines) {
    const t = line.trim();

    // 跳过头部、时间戳、空行、元信息
    if (!t) continue;
    if (t.startsWith("WEBVTT")) continue;
    if (t.startsWith("Kind:")) continue;
    if (t.startsWith("Language:")) continue;
    if (/^\d{2}:\d{2}:\d{2}/.test(t)) continue; // 时间戳行
    if (/^\d+$/.test(t)) continue;               // 纯数字序号

    // 去掉 HTML 标签（如 <c> <b> 等）
    const clean = t.replace(/<[^>]+>/g, "").trim();
    if (!clean) continue;

    // 去掉重复行（VTT 里同一句话常出现两次）
    if (clean === lastLine) continue;
    lastLine = clean;

    result.push(clean);
  }

  // 每 5 句合并成一行，形成自然段落
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

  const ytDlpPath = process.env.YTDLP_PATH || "yt-dlp";
  const tmpBase = path.join(os.tmpdir(), `yt_sub_${Date.now()}`);
  const tmpFile = `${tmpBase}.en.vtt`;

  const args = [
    "--cookies", path.join(__dirname, "cookies.txt"),
    "--remote-components", "ejs:github",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", "en",
    "--sub-format", "vtt",
    "--skip-download",
    "--output", tmpBase,
    url
  ];

  console.log("🎬 yt-dlp 开始提取字幕:", url);

  execFile(ytDlpPath, args, { timeout: 60000 }, (err, stdout, stderr) => {
    if (!fs.existsSync(tmpFile)) {
      console.error("yt-dlp stderr:", stderr);
      return res.status(500).json({ error: "字幕文件未生成，该视频可能没有英文字幕，或需要登录" });
    }

    try {
      const raw = fs.readFileSync(tmpFile, "utf8");
      const text = cleanVTT(raw);

      // 清理临时文件
      try { fs.unlinkSync(tmpFile); } catch {}

      console.log("🎬 字幕提取成功，字符数:", text.length);
      res.json({ text });
    } catch (e) {
      res.status(500).json({ error: "字幕解析失败: " + e.message });
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});