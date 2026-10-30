import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function section(source, start, end) {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset, `找不到代码段: ${start}`);
  return source.slice(offset, limit);
}

function harness() {
  const listeners = new Map();
  const actions = new Map();
  const documentListeners = new Map();
  const button = { innerText: "", addEventListener() {} };
  const player = {
    src: "test:first", paused: true, ended: false, currentTime: 0, playCalls: 0,
    addEventListener(name, handler) { listeners.set(name, handler); },
    getAttribute(name) { return name === "src" ? this.src || null : null; },
    removeAttribute() { this.src = ""; },
    load() {},
    async emit(name) { await listeners.get(name)?.(); },
    async play() {
      this.playCalls += 1;
      this.paused = false;
      this.ended = false;
      await this.emit("play");
    },
    pause() {
      if (this.paused) return;
      this.paused = true;
      queueMicrotask(() => this.emit("pause"));
    }
  };
  const context = vm.createContext({
    console, URL: { revokeObjectURL() {} },
    navigator: { mediaSession: { playbackState: "none", setActionHandler(name, handler) { actions.set(name, handler); } } },
    document: {
      visibilityState: "visible",
      getElementById() { return button; },
      addEventListener(name, handler) { documentListeners.set(name, handler); }
    },
    audio: player, audioPlayer: player,
    mainPlayIcon: { innerHTML: "" }, PLAY_SVG: "play", PAUSE_SVG: "pause",
    setTimeout(handler) { handler(); },
    chunks: ["first", "second"], currentIndex: 0, currentJobId: 1,
    isAutoPlaying: false, playbackControlId: 0, playbackEpoch: 0,
    audioCache: {}, currentAudioUrl: null, activeGenIndex: -1,
    currentAbort: null, preGenerateAbort: new AbortController(), AbortController,
    inflight: new Map(), contextReady: [], restoreTime: 0, maxReachedIndex: -1,
    sleepTargetTime: null, sleepMode: null, lastSessionSave: 0,
    currentFileName: "测试书", currentBookId: null,
    speedSelect: { value: "1" }, saves: 0, fills: 0,
    saveSession() { context.saves += 1; },
    fillWindow() { context.fills += 1; },
    renderedIndex: 0,
    setStatus() {},
    renderChunkNav() { context.renderedIndex = context.currentIndex; },
    updateNowPlayingTitle() {},
    deriveTitle() { return "测试书"; }
  });
  vm.runInContext([
    section(app, "function interruptPlayback(", "// 同一段只发一个 /tts"),
    section(app, "async function playChunk(", "// 从正在播的段往后补窗口"),
    section(app, 'const playPauseBtn = document.getElementById("playPauseBtn");', "// ── Session restore"),
    section(html, "document.addEventListener('visibilitychange'", "  })();")
  ].join("\n"), context);
  return { context, player, button, actions, documentListeners };
}

{
  const { context, player, button, actions, documentListeners } = harness();
  await actions.get("play")();
  await actions.get("play")();
  assert.equal(player.playCalls, 1, "play handler 应幂等");
  assert.equal(context.navigator.mediaSession.playbackState, "playing");
  player.currentTime = 1.25;
  actions.get("pause")();
  actions.get("pause")();
  await Promise.resolve();
  assert.equal(context.isAutoPlaying, false);
  assert.equal(player.paused, true);
  assert.equal(player.currentTime, 1.25);
  assert.equal(context.navigator.mediaSession.playbackState, "paused");
  assert.match(button.innerText, /播放/);
  await player.emit("ended");
  documentListeners.get("visibilitychange")();
  assert.equal(context.currentIndex, 0, "暂停后 ended 不得推进段落");
  assert.equal(player.playCalls, 1, "visibilitychange 不得调用 play");
  await actions.get("play")();
  player.pause();
  documentListeners.get("visibilitychange")();
  await Promise.resolve();
  assert.equal(context.isAutoPlaying, false, "原生暂停关闭连播");
  assert.equal(player.playCalls, 2);
  player.paused = false;
  await player.emit("play");
  await Promise.resolve();
  assert.equal(player.paused, true, "暂停后迟到的原生 play 事件必须被挡住");
  await actions.get("play")();
  actions.get("stop")();
  await Promise.resolve();
  assert.equal(context.isAutoPlaying, false);
  assert.equal(player.currentTime, 1.25, "stop 保留进度");
}

{
  const { context, player, actions } = harness();
  await actions.get("play")();
  player.paused = true;
  player.ended = true;
  await player.emit("pause");
  assert.equal(context.isAutoPlaying, true, "自然结束的 pause 不阻止续播");
  context.audioCache[1] = "test:second";
  await player.emit("ended");
  assert.equal(context.currentIndex, 1);
  assert.equal(player.src, "test:second");
  assert.equal(player.paused, false);
  context.interruptPlayback();
  context.isAutoPlaying = true;
  await player.emit("pause");
  assert.equal(context.isAutoPlaying, true, "重置 src 遗留的 pause 不得中断新生成");
}

