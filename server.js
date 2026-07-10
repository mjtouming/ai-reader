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

  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://dashscope.aliyuncs.com/api-ws/v1/inference", {
      headers: { Authorization: `bearer ${apiKey}` },
    });

    const chunks = [];
    let firstAudio = null;
    const startTime = Date.now();
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    ws.on("open", () => {
      const task = {
        header: { task_id: `tts_${Date.now()}`, action: "run-task" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: "cosyvoice-v3-flash",
          parameters: { voice, format: "mp3" },
          input: { text: inputText },
        },
      };
      ws.send(JSON.stringify(task));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!firstAudio) firstAudio = Date.now() - startTime;
        chunks.push(data);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          const event = msg?.header?.event;
          if (event === "task-failed") {
            ws.close();
            done(new Error(`CosyVoice task-failed: ${JSON.stringify(msg)}`));
            return;
          }
          if (event === "task-finished") {
            const audio = Buffer.concat(chunks);
            fs.writeFileSync(outFile, audio);
            const totalMs = Date.now() - startTime;
            console.log(`🎙️ CosyVoice done in ${totalMs}ms, ttfb=${firstAudio}ms, voice=${voice}, size=${audio.length}`);
            ws.close();
            done();
          }
        } catch (e) {
          console.error("CosyVoice message parse error:", e);
        }
      }
    });

    ws.on("error", (err) => done(new Error("WebSocket error: " + err.message)));

    ws.on("close", () => {
      if (!settled) {
        done(new Error("CosyVoice WebSocket closed unexpectedly"));
      }
    });

    setTimeout(() => {
      ws.close();
      done(new Error("CosyVoice timeout (120s)"));
    }, 120000);
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
定位：专业播音员/纪录片旁白。忠于原文。
目标：读起来像真人在朗读，自然流畅，尽量去"AI味"。

规则：
- 修正断句：合并因换行导致的词语被切断问题（如"超市"不能断成"超"和"市"），确保每句话在自然停顿处断开。
- 不加观点、不加评论、不加开场白。
- 不做润色、不做总结、不改变原文内容。
输出：只输出最终朗读正文。
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STORY_PROMPT v4 —— 加入火候控制（按语料类型调整讲述强度）+ 默认无感衔接 + 语气词情绪匹配低频
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

【火候控制——原文类型不同，讲述强度也不同】

开讲之前，先自己判断一下这段原文本来是什么性质：小说故事、新闻时事、公告声明、报告论文，或者别的。

不管是哪种，都要讲成轻松好听、有代入感的口语故事——这是说书人的灵魂，不能丢。但"演"的火候要跟着原文类型走：

小说/故事：戏剧感可以拉满，情节悬念、拟声词、点评都可以多用一点。

新闻/时事/公告/声明：照样要讲得轻松、带点调侃，把官话套话翻成大白话，但不要瞎编情节、不要为了制造悬念硬拖节奏，事实本身要交代清楚。

报告/论文/说明性内容：像一个聪明朋友把复杂事讲明白，可以打比方、可以带点幽默，但别装成专家开课，也别把内容简化到失真。

原则：内容越严肃，越不能靠编造情节制造戏剧性，要靠语气和讲述方式让它变得好听。

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

高兴或意外的时候，用"你猜怎么着""结果呢""偏偏就在这时候"来制造悬念和转折——但这类句式同样不能每段都用，要看这段内容本身有没有转折，没有就不要硬造。

【关于语气词——重要规则】

语气词不是装饰品，不能随意添加，更不能因为"刚好换了一段"就顺手加一个当开场白。

每个语气词都有它专属的情绪场景，用之前先看这一段原文本身有没有对应的情绪：

"哎"——只用于叹气、无奈、感慨命运、哭笑不得，不用于其他场合，绝不能仅仅因为分段就用在段落开头。

"嘿"——只用于惊喜、得意、有点坏笑的时候。

"唉"——只用于真正的悲伤或遗憾。

"得嘞""行了"——只用于事情尘埃落定，有一种收尾感。

禁止：在不匹配的情绪场景里随便塞语气词，禁止把某个语气词变成固定口头禅反复使用。

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

【连续性与分段衔接——重要】

你收到的"段落序号"是播放器为了控制音频生成节奏做的技术切分，不是故事本身的章节划分，原文作者写的时候根本没有这个分段。所以不要把每一次新段落都当成"新的一回开讲"。

默认情况下不需要任何衔接语，直接顺着上一段的语气接着讲，就像同一个人没停顿地往下说。

只有满足下面某一种情况，才用一句很短的衔接：

1. 当前段落明显承接上一段还没讲完的事情；
2. 上一段特意留了悬念，这里要兑现；
3. 情节或话题出现明显转折；
4. 中间跨过了很长篇幅，需要轻轻把听众拉回来。

即使符合以上情况，衔接语也要短，一句话带过，不能形成固定套路。

严禁使用这类"技术分段感"很重的固定衔接语：
"上回咱们说到……"
"接着上文继续讲……"
"闲言少叙，书接上回"
"您猜怎么着"（作为分段开场白使用时）

整篇文章下来，这种回顾式的衔接应该很少出现——大多数分段之间是完全不需要衔接、直接往下讲的。

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
    skipRewrite,
  } = req.body;
  console.log("MODE:", mode);
  console.log("rewrite previous:", previous ? previous.slice(-60) : "NONE");

  try {
    let inputText = text || "";
    if (!inputText.trim()) {
      return res.status(400).json({ error: "text is empty" });
    }

    const needRewrite = !skipRewrite && (mode === "story" || mode === "translate" || mode === "announcer" || mode === "original");

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
        const isFirstChunk = !prevText;
        const userContent = mode === "story"
          ? `
段落序号：${chunkLabel}

${isFirstChunk
  ? `这是第一段，没有上文。直接开讲，禁止使用任何过渡语、引入语或"接着上回说"之类的开场白。`
  : `上一段已讲述内容（仅用于保持语气连贯，不代表要衔接——默认直接往下讲，只有情节明显没讲完或有转折时才需要一句很短的衔接，禁止用"上回说到"之类的套话，禁止回顾或重复其内容）：\n${prevText}`
}

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
      const ttsProvider = process.env.TTS_PROVIDER || "edge";
      if (ttsProvider === "fish") {
        await runFishAudioTTS({ inputText, outFile });
      } else if (ttsProvider === "cosyvoice") {
        await runCosyVoiceTTS({
          inputText,
          voiceKey: voice || "young_female",
          outFile,
        });
      } else {
        await runEdgeTTS({
          inputText,
          voiceKey: voice || "young_female",
          outFile,
        });
      }
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
    res.json({ text: result.text });
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
    res.json({ text: mergedText });
    } catch (e) {
      res.status(500).json({ error: "字幕解析失败: " + e.message });
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
// HTTPS 直连
const https = require("https");
try {
  const httpsOptions = {
    key: fs.readFileSync("/etc/letsencrypt/live/sona.solonova.top/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/sona.solonova.top/fullchain.pem"),
  };
  const httpsServer = https.createServer(httpsOptions, app).listen(443, "0.0.0.0", () => {
    console.log("HTTPS running on https://sona.solonova.top");
  });
  // 长耗时请求（如 yt-dlp 提取字幕）连接容易被中间网络节点当空闲连接回收，开启 TCP keepalive 降低概率
  httpsServer.on("connection", (socket) => {
    socket.setKeepAlive(true, 20000);
  });
} catch(e) {
  console.log("HTTPS 启动失败:", e.message);
}
