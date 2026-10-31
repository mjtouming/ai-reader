import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.PUBLIC_ROOT || path.join(HERE, "..", "public"));
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function wavBuffer() {
  const sampleRate = 8000;
  const samples = sampleRate * 3;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 3000), 44 + index * 2);
  }
  return buffer;
}

const audio = wavBuffer();
const requests = [];
const held = new Map();
let holdFrom = Infinity;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/tts") {
      const buffers = [];
      for await (const buffer of request) buffers.push(buffer);
      const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      requests.push(body);
      if (body.chunkIndex >= holdFrom) {
        await new Promise(resolve => {
          const release = () => { held.delete(release); resolve(); };
          held.set(release, body);
          response.on("close", release);
        });
      }
      if (response.destroyed) return;
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": audio.length,
        "X-Rewritten-Text": encodeURIComponent(`改写第${body.chunkIndex}段`),
        "Cache-Control": "no-store"
      });
      response.end(audio);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const full = path.resolve(ROOT, `.${relative}`);
    if (!full.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(response);
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

function releaseAll() {
  holdFrom = Infinity;
  for (const release of [...held.keys()]) release();
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `超时: ${label}`);
    await delay(25);
  }
}

let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--disable-gpu"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 1200 });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10000);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("ai_reader_visited", "1");
    window.__mediaHandlers = {};
    window.__playCalls = 0;
    window.__playEvents = 0;
    window.__mediaEvents = [];
    const originalHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      window.__mediaHandlers[action] = handler;
      return originalHandler(action, handler);
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.__playCalls += 1;
      return originalPlay.apply(this, args);
    };
    document.addEventListener("play", () => { window.__playEvents += 1; }, true);
    for (const name of ["play", "playing", "pause", "ended", "emptied", "waiting"]) {
      document.addEventListener(name, event => {
        const player = event.target;
        if (player.id !== "audioPlayer") return;
        window.__mediaEvents.push({
          name, src: player.getAttribute("src"), paused: player.paused, ended: player.ended,
          time: player.currentTime, state: navigator.mediaSession.playbackState,
          index: document.querySelector("#chunkNav select")?.value
        });
        if (window.__mediaEvents.length > 200) window.__mediaEvents.shift();
      }, true);
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__mediaHandlers.play === "function");
  assert.deepEqual(await page.evaluate(() => Object.keys(window.__mediaHandlers).sort()),
    ["pause", "play", "seekbackward", "seekforward", "stop"]);
  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata.title), "灵听");
  const idleIcon = await page.evaluate(() => document.getElementById("mainPlayIcon").innerHTML.trim());

  async function action(name) {
    await page.evaluate(actionName => window.__mediaHandlers[actionName]({}), name);
  }

  async function snapshot() {
    return page.evaluate(() => {
      const player = document.getElementById("audioPlayer");
      return {
        paused: player.paused,
        time: player.currentTime,
        src: player.getAttribute("src"),
        index: document.querySelector("#chunkNav select")?.value,
        state: navigator.mediaSession.playbackState,
        button: document.getElementById("playPauseBtn").textContent.trim(),
        icon: document.getElementById("mainPlayIcon").innerHTML.trim(),
        calls: window.__playCalls,
        plays: window.__playEvents
      };
    });
  }

  async function waitPlaying() {
    await page.waitForFunction(() => {
      const player = document.getElementById("audioPlayer");
      return !player.paused && player.currentTime > 0.05;
    });
    assert.equal((await snapshot()).state, "playing");
  }

  async function assertStaysPaused(label) {
    await page.waitForFunction(() => document.getElementById("audioPlayer").paused
      && navigator.mediaSession.playbackState === "paused"
      && document.getElementById("playPauseBtn").textContent.includes("继续收听"));
    await delay(250);
    const before = await snapshot();
    await delay(3500);
    const after = await snapshot();
    assert.equal(after.paused, true, `${label}: audio`);
    assert.equal(after.state, "paused", `${label}: Media Session`);
    assert.match(after.button, /继续收听/, `${label}: 页面按钮`);
    assert.equal(after.src, before.src, `${label}: 不切换音源`);
    assert.equal(after.index, before.index, `${label}: 不跳段`);
    assert.equal(after.calls, before.calls, `${label}: 不再调用 play()`);
    assert.equal(after.plays, before.plays, `${label}: 不产生新 play 事件`);
    assert.ok(Math.abs(after.time - before.time) < 0.05, `${label}: 进度不推进`);
    assert.equal(after.icon, before.icon, `${label}: 主播放图标稳定`);
  }

  async function generate(label) {
    await page.evaluate(value => {
      document.getElementById("textInput").value = Array.from({ length: 100 }, (_, index) =>
        `${value}第${index + 1}句，天色渐渐暗了下来，街上的灯一盏盏亮起。`).join("\n");
      document.getElementById("modeSelect").value = "original";
      document.getElementById("speedSelect").value = "1";
    }, label);
    await page.click("#generateBtn");
  }

  await generate("锁屏暂停测试");
  await waitPlaying();
  await page.evaluate(() => {
    window.__mediaHandlers.seekforward({ seekOffset: 0.5 });
    window.__mediaHandlers.seekbackward({ seekOffset: 0.5 });
  });
  await action("pause");
  await action("pause");
  await assertStaysPaused("锁屏 pause");
  const pausedIcon = (await snapshot()).icon;
  assert.equal(pausedIcon, idleIcon, "暂停时主按钮应显示播放图标");
  await page.evaluate(() => document.getElementById("audioPlayer").dispatchEvent(new Event("ended")));
  await assertStaysPaused("暂停后迟到的 ended");
  await action("play");
  await action("play");
  await waitPlaying();
  await page.evaluate(() => {
    document.getElementById("audioPlayer").pause();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await assertStaysPaused("原生 pause + visibilitychange");
  assert.equal((await snapshot()).icon, pausedIcon);
  await page.click("#mainPlayBtn");
  await waitPlaying();
  await page.click("#mainPlayBtn");
  await assertStaysPaused("页面按钮");
  await action("play");
  await waitPlaying();
  await action("stop");
  await assertStaysPaused("锁屏 stop 保留进度");
  await action("play");
  await waitPlaying();
  await page.waitForFunction(() => document.querySelector("#chunkNav select")?.value === "1"
    && !document.getElementById("audioPlayer").paused);
  await action("pause");

  holdFrom = 1;
  const requestStart = requests.length;
  await generate("生成等待暂停测试");
  await waitUntil(() => held.size > 0, "首段生成已挂起");
  await action("pause");
  releaseAll();
  await assertStaysPaused("生成完成后不偷播");
  assert.equal((await snapshot()).src, null);
  await action("play");
  await waitPlaying();
  assert.equal(requests.slice(requestStart).filter(body => body.chunkIndex === 1).length, 1);
  await action("pause");

  for (const resumeBeforeReady of [false, true]) {
    const label = resumeBeforeReady ? "段间等待快速恢复测试" : "段间等待暂停测试";
    holdFrom = 2;
    await generate(label);
    await waitPlaying();
    const firstChunk = await snapshot();
    await waitUntil(() => [...held.values()].some(body => body.chunkIndex === 2 && body.text.includes(label)), "第二段预取已挂起");
    try {
      await page.waitForFunction(firstSrc => {
        const player = document.getElementById("audioPlayer");
        return player.getAttribute("src") === firstSrc && player.ended
          && window.__mediaEvents.some(event => event.name === "ended" && event.src === firstSrc);
      }, {}, firstChunk.src);
      const gap = await snapshot();
      assert.equal(gap.state, "playing", "自然结束并等待下一段时，连播意图不得被 pause 事件清掉");
      assert.equal(gap.index, firstChunk.index, "下一段音频未就绪时，下拉框仍显示上一段");
      await action("pause");
      const playsBeforeGapResume = (await snapshot()).plays;
      if (resumeBeforeReady) {
        await page.evaluate(() => { window.__pendingResume = window.__mediaHandlers.play({}); });
      }
      releaseAll();
      if (resumeBeforeReady) {
        await page.evaluate(() => window.__pendingResume);
      } else {
        await assertStaysPaused("段间生成完成仍保持暂停");
        await action("play");
      }
      await waitPlaying();
      assert.equal((await snapshot()).index, "1", "段间恢复不能重播上一段");
      assert.equal((await snapshot()).plays, playsBeforeGapResume + 1, "旧等待任务不能重复起播");
      await action("pause");
      await assertStaysPaused("段间暂停恢复后的状态");
    } catch (error) {
      console.error(label, await page.evaluate(() => window.__mediaEvents));
      throw error;
    }
  }

  assert.equal(await page.evaluate(() => navigator.mediaSession.metadata.title), "灵听");
  assert.deepEqual(errors, []);
  console.log("mediasession_browser: handlers / native pause / UI / stop / continuation / pending generation races ok");
} finally {
  releaseAll();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
