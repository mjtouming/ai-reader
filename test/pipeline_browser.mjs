// 无头浏览器：mock /tts（改写 0.04s/字 + 合成 0.06s/字，成片 0.19s/字）。
// 时钟按 TIME_SCALE 压缩，比例不变。换算真实秒数 = 实测秒数 × TIME_SCALE。
//
//   node test/pipeline_browser.mjs [--assert] [--label before|after]
//
// PUBLIC_ROOT 指向要测的 public 目录（基线可指向一份拷贝）。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { BOOK_B_TEXT, buildLongText } from "./long_text.mjs";

const TIME_SCALE = 10;
const GEN_SEC_PER_CHAR = 0.04 + 0.06;
const PLAY_SEC_PER_CHAR = 0.19;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.PUBLIC_ROOT || path.join(HERE, "..", "public"));
const LABEL = (process.argv.find((a, i) => process.argv[i - 1] === "--label") ) || "run";
const ASSERT = process.argv.includes("--assert");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json"
};

function wavBuffer(seconds) {
  const sr = 8000;
  const dur = Math.max(0.05, seconds);
  const n = Math.max(1, Math.floor(sr * dur));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * 440 * i) / sr);
    data.writeInt16LE((s * 3000) | 0, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const serverLog = [];
let holdNew = false;
let slowAudio = false;
let seq = 0;
const held = new Map();
const audioFiles = new Map();

function releaseHeld(id) {
  const item = held.get(id);
  if (!item) return;
  held.delete(id);
  item.release();
}

// 把成片按接近播放速度吐出，模拟 160kbps 音频走一条差不多同样快的链路。
// 略快于实时（调用方传入约 0.85 倍成片时长），避免播放头追上缓冲。
async function writeThrottled(req, res, buffer, durationMs) {
  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
    "Accept-Ranges": "none"
  });
  if (!buffer.length) {
    res.end();
    return;
  }
  const slices = 20;
  const first = Math.min(buffer.length, Math.max(256, Math.ceil(buffer.length / slices)));
  res.write(buffer.subarray(0, first));
  let offset = first;
  const rest = Math.max(1, slices - 1);
  const stepMs = Math.max(5, Math.round(durationMs / rest));
  const sliceLen = Math.max(1, Math.ceil((buffer.length - offset) / rest));
  while (offset < buffer.length) {
    if (req.destroyed || res.writableEnded) return;
    await delay(stepMs);
    if (req.destroyed || res.writableEnded) return;
    const end = Math.min(buffer.length, offset + sliceLen);
    res.write(buffer.subarray(offset, end));
    offset = end;
  }
  if (!res.writableEnded) res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/__test/hold") {
      const body = await readBody(req);
      holdNew = !!body.hold;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ holdNew, held: [...held.keys()] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/__test/release") {
      await readBody(req);
      for (const id of [...held.keys()]) releaseHeld(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/__test/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        holdNew,
        held: [...held.values()].map(h => ({ id: h.id, chunkIndex: h.chunkIndex, voice: h.voice, textHead: h.textHead }))
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/__test/log") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serverLog));
      return;
    }
    if (req.method === "POST" && url.pathname === "/__test/slow") {
      const body = await readBody(req);
      slowAudio = !!body.slow;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ slowAudio }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/tts-audio/")) {
      const id = decodeURIComponent(url.pathname.slice("/tts-audio/".length));
      const item = audioFiles.get(id);
      if (!item) {
        res.writeHead(404);
        res.end();
        return;
      }
      await writeThrottled(req, res, item.audio, item.downloadMs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/tts") {
      const body = await readBody(req);
      const id = ++seq;
      const text = String(body.text || "");
      const chunkIndex = body.chunkIndex ?? null;
      const voice = body.voice || "";
      const mode = body.mode || "";
      const textHead = text.slice(0, 24);
      const genMs = Math.max(20, Math.round((text.length * GEN_SEC_PER_CHAR * 1000) / TIME_SCALE));
      const playSec = (text.length * PLAY_SEC_PER_CHAR) / TIME_SCALE;
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) ac.abort();
      };
      req.on("close", onClose);

      serverLog.push({
        kind: "start", id, t: Date.now(), chunkIndex, voice, mode,
        textLen: text.length, textHead,
        previous: body.previous ? String(body.previous).slice(0, 40) : null,
        skipRewrite: !!body.skipRewrite
      });

      try {
        if (holdNew) {
          await new Promise((resolve, reject) => {
            held.set(id, {
              id, chunkIndex, voice, textHead,
              release: resolve
            });
            const onAbort = () => {
              held.delete(id);
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (ac.signal.aborted) onAbort();
            else ac.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        await delay(genMs, ac.signal);
      } catch (e) {
        serverLog.push({ kind: "abort", id, t: Date.now(), chunkIndex, voice, textHead, reason: e.name });
        if (!res.writableEnded) res.end();
        return;
      }

      if (ac.signal.aborted || res.writableEnded) {
        serverLog.push({ kind: "abort", id, t: Date.now(), chunkIndex, voice, textHead, reason: "late" });
        return;
      }

      const rewritten = `〖改${chunkIndex}〗` + text.slice(0, 60);
      const audio = wavBuffer(playSec);
      const audioId = id.toString(16).padStart(40, "0");
      serverLog.push({
        kind: "end", id, t: Date.now(), chunkIndex, voice, mode,
        textLen: text.length, textHead, rewritten: rewritten.slice(0, 24), genMs,
        slow: slowAudio
      });
      if (slowAudio) {
        // 合成结束就返回改写稿和地址。MP3 另走 GET，并按接近实时的速度下。
        audioFiles.set(audioId, {
          audio,
          downloadMs: Math.max(30, Math.round(playSec * 1000 * 0.85))
        });
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": "0",
          "X-Rewritten-Text": encodeURIComponent(rewritten),
          "X-Audio-Url": `/tts-audio/${audioId}`,
          "Cache-Control": "no-store"
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": audio.length,
        "X-Rewritten-Text": encodeURIComponent(rewritten),
        "Cache-Control": "no-store"
      });
      // 快路径仍把整段放在 POST 正文里。不带 X-Audio-Url，客户端读完 blob 再播。
      res.end(audio);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(404);
      res.end();
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const full = path.normalize(path.join(ROOT, rel));
    const rootNorm = path.normalize(ROOT + path.sep);
    if (!full.startsWith(rootNorm) && full !== path.normalize(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404);
      res.end("not found " + rel);
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error("server error", e);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e.message || e));
  }
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
console.log(`mock server ${origin} root=${ROOT} scale=${TIME_SCALE} label=${LABEL}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu"
  ]
});

const context = await browser.createBrowserContext();
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", err => pageErrors.push(String(err)));
page.on("console", msg => {
  if (msg.type() === "error") pageErrors.push(msg.text());
});

await page.evaluateOnNewDocument(() => {
  localStorage.setItem("ai_reader_visited", "1");
  window.__trace = [];
  window.__urlMeta = new Map();

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const bodyText = init && typeof init.body === "string" ? init.body : "";
    let body = null;
    if (bodyText && url.includes("/tts")) {
      try { body = JSON.parse(bodyText); } catch {}
    }
    const base = body ? {
      chunkIndex: body.chunkIndex ?? null,
      voice: body.voice || null,
      mode: body.mode || null,
      previous: body.previous || null,
      textLen: body.text ? body.text.length : 0,
      textHead: body.text ? body.text.slice(0, 24) : "",
      skipRewrite: !!body.skipRewrite
    } : null;
    if (base) window.__trace.push({ kind: "req-start", t: performance.now(), wall: Date.now(), ...base });
    let res;
    try {
      res = await origFetch(input, init);
    } catch (e) {
      if (base) window.__trace.push({ kind: "req-abort", t: performance.now(), wall: Date.now(), error: e.name, ...base });
      throw e;
    }
    if (base && url.includes("/tts")) {
      let rewritten = null;
      try {
        const raw = res.headers.get("X-Rewritten-Text");
        rewritten = raw ? decodeURIComponent(raw) : null;
      } catch {}
      window.__trace.push({
        kind: "req-end",
        t: performance.now(),
        wall: Date.now(),
        status: res.status,
        rewrittenHead: rewritten ? rewritten.slice(0, 24) : null,
        ...base
      });
      const audioUrl = res.headers.get("X-Audio-Url");
      if (audioUrl) {
        const meta = {
          voice: base.voice,
          mode: base.mode,
          chunkIndex: base.chunkIndex,
          textHead: base.textHead,
          textLen: base.textLen,
          previousHead: base.previous ? String(base.previous).slice(0, 24) : null
        };
        try { window.__urlMeta.set(new URL(audioUrl, location.origin).href, meta); } catch {}
        window.__urlMeta.set(audioUrl, meta);
      }
      const origBlob = res.blob.bind(res);
      res.blob = async () => {
        const blob = await origBlob();
        blob.__meta = {
          voice: base.voice,
          mode: base.mode,
          chunkIndex: base.chunkIndex,
          textHead: base.textHead,
          textLen: base.textLen,
          previousHead: base.previous ? String(base.previous).slice(0, 24) : null
        };
        return blob;
      };
    }
    return res;
  };

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.call(URL, obj);
    if (obj && obj.__meta) window.__urlMeta.set(url, obj.__meta);
    return url;
  };

  const hookAudio = () => {
    const audio = document.getElementById("audioPlayer");
    if (!audio || audio.__hooked) return;
    audio.__hooked = true;
    const mark = (event) => {
      const src = audio.currentSrc || audio.src || "";
      const meta = window.__urlMeta.get(src) || null;
      window.__trace.push({
        kind: event,
        t: performance.now(),
        wall: Date.now(),
        status: document.getElementById("statusText")?.textContent || "",
        meta,
        paused: audio.paused,
        currentTime: audio.currentTime,
        duration: audio.duration
      });
    };
    audio.addEventListener("play", () => mark("play"));
    audio.addEventListener("ended", () => mark("ended"));
  };
  document.addEventListener("DOMContentLoaded", hookAudio);
  setInterval(hookAudio, 100);
});

function summarize(trace) {
  const plays = trace.filter(e => e.kind === "play");
  const endeds = trace.filter(e => e.kind === "ended");
  const starts = trace.filter(e => e.kind === "req-start");
  const gaps = [];
  for (let i = 0; i < plays.length - 1 && i < endeds.length; i++) {
    gaps.push({
      fromChunk: plays[i].meta?.chunkIndex ?? null,
      toChunk: plays[i + 1].meta?.chunkIndex ?? null,
      gapMs: Math.round(plays[i + 1].t - endeds[i].t),
      endedStatus: endeds[i].status,
      nextStatus: plays[i + 1].status
    });
  }
  return { plays: plays.length, endeds: endeds.length, starts: starts.length, gaps };
}

async function snapshot() {
  return page.evaluate(() => window.__trace.slice());
}

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  let lastPrint = 0;
  while (Date.now() - start < timeoutMs) {
    const trace = await snapshot();
    const status = await page.evaluate(() => document.getElementById("statusText")?.textContent || "");
    if (Date.now() - lastPrint > 8000) {
      lastPrint = Date.now();
      const s = summarize(trace);
      console.log(`  … ${label} plays=${s.plays} reqs=${s.starts} status=${status.slice(0, 40)}`);
    }
    if (pred(trace, status)) return trace;
    await new Promise(r => setTimeout(r, 150));
  }
  const trace = await snapshot();
  const status = await page.evaluate(() => document.getElementById("statusText")?.textContent || "");
  const err = new Error(`timeout: ${label}; status=${status}; ${JSON.stringify(summarize(trace))}`);
  err.trace = trace;
  throw err;
}

async function testState() {
  const res = await fetch(`${origin}/__test/state`);
  return res.json();
}

const longText = buildLongText();
const report = {
  label: LABEL,
  assert: ASSERT,
  timeScale: TIME_SCALE,
  genSecPerChar: GEN_SEC_PER_CHAR,
  playSecPerChar: PLAY_SEC_PER_CHAR,
  publicRoot: ROOT,
  textChars: longText.replace(/\s+/g, "").length,
  checks: {},
  errors: []
};

try {
  await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#generateBtn");
  await page.evaluate((text) => {
    document.getElementById("textInput").value = text;
    document.getElementById("modeSelect").value = "story";
    document.getElementById("voiceSelect").value = "elder_male";
    document.getElementById("speedSelect").value = "1";
  }, longText);

  console.log("click generate, waiting for 8 plays");
  await page.click("#generateBtn");

  const mainTrace = await waitFor(
    (trace) => trace.filter(e => e.kind === "play").length >= 8,
    360000,
    "8 plays"
  );

  const voiceMarkT = await page.evaluate(() => {
    const t = performance.now();
    window.__trace.push({ kind: "mark", name: "before-switch", t });
    return t;
  });

  report.main = analyzeMain(mainTrace, voiceMarkT);

  console.log("main chunks", report.main.rows.map(r => r.textLen).join(", "));
  console.log("gaps ms", report.main.gaps.map(g => g.gapMs).join(", "));
  console.log("duplicate keys", report.main.duplicateKeys.length);
} catch (e) {
  report.errors.push(String(e.stack || e));
  console.error(e);
}

function analyzeMain(trace, untilT) {
  const scoped = trace.filter(e => e.t <= untilT);
  const plays = scoped.filter(e => e.kind === "play" && e.meta?.chunkIndex);
  const endeds = scoped.filter(e => e.kind === "ended" && e.meta?.chunkIndex);
  const starts = scoped.filter(e => e.kind === "req-start");
  const first8 = plays.slice(0, 8);
  const rows = first8.map((p, i) => {
    const start = [...starts].reverse().find(s =>
      s.chunkIndex === p.meta?.chunkIndex && s.voice === p.meta?.voice && s.textHead === p.meta?.textHead
    ) || starts.find(s => s.chunkIndex === (p.meta?.chunkIndex ?? i + 1));
    const end = scoped.find(e =>
      e.kind === "req-end" && e.chunkIndex === start?.chunkIndex && e.textHead === start?.textHead && e.t >= (start?.t || 0)
    );
    return {
      chunkIndex: p.meta?.chunkIndex ?? null,
      textLen: p.meta?.textLen ?? start?.textLen ?? null,
      textHead: p.meta?.textHead || start?.textHead || "",
      voice: p.meta?.voice || null,
      mode: p.meta?.mode || null,
      previousHead: start?.previous ? String(start.previous).slice(0, 24) : null,
      reqStartMs: start ? Math.round(start.t) : null,
      reqEndMs: end ? Math.round(end.t) : null,
      playMs: Math.round(p.t)
    };
  });
  const gaps = [];
  for (let i = 0; i < 7 && i + 1 < plays.length; i++) {
    const ended = endeds.find(e => e.meta.chunkIndex === plays[i].meta.chunkIndex && e.t >= plays[i].t);
    if (!ended) continue;
    gaps.push({
      between: `${plays[i].meta.chunkIndex}→${plays[i + 1].meta.chunkIndex}`,
      gapMs: Math.round(plays[i + 1].t - ended.t)
    });
  }
  const counts = new Map();
  for (const s of starts) {
    const key = `${s.mode}|${s.voice}|${s.chunkIndex}|${s.textLen}|${s.textHead}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicateKeys = [...counts.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k, count: n }));
  const storyStarts = starts.filter(s => s.mode === "story" && s.chunkIndex >= 2);
  const missingPrevious = storyStarts.filter(s => !s.previous).map(s => s.chunkIndex);
  return { rows, gaps, duplicateKeys, missingPrevious, requestCount: starts.length, playCount: plays.length };
}

