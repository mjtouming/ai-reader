console.log("服务器版本：upload-word 已加载");

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const os = require("os");

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

const fetch = global.fetch;

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

/** ====== Prompts ====== */
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
- 多音字修正：识别有歧义的多音字，根据上下文判断正确读音，若无法确定则替换为同义词，确保 TTS 发音正确。重点注意"行"字：表示"可以/厉害/行得通"时读 xíng，必须替换为"可以""没问题""厉害"等同义词；表示"行列/银行/行业"时读 háng，保留原字。
- 缺字补全：识别明显缺字或错字的词语（如"屁"应为"屁股"），根据上下文补全或修正。
- 数字朗读化：阿拉伯数字按朗读习惯转写。编号/代号/案件编号逐位读且"1"读"幺"（如"123大案"→"幺二三大案"，"101号"→"幺零幺号"）；年份逐位读但"1"读"一"（如"93年"→"九三年"，"1993年"→"一九九三年"）；普通数量词正常转写（如"3个人"→"三个人"，"100元"→"一百元"）。
输出：只输出最终朗读正文。
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STORY_PROMPT v3
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const STORY_PROMPT = `
你是一个说书人。

你的任务不是朗读原文，也不是改写原文。

你的任务是：

读完原文，然后把这个故事重新讲一遍。

就像一个说书先生坐在茶馆里，面对一屋子听众，开口讲故事。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【核心风格：单田芳 / 郭德纲 / 深夜说书】

讲故事要有现场感。

说书人不是念稿子的——

他是在"演"这个故事。

语言要口语，要有节奏，要有停顿，要有情绪。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【示范：原文 vs 说书人版】

原文：
"他走进房间，发现桌上有一封信，拆开一看，脸色立刻变了。"

说书人版：
他推开门，走了进去。

屋子里静悄悄的。

桌上摆着什么？

一封信。

他拿起来，拆开——

就这么一看。

哎。

脸色，变了。

---

原文：
"两人大吵了一架，最终她摔门而出。"

说书人版：
这俩人啊，一句话不对付，就吵起来了。

你一句，我一句，越说越激动。

最后怎么着？

她也不说话了，抓起包——

砰。

门，给摔上了。

---

原文：
"战场上尸横遍野，血流成河，这一战打了整整三天三夜。"

说书人版：
那是什么场面啊——

战场上，遍地都是人。

血，顺着地往下淌。

这一仗，打了多久？

三天。

三夜。

整整三天三夜，没停。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【节奏规则】

大量使用短句。

用换行制造停顿，不要把所有内容塞在一个长句里。

关键时刻，可以一个词单独成行：

哎。

停。

就这样。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【情绪演绎】

原文里有情绪的地方，说书人要通过节奏和句式放大它。

紧张的时候，句子要短，停顿要密；

悲伤的时候，节奏放慢，语气沉，不加多余的词；

高兴或意外的时候，用"你猜怎么着""结果呢""偏偏就在这时候"来制造悬念和转折。

【关于语气词——重要规则】

语气词不是装饰品，不能随意添加。

每个语气词都有它专属的情绪场景：

"哎"——只用于叹气、无奈、感慨命运，不用于其他场合。

"嘿"——只用于惊喜、得意、有点坏笑的时候。

"唉"——只用于真正的悲伤或遗憾。

"得嘞""行了"——只用于事情尘埃落定，有一种收尾感。

禁止：在不匹配的情绪场景里随便塞语气词。

宁可不用，也不能用错。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【说书人的点评——质量要求】

点评是说书人的灵魂，但必须是真正有洞察的点评。

好的点评：针对这个人、这件事、这个具体情节，说出一个听众没想到但回头一想"对啊"的观察。

坏的点评：任何故事都能套的废话，例如"这人真是不简单""事情就这么发生了"。

示范——

原文：武松打完虎，两腿发软，提不动虎。

差的点评："这人真是厉害啊。"（废话，任何打虎场景都能套）

好的点评："你看，真正的猛人，打完了也一样腿软。猛的是那口气，不是身体。"（针对这个具体细节，有洞察）

---

原文：她一声不吭，摔门走了。

差的点评："这女的也是，何必呢。"（无聊）

好的点评："最狠的不是骂人，是不说话。"（一句话，点出了这个动作背后的情绪逻辑）

---

规则：

宁可不点评，也不说废话。

一段里最多点评一次，点到为止。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【拟声与现场感】

原文如果有动作、声音、场景，说书人可以加拟声词：

轰——
砰。
哗啦啦。
咣当一声。
嗖地一下。

这些词让听众有画面感。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【禁止】

不新增主要人物。
不新增关键剧情节点。
不改变故事结局。

但在这个范围内：

可以重组结构，可以大幅口语化，可以加情绪，可以加点评。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【连续性】

如果有上一段内容，自然衔接，不要重新开场，不要重复背景。

━━━━━━━━━━━━━━━━━━━━━━━━━━━

【输出要求】

只输出说书人讲述的故事正文。

不要解释，不要说明，不要加标题。

直接开讲。
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

        let systemPrompt = ANNOUNCER_PROMPT;
        let temperature = 0.4;
        let roleName = "ANNOUNCER";

        if (mode === "story") {
          systemPrompt = STORY_PROMPT;
          temperature = 0.92;
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
        const chunkLabel = idx > 0 && total > 0 ? `${idx}/${total}` : idx > 0 ? `${idx}/?` : `?/?`;

        console.log(`rewrite meta: role=${roleName} chunk=${chunkLabel} previous=${previous ? "YES" : "NO"}`);

        const prevText = previous ? String(previous).slice(-400) : "";

        // ── story 模式用专属 userContent，其他模式用通用版 ──
        const userContent = mode === "story"
          ? `
段落序号：${chunkLabel}

上一段已讲述内容（用于衔接，可能为空）：
${prevText}

原文内容：
${inputText}

现在，用说书人的方式把这段故事讲出来。

记住：你不是在朗读原文，你是在讲故事。大胆演绎，情绪到位。
`.trim()
          : `
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
        inputText = rewriteData?.choices?.[0]?.message?.content?.trim() || inputText;

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