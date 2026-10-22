// 正文框：聚焦清空、失焦恢复、粘贴保留，以及播放中聚焦不打断播放。
//
//   node test/text_input_browser.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "public");
const CHROME = process.env.CHROME_PATH || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");

const PLAYING = "今天把这一小段放进播放器，用来确认点输入框时声音还在继续。";
const PASTED = "这是刚粘贴进来的另一篇文章，不该把正在播放的声音停掉。";
const FILE_TEXT = "文件载入的正文应当留在框里。山坡上有一间小屋，门是开着的。";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function wavBuffer(seconds) {
  const sr = 8000;
  const n = Math.max(1, Math.floor(sr * seconds));
  const data = Buffer.alloc(n * 2);
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

const ttsLog = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/tts") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    ttsLog.push(String(body.text || ""));
    const audio = wavBuffer(15);
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": audio.length,
      "X-Rewritten-Text": encodeURIComponent("改写")
    });
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
  if (!full.startsWith(path.normalize(ROOT + path.sep)) && full !== path.normalize(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(full).pipe(res);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--disable-gpu"]
});

const pageErrors = [];

async function openPage() {
  const page = await browser.newPage();
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", err => pageErrors.push(err?.stack || String(err)));
  await page.evaluateOnNewDocument(() => {
    // 新文档刚起来时（例如 about:blank）读 localStorage 会抛 SecurityError。
    try {
      localStorage.clear();
      localStorage.setItem("ai_reader_visited", "1");
    } catch {}
  });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#textInput");
  return page;
}

async function readState(page) {
  return page.evaluate(async () => {
    const audio = document.getElementById("audioPlayer");
    const session = JSON.parse(localStorage.getItem("ai_reader_session_v2") || "null");
    const shelf = JSON.parse(localStorage.getItem("ai_reader_shelf_v2") || "null");
    const texts = await new Promise((resolve, reject) => {
      const req = indexedDB.open("ai_reader_audio_cache");
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("texts")) {
          resolve([]);
          return;
        }
        const tx = db.transaction("texts", "readonly");
        const all = tx.objectStore("texts").getAll();
        all.onsuccess = () => resolve(all.result || []);
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
    const book = shelf?.books?.[0] || null;
    return {
      value: document.getElementById("textInput").value,
      paused: !!audio?.paused,
      currentTime: audio?.currentTime || 0,
      src: audio?.currentSrc || audio?.src || "",
      status: document.getElementById("statusText")?.textContent || "",
      title: document.getElementById("nowPlayingTitle")?.textContent || "",
      chunk: document.querySelector("#chunkNav select")?.selectedIndex ?? null,
      chunkCount: document.querySelectorAll("#chunkNav option").length,
      sessionRef: session?.refId || null,
      sessionIndex: session?.currentIndex ?? null,
      book: book ? {
        id: book.id,
        title: book.title,
        textLength: book.textLength,
        totalChunks: book.totalChunks,
        currentIndex: book.currentIndex
      } : null,
      storedTexts: texts.map(row => String(row?.text || "")),
      lockTitle: navigator.mediaSession?.metadata?.title || ""
    };
  });
}

function assertStillPlaying(state, before, label) {
  assert.equal(state.paused, false, label + "：播放被暂停");
  assert.ok(state.src && state.src === before.src, label + "：音频地址变了");
  assert.ok(state.currentTime + 0.05 >= before.currentTime, label + "：进度被倒回");
  assert.equal(state.chunk, before.chunk, label + "：段落变了");
  assert.equal(state.chunkCount, before.chunkCount, label + "：分段变了");
  assert.equal(state.sessionRef, before.sessionRef, label + "：会话被改写");
  assert.equal(state.sessionIndex, before.sessionIndex, label + "：会话进度变了");
  assert.deepEqual(state.book, before.book, label + "：书架变了");
  assert.ok(state.status.includes("播放"), label + "：状态变成「" + state.status + "」");
  assert.equal(state.storedTexts.some(text => text.trim() === ""), false, label + "：空正文被写进本地库");
  assert.ok(state.storedTexts.some(text => text.includes(PLAYING.slice(0, 8))), label + "：原文从本地库消失");
  if (state.lockTitle) assert.equal(state.lockTitle, "灵听", label + "：锁屏标题变了");
}

async function focusBox(page) {
  await page.$eval("#textInput", el => el.scrollIntoView({ block: "center" }));
  await page.click("#textInput");
}

async function pasteInto(page, text) {
  await page.evaluate((value) => {
    const el = document.getElementById("textInput");
    const data = new DataTransfer();
    data.setData("text/plain", value);
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    });
    el.dispatchEvent(paste);
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    el.setRangeText(value, start, end, "end");
    el.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
      data: value
    }));
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertFromPaste",
      data: value
    }));
  }, text);
}