async function runCrosstalk() {
  const out = { voice: null, jump: null, book: null };

  // If the mistaken waitFor already jumped, just continue from current UI.
  await fetch(`${origin}/__test/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold: false })
  });
  await fetch(`${origin}/__test/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  await page.evaluate(() => {
    window.__trace.push({ kind: "mark", name: "voice", t: performance.now() });
  });
  await fetch(`${origin}/__test/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold: true })
  });

  const optionCount = await page.evaluate(() => document.querySelectorAll(".chunk-select option").length);
  // 跳到最后一段：正常预生成窗口到不了这里，一定会发新请求，方便按住它再切声线。
  const jumpTo = String(Math.max(0, optionCount - 1));
  console.log("jump to", jumpTo, "of", optionCount);
  await page.select(".chunk-select", jumpTo);

  const heldVoice = await waitHeld(h => h.voice === "elder_male", 20000, "held elder_male after jump");
  out.jumpHeld = heldVoice;

  await fetch(`${origin}/__test/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold: false })
  });
  await page.select("#voiceSelect", "young_female");

  const afterVoice = await waitFor(
    (trace) => {
      const mark = [...trace].reverse().find(e => e.kind === "mark" && e.name === "voice");
      if (!mark) return false;
      return trace.some(e => e.kind === "play" && e.t >= mark.t && e.meta && e.meta.voice === "young_female");
    },
    60000,
    "play after voice switch"
  );
  const vMark = [...afterVoice].reverse().find(e => e.kind === "mark" && e.name === "voice");
  const playsAfter = afterVoice.filter(e => e.kind === "play" && e.t >= vMark.t && e.meta?.chunkIndex);
  const abortsAfter = afterVoice.filter(e => e.kind === "req-abort" && e.t >= vMark.t);
  out.voice = {
    plays: playsAfter.slice(0, 3).map(p => ({ chunkIndex: p.meta?.chunkIndex, voice: p.meta?.voice, textHead: p.meta?.textHead })),
    oldVoicePlayed: playsAfter.some(p => p.meta && p.meta.voice === "elder_male"),
    aborts: abortsAfter.map(a => ({ chunkIndex: a.chunkIndex, voice: a.voice, textHead: a.textHead }))
  };
  console.log("voice plays", JSON.stringify(out.voice.plays), "oldPlayed", out.voice.oldVoicePlayed);

  // 换书：按住新书的 /tts，切回书架里的第一本，松开后新书的音频不能响。
  await page.evaluate(() => {
    window.__trace.push({ kind: "mark", name: "book", t: performance.now() });
  });
  await fetch(`${origin}/__test/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold: true })
  });
  await page.evaluate((text) => {
    document.getElementById("textInput").value = text;
  }, BOOK_B_TEXT);
  await page.click("#generateBtn");
  const heldBook = await waitHeld(h => (h.textHead || "").includes("城南旧事"), 20000, "held book B");
  out.bookHeld = heldBook;

  await fetch(`${origin}/__test/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold: false })
  });

  await page.click("#shelfBtn");
  await page.waitForSelector(".book-item");
  const titles = await page.evaluate(() => [...document.querySelectorAll(".book-title")].map(n => n.textContent));
  console.log("shelf", titles.join(" | "));
  // 新书 unshift 在最前，点第二本回到长文。
  await page.evaluate(() => {
    const items = document.querySelectorAll(".book-item");
    const target = items[1] || items[0];
    target.click();
  });
  await page.waitForFunction(() => (document.getElementById("statusText")?.textContent || "").includes("已切换"));
  await page.click("#playPauseBtn");

  const afterBook = await waitFor(
    (trace) => {
      const mark = [...trace].reverse().find(e => e.kind === "mark" && e.name === "book");
      if (!mark) return false;
      return trace.some(e => e.kind === "play" && e.t >= mark.t && e.meta);
    },
    60000,
    "play after book switch"
  );
  // 迟到的 B 书响应若没被取消，此时放行也不该被播。再等一小段让 abort 落地。
  await fetch(`${origin}/__test/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await new Promise(r => setTimeout(r, 800));
  const later = await snapshot();
  const bMark = [...later].reverse().find(e => e.kind === "mark" && e.name === "book");
  const bookPlays = later.filter(e => e.kind === "play" && e.t >= bMark.t && e.meta?.chunkIndex);
  out.book = {
    shelf: titles,
    plays: bookPlays.slice(0, 4).map(p => ({ chunkIndex: p.meta?.chunkIndex, voice: p.meta?.voice, textHead: p.meta?.textHead })),
    playedBookB: bookPlays.some(p => (p.meta?.textHead || "").includes("城南旧事"))
  };
  console.log("book plays", JSON.stringify(out.book.plays), "playedB", out.book.playedBookB);
  return out;
}

async function waitHeld(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await testState();
    const hit = st.held.find(pred);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 100));
  }
  const st = await testState();
  throw new Error(`timeout ${label}: held=${JSON.stringify(st.held)}`);
}

if (report.main && !report.crosstalk) {
  try {
    report.crosstalk = await runCrosstalk();
  } catch (e) {
    report.errors.push("crosstalk: " + (e.stack || e.message || e));
    console.error(e);
  }
}

if (!report.slow) {
  try {
    report.slow = await runSlow();
  } catch (e) {
    report.errors.push("slow: " + (e.stack || e.message || e));
    console.error(e);
  }
}

report.pageErrors = pageErrors.slice(0, 12);
report.serverAborts = serverLog.filter(e => e.kind === "abort").map(e => ({
  id: e.id, chunkIndex: e.chunkIndex, voice: e.voice, textHead: e.textHead, reason: e.reason
}));

const checks = {};
if (report.main) {
  checks.singleRequest = report.main.duplicateKeys.length === 0;
  checks.gapsNearZero = report.main.gaps.length >= 7 && report.main.gaps.every(g => g.gapMs < 500);
  checks.storyPrevious = report.main.rows.length >= 8
    && report.main.missingPrevious.length === 0
    && report.main.rows.slice(1, 8).every(r =>
      r.chunkIndex > 1 && r.previousHead && r.previousHead.startsWith(`〖改${r.chunkIndex - 1}〗`)
    );
  checks.grew = report.main.rows.length >= 8 && report.main.rows[3].textLen > report.main.rows[0].textLen * 1.4;
}
if (report.crosstalk?.voice) {
  checks.voiceNoCrosstalk = report.crosstalk.voice.oldVoicePlayed === false
    && report.crosstalk.voice.plays[0]?.voice === "young_female";
}
if (report.crosstalk?.book) {
  checks.bookNoCrosstalk = report.crosstalk.book.playedBookB === false
    && !(report.crosstalk.book.plays[0]?.textHead || "").includes("城南旧事");
}
if (report.slow) {
  const gaps = report.slow.gaps || [];
  const ready = report.slow.readyBeforeEnd || [];
  const lens = report.slow.lens || [];
  checks.slowNoWaits = gaps.length >= 4 && gaps.every(g => g.gapMs < 500);
  // 下一段的合成在本段播完前已经结束（地址就绪），所以段间不用再等生成。
  checks.slowPrefetch = ready.length >= 4
    && ready.every(r => r.nextStartedBeforeEnd && r.nextReadyBeforeEnd);
  // 窗口要走到播放前面：至少有两段在开播前，再下一段的请求已经发出。
  checks.slowAhead = ready.filter(r => r.nextStartedBeforePlay).length >= 2;
  checks.slowGrew = lens.length >= 4
    && lens[1] > lens[0] * 1.4
    && lens[3] > lens[0] * 1.5
    && lens[2] > lens[1];
}
report.checks = checks;

fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
const outPath = path.join(HERE, "results", `${LABEL}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log("wrote", outPath);
console.log("checks", checks);
console.log("errors", report.errors.length);

await browser.close();
server.close();

function tocFrontBook() {
  // 没有句读的目录行，大约 90 字一段。旧的段长会按实际字数越缩越短。
  const titles = ["佟家的奴才", "内务府的人", "南怀仁", "红票", "京城的雪", "孝庄", "议政", "西征", "漕运", "八旗"];
  const lines = [];
  for (let i = 0; i < 16; i++) {
    const n = String(i + 3).padStart(3, "0");
    const title = titles[i % titles.length];
    if (i === 4) {
      lines.push("战场上的俘虏·康熙母亲的娘家·孝庄的决定·消除奴籍");
    }
    lines.push("目录".repeat(40) + `${title}／${n}`);
  }
  lines.push("加小编QQ一起读书，海量资源每日更新");
  for (let n = 0; n < 80; n++) {
    lines.push(`第${n + 1}句：天色渐渐暗了下来，街上的灯一盏盏亮起。`);
  }
  return lines.join("\n\n");
}

function analyzeSlow(trace) {
  const mark = [...trace].reverse().find(e => e.kind === "mark" && e.name === "slow");
  const t0 = mark ? mark.t : 0;
  const scoped = trace.filter(e => e.t >= t0);
  const plays = scoped.filter(e => e.kind === "play" && e.meta?.chunkIndex);
  const endeds = scoped.filter(e => e.kind === "ended" && e.meta?.chunkIndex);
  const starts = scoped.filter(e => e.kind === "req-start");
  const ends = scoped.filter(e => e.kind === "req-end");
  const gaps = [];
  for (let i = 0; i < plays.length - 1; i++) {
    const ended = endeds.find(e => e.meta.chunkIndex === plays[i].meta.chunkIndex && e.t >= plays[i].t);
    if (!ended) continue;
    gaps.push({
      between: `${plays[i].meta.chunkIndex}→${plays[i + 1].meta.chunkIndex}`,
      gapMs: Math.round(plays[i + 1].t - ended.t)
    });
  }
  const readyBeforeEnd = [];
  for (let i = 0; i < plays.length - 1; i++) {
    const cur = plays[i].meta.chunkIndex;
    const ended = endeds.find(e => e.meta.chunkIndex === cur && e.t >= plays[i].t);
    const nextStart = starts.find(e => e.chunkIndex === cur + 1);
    const nextEnd = ends.find(e => e.chunkIndex === cur + 1);
    readyBeforeEnd.push({
      chunk: cur,
      nextStartedBeforeEnd: !!(nextStart && ended && nextStart.t < ended.t),
      nextReadyBeforeEnd: !!(nextEnd && ended && nextEnd.t <= ended.t + 80),
      nextStartedBeforePlay: !!(nextStart && nextStart.t < plays[i].t)
    });
  }
  return {
    lens: plays.slice(0, 6).map(p => p.meta.textLen),
    gaps,
    readyBeforeEnd,
    plays: plays.length
  };
}

async function runSlow() {
  await fetch(`${origin}/__test/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hold: false })
  });
  await fetch(`${origin}/__test/release`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await fetch(`${origin}/__test/slow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slow: true })
  });
  await page.evaluate(() => {
    window.__trace.push({ kind: "mark", name: "slow", t: performance.now() });
  });
  const text = tocFrontBook();
  await page.evaluate((value) => {
    document.getElementById("textInput").value = value;
    document.getElementById("modeSelect").value = "original";
    document.getElementById("voiceSelect").value = "young_female";
    document.getElementById("speedSelect").value = "1";
  }, text);
  console.log("slow-link generate, toc book");
  await page.click("#generateBtn");
  const trace = await waitFor(
    (tr) => {
      const mark = [...tr].reverse().find(e => e.kind === "mark" && e.name === "slow");
      if (!mark) return false;
      return tr.filter(e => e.kind === "play" && e.t >= mark.t && e.meta?.chunkIndex).length >= 5;
    },
    240000,
    "slow 5 plays"
  );
  const slow = analyzeSlow(trace);
  console.log("slow lens", slow.lens.join(", "));
  console.log("slow gaps", slow.gaps.map(g => g.gapMs).join(", "));
  console.log("slow ready", JSON.stringify(slow.readyBeforeEnd));
  return slow;
}

if (ASSERT) {
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length || report.errors.length) {
    console.error("ASSERT failed", failed, report.errors);
    process.exit(1);
  }
  console.log("ASSERT ok");
}
