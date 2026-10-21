// 无头浏览器：书籍文件清洗后的「查看 / 恢复原文」，以及已在书架上的书不被重洗。
// 粘贴文本点生成时也不清洗。
//
//   node test/frontmatter_browser.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { cleanBookText } from "../public/bookCleaner.mjs";
import { SAMPLE_BOOK, SAMPLE_THREAT, THREAT_SENTENCE } from "./frontmatter_samples.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "public");
const CHROME = process.env.CHROME_PATH || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "/usr/local/bin/google-chrome");
const ARTIFACTS = process.env.ARTIFACTS || "/opt/cursor/artifacts";
fs.mkdirSync(ARTIFACTS, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function wavBuffer() {
  const data = Buffer.alloc(800);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
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
    const audio = wavBuffer();
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

const oldText = [
  SAMPLE_THREAT,
  "",
  "ISBN 978-7-00000-0-0",
  "版权所有 侵权必究"
].join("\n");
const oldChunks = ["第一段保持不动", "第二段保持不动", "第三段保持不动"];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--disable-gpu"]
});

const pageErrors = [];
async function arm(page) {
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", err => pageErrors.push(String(err)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("ai_reader_visited", "1");
  });
}

async function shot(page, name) {
  const file = path.join(ARTIFACTS, name);
  await page.screenshot({ path: file });
  return file;
}

async function waitForTts(fromIndex, pred, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = ttsLog.slice(fromIndex).some(pred);
    if (hit) return ttsLog.slice(fromIndex);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const seen = ttsLog.slice(fromIndex).map(text => text.slice(0, 48));
  throw new Error("等待分段生成超时: " + seen.join(" | "));
}

const expected = cleanBookText(SAMPLE_BOOK, { source: "txt" });
assert.equal(expected.changed, true);