for (const resumeBeforeReady of [false, true]) {
  const { context, player, actions } = harness();
  await actions.get("play")();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  context.ensureChunkAudio = index => {
    assert.equal(index, 1);
    return pending.then(result => {
      context.audioCache[index] = result.url;
      return result;
    });
  };
  player.paused = true;
  player.ended = true;
  await player.emit("pause");
  const continuation = player.emit("ended");
  assert.equal(context.currentIndex, 1, "自然 ended 后内部索引已推进");
  assert.equal(context.activeGenIndex, 1, "播放正在等待第二段生成");
  assert.equal(context.renderedIndex, 0, "第二段未就绪时导航尚未重绘");
  assert.equal(player.src, "test:first");
  assert.equal(context.isAutoPlaying, true, "自然结束的 pause 不得清除连播意图");
  actions.get("pause")();
  const resumed = resumeBeforeReady ? actions.get("play")() : null;
  release({ url: "test:second" });
  await Promise.all([continuation, resumed]);
  if (!resumeBeforeReady) {
    assert.equal(player.playCalls, 1, "段间暂停后生成完成不得起播");
    assert.equal(player.src, "test:first");
    assert.equal(context.isAutoPlaying, false);
    assert.equal(context.renderedIndex, 0, "暂停的旧等待任务不得重绘成下一段");
    await actions.get("play")();
  }
  assert.equal(player.playCalls, 2, "段间恢复只起播第二段一次");
  assert.equal(player.src, "test:second", "恢复不能重播已结束的第一段");
  assert.equal(context.renderedIndex, 1);
  assert.equal(context.isAutoPlaying, true);
}

{
  const { context, player, actions } = harness();
  await actions.get("play")();
  context.currentIndex = 1;
  context.audioCache[1] = "test:second";
  let source = player.src;
  Object.defineProperty(player, "src", {
    get() { return source; },
    set(value) {
      source = value;
      player.paused = true;
      player.ended = false;
      queueMicrotask(() => player.emit("pause"));
    }
  });
  let releasePlay;
  player.play = () => {
    player.playCalls += 1;
    player.paused = false;
    return new Promise(resolve => { releasePlay = resolve; });
  };
  const controlId = context.playbackControlId;
  const switching = context.playChunk(1, context.currentJobId);
  await Promise.resolve();
  assert.equal(player.src, "test:second");
  assert.equal(player.paused, false);
  assert.equal(context.isAutoPlaying, true, "换源后迟到的 pause 事件不得取消已经发起的播放");
  assert.equal(context.playbackControlId, controlId);
  player.pause();
  await Promise.resolve();
  assert.equal(context.isAutoPlaying, false, "换源后的真实原生暂停仍必须关闭连播");
  releasePlay();
  await switching;
  assert.equal(context.isAutoPlaying, false, "待完成的 play 不得覆盖真实原生暂停");
}

for (const resumeBeforeReady of [false, true]) {
  const { context, player, actions } = harness();
  player.src = "";
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  context.ensureChunkAudio = () => pending.then(result => {
    context.audioCache[0] = result.url;
    return result;
  });
  const initial = actions.get("play")();
  actions.get("pause")();
  const resumed = resumeBeforeReady ? actions.get("play")() : null;
  release({ url: "test:generated" });
  await Promise.all([initial, resumed]);
  if (!resumeBeforeReady) {
    assert.equal(player.playCalls, 0, "暂停后的在途 TTS 不得起播");
    assert.equal(context.audioCache[0], "test:generated", "暂停不丢弃已生成音频");
    await actions.get("play")();
  }
  assert.equal(player.playCalls, 1, "暂停/恢复跨越在途 TTS 也只起播一次");
  assert.equal(player.src, "test:generated");
  assert.equal(context.isAutoPlaying, true);
}

{
  const { context, player, actions } = harness();
  context.currentJobId = 0;
  player.src = "";
  context.audioCache[0] = "test:restored";
  await actions.get("play")();
  assert.equal(context.currentJobId, 1, "手动恢复必须阻止迟到的 session restore 覆盖播放");
  assert.equal(player.src, "test:restored");
}

{
  const { context, player, actions } = harness();
  let release;
  player.play = () => new Promise(resolve => { release = resolve; });
  const pendingPlay = actions.get("play")();
  actions.get("pause")();
  release();
  await pendingPlay;
  assert.equal(context.isAutoPlaying, false, "迟到的 play promise 不得恢复连播");
  assert.equal(context.fills, 0, "迟到的 play promise 不启动预取");
}

console.log("mediasession_node: handlers, native pause, visibility, ended and pending TTS/play races ok");