{
  const page = await openPage();
  ttsLog.length = 0;
  await page.$eval("#textInput", (el, text) => { el.value = text; }, PLAYING);
  await page.click("#generateBtn");
  await page.waitForFunction(() => {
    const audio = document.getElementById("audioPlayer");
    const status = document.getElementById("statusText")?.textContent || "";
    return audio && !audio.paused && audio.currentTime > 0.2 && status.includes("播放");
  }, { timeout: 15000 });

  const started = await readState(page);
  assert.equal(started.value, PLAYING);
  assert.equal(started.chunkCount, 1);
  assert.ok(started.sessionRef, "播放开始后没有会话");
  assert.ok(started.book, "播放开始后没有进书架");
  assert.equal(ttsLog.length, 1, "起播不应该为这一小段发多次合成");
  const ttsAtPlay = ttsLog.length;

  await focusBox(page);
  assert.equal(await page.$eval("#textInput", el => el.value), "", "聚焦后没有清空");

  await page.evaluate((text) => {
    document.getElementById("textInput").value = text;
  }, PLAYING);
  await page.waitForFunction(() => document.getElementById("textInput").value === "", { timeout: 1000 });

  const cleared = await readState(page);
  assert.equal(cleared.value, "");
  assertStillPlaying(cleared, started, "聚焦清空时");
  assert.equal(ttsLog.length, ttsAtPlay, "聚焦触发了新的合成");

  await new Promise(resolve => setTimeout(resolve, 2500));
  const whileCleared = await readState(page);
  assert.equal(whileCleared.value, "");
  assertStillPlaying(whileCleared, started, "清空期间自动保存");
  assert.ok(whileCleared.currentTime > cleared.currentTime + 0.4, "清空期间播放没有继续走");
  assert.equal(ttsLog.length, ttsAtPlay, "清空期间触发了新的合成");

  await page.evaluate(() => document.getElementById("textInput").blur());
  const restored = await readState(page);
  assert.equal(restored.value, PLAYING, "没有输入就失焦，原文没有回来");
  assertStillPlaying(restored, started, "失焦恢复后");

  await focusBox(page);
  assert.equal(await page.$eval("#textInput", el => el.value), "");
  await pasteInto(page, PASTED);
  await page.evaluate(() => document.getElementById("textInput").blur());
  const pasted = await readState(page);
  assert.equal(pasted.value, PASTED, "粘贴后的新内容没有留下");
  assert.equal(pasted.paused, false, "粘贴后播放被暂停");
  assert.equal(pasted.src, started.src, "粘贴后音频被换掉");
  assert.equal(pasted.chunk, started.chunk, "粘贴后段落变了");
  assert.deepEqual(pasted.book, started.book, "粘贴后书架被改写");
  assert.equal(ttsLog.length, ttsAtPlay, "粘贴触发了新的合成");
  assert.ok(pasted.status.includes("播放"), "粘贴后不再是播放状态");
  await page.close();
}

{
  const page = await openPage();
  await page.$eval("#textInput", el => { el.value = ""; });
  await focusBox(page);
  assert.equal(await page.$eval("#textInput", el => el.value), "", "空框聚焦被改写");
  await page.evaluate(() => document.getElementById("textInput").blur());
  assert.equal(await page.$eval("#textInput", el => el.value), "");

  await page.$eval("#textInput", (el, text) => { el.value = text; }, "组字前的原文");
  await focusBox(page);
  assert.equal(await page.$eval("#textInput", el => el.value), "");
  await page.evaluate(() => {
    const el = document.getElementById("textInput");
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    el.blur();
  });
  assert.equal(await page.$eval("#textInput", el => el.value), "组字前的原文", "取消组字后没有恢复原文");

  await focusBox(page);
  await page.evaluate(() => {
    const el = document.getElementById("textInput");
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    el.value = "你好";
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "你好"
    }));
    el.blur();
  });
  assert.equal(await page.$eval("#textInput", el => el.value), "你好", "组字确认后的文字没有留下");

  await page.$eval("#textInput", (el, text) => { el.value = text; }, "旧内容还在这里");
  await focusBox(page);
  assert.equal(await page.$eval("#textInput", el => el.value), "");
  await page.evaluate((content) => {
    const file = new File([content], "新书.txt", { type: "text/plain" });
    const input = document.getElementById("fileInput");
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, FILE_TEXT);
  await page.waitForFunction(() => {
    const value = document.getElementById("textInput").value || "";
    return value.includes("文件载入的正文应当留在框里");
  }, { timeout: 8000 });
  await page.evaluate(() => document.getElementById("textInput").blur());
  const afterFile = await page.$eval("#textInput", el => el.value);
  assert.ok(afterFile.includes("文件载入的正文应当留在框里"), "载入文件后的正文丢了");
  assert.equal(afterFile.includes("旧内容还在这里"), false, "失焦把聚焦前的旧正文盖了回来");
  await page.close();
}

await browser.close();
await new Promise(resolve => server.close(resolve));

const realErrors = pageErrors.filter(line => !/Failed to load resource/i.test(line) && !/fonts\.google/i.test(line) && !/WebSocket/i.test(line));
assert.deepEqual(realErrors, [], realErrors.join("\n"));
console.log("text_input_browser: ok");