{
  const page = await browser.newPage();
  await arm(page);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(async (payload) => {
    localStorage.setItem("ai_reader_session_v2", JSON.stringify(payload.session));
    localStorage.setItem("ai_reader_shelf_v2", JSON.stringify(payload.shelf));
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("ai_reader_audio_cache", 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio");
        if (!db.objectStoreNames.contains("texts")) db.createObjectStore("texts");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("texts", "readwrite");
        tx.objectStore("texts").put(payload.record, payload.session.refId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, {
    session: {
      refId: "oldbook",
      currentIndex: 2,
      maxReachedIndex: 2,
      currentTime: 0,
      mode: "original",
      voice: "young_female",
      speed: "1"
    },
    shelf: {
      currentBookId: "oldbook",
      books: [{
        id: "oldbook",
        title: "旧报告",
        textLength: oldText.length,
        totalChunks: 3,
        currentIndex: 2,
        maxReachedIndex: 2,
        mode: "original",
        voice: "young_female",
        speed: "1",
        addedAt: 1,
        updatedAt: 1
      }]
    },
    record: { text: oldText, chunks: oldChunks, fileName: "旧报告" }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.getElementById("statusText")?.textContent || "").includes("第 3/3"), { timeout: 8000 });

  const restored = await page.$eval("#textInput", el => el.value);
  assert.ok(restored.includes(THREAT_SENTENCE), "已存报告正文被改掉了");
  assert.ok(restored.includes("ISBN 978-7-00000-0-0"), "已存的书被重新清洗");
  assert.equal(await page.$$eval("#chunkNav option", nodes => nodes.length), 3);
  assert.equal(await page.$eval("#chunkNav select", el => el.selectedIndex), 2);
  assert.equal(await page.$eval("#frontMatterBar", el => el.hidden), true);

  await page.evaluate(async (content) => {
    const file = new File([content], "样书.txt", { type: "text/plain" });
    const input = document.getElementById("fileInput");
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, SAMPLE_BOOK);

  await page.waitForSelector("#frontMatterBar:not([hidden])", { timeout: 8000 });
  const shown = await page.$eval("#frontMatterCount", el => el.textContent.trim());
  assert.equal(shown, String(expected.removedChars));
  const cleanedValue = await page.$eval("#textInput", el => el.value);
  assert.equal(cleanedValue.includes("ISBN 978-7-5447-1234-5"), false);
  assert.ok(cleanedValue.includes("序言"));
  assert.ok(cleanedValue.includes("我写这本小说的时候"));

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert.equal(stored.includes("ISBN 978-7-5447-1234-5"), false, "原文进了 localStorage");
  assert.equal(stored.includes("我写这本小说的时候"), false, "正文进了 localStorage");

  const originalInDb = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("ai_reader_audio_cache");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction("texts", "readonly");
      const req = tx.objectStore("texts").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return rows.some(row => String(row?.text || "").includes("ISBN 978-7-5447-1234-5")
      && String(row?.text || "").includes("序言"));
  });
  assert.equal(originalInDb, true, "原文没有写进 IndexedDB");

  await page.$eval("#frontMatterBar", el => el.scrollIntoView({ block: "center" }));
  await shot(page, "frontmatter-banner-desktop.png");

  await page.setViewport({ width: 390, height: 844 });
  await page.$eval("#frontMatterBar", el => el.scrollIntoView({ block: "center" }));
  await shot(page, "frontmatter-banner-mobile.png");

  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.setViewport({ width: 1280, height: 900 });
  await page.$eval("#frontMatterBar", el => el.scrollIntoView({ block: "center" }));
  await shot(page, "frontmatter-banner-dark.png");

  const viewDebug = await page.evaluate(() => {
    const btn = document.getElementById("frontMatterView");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return {
      view: btn.textContent,
      previewHidden: document.getElementById("frontMatterPreview").hidden,
      barHidden: document.getElementById("frontMatterBar").hidden,
      previewText: document.getElementById("frontMatterPreviewBody").textContent.slice(0, 80)
    };
  });
  if (viewDebug.previewHidden) {
    throw new Error("查看没有打开预览 " + JSON.stringify(viewDebug));
  }
  const preview = await page.$eval("#frontMatterPreviewBody", el => el.textContent);
  assert.ok(preview.includes("ISBN 978-7-5447-1234-5"));
  assert.ok(preview.includes("目录"));
  assert.equal(preview.includes("我写这本小说的时候"), false, "预览把序言也当成删掉的内容");
  await page.$eval("#frontMatterPreview", el => el.scrollIntoView({ block: "center" }));
  await shot(page, "frontmatter-preview.png");

  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const beforeGenerate = ttsLog.length;
  await page.$eval("#generateBtn", el => el.click());
  const cleanedRequests = await waitForTts(beforeGenerate, text => text.includes("序言") || text.includes("我写这本小说的时候"));
  assert.equal(cleanedRequests.some(text => text.includes("ISBN 978-7-5447-1234-5")), false);

  const beforeRestore = ttsLog.length;
  await page.$eval("#frontMatterRestore", el => el.click());
  await page.waitForFunction(start => {
    const box = document.getElementById("textInput");
    return box && box.value.includes("ISBN 978-7-5447-1234-5");
  }, { timeout: 8000 });
  const restoreRequests = await waitForTts(beforeRestore, text => text.includes("ISBN 978-7-5447-1234-5"));

  const restoredText = await page.$eval("#textInput", el => el.value);
  assert.ok(restoredText.includes("ISBN 978-7-5447-1234-5"));
  assert.ok(restoredText.includes("版权所有 侵权必究"));
  assert.ok(restoredText.includes("序言"));
  assert.ok(restoredText.includes("我写这本小说的时候"));
  assert.ok(restoredText.includes("1. 先把灯点着"));
  assert.equal(await page.$eval("#frontMatterBar", el => el.hidden), true);
  const options = await page.$$eval("#chunkNav option", nodes => nodes.length);
  assert.ok(options > 0, "恢复后没有重新分段");
  assert.ok(restoreRequests.length > 0, "恢复后没有按原文重新生成");
  await page.$eval("#textInput", el => el.scrollIntoView({ block: "center" }));
  await shot(page, "frontmatter-restored.png");
  await page.close();
}

{
  const page = await browser.newPage();
  await arm(page);
  await page.setViewport({ width: 1280, height: 900 });
  ttsLog.length = 0;
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    localStorage.setItem("ai_reader_visited", "1");
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(async (content) => {
    document.getElementById("textInput").value = content;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("ai_reader_audio_cache");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (db.objectStoreNames.contains("audio")) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("audio", "readwrite");
        tx.objectStore("audio").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }, SAMPLE_BOOK);
  const beforePaste = ttsLog.length;
  await page.$eval("#generateBtn", el => el.click());
  await waitForTts(beforePaste, text => text.includes("ISBN 978-7-5447-1234-5"));
  assert.equal(await page.$eval("#frontMatterBar", el => el.hidden), true);
  await page.close();
}

await browser.close();
await new Promise(resolve => server.close(resolve));

const realErrors = pageErrors.filter(line => !/Failed to load resource/i.test(line) && !/fonts\.google/i.test(line));
assert.deepEqual(realErrors, [], realErrors.join("\n"));
console.log("frontmatter_browser: ok");
console.log("screenshots:", fs.readdirSync(ARTIFACTS).filter(name => name.startsWith("frontmatter-")).join(", "));
