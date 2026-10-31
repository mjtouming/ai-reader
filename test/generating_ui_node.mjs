import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { listeningProgress, formatPlaybackTime } from "../public/listeningProgress.mjs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function section(start, end) {
  const offset = app.indexOf(start);
  const limit = app.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset, `找不到代码段: ${start}`);
  return app.slice(offset, limit);
}

function element() {
  return {
    children: [], attributes: {}, style: {}, className: "", textContent: "",
    get classList() {
      return {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, enabled) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          if (enabled) names.add(name);
          else names.delete(name);
          this.className = [...names].join(" ");
        },
        add: (...names) => names.forEach(name => this.classList.toggle(name, true)),
        remove: (...names) => names.forEach(name => this.classList.toggle(name, false))
      };
    },
    get firstElementChild() { return this.children[0]; },
    set innerHTML(value) { assert.equal(value, ""); this.replaceChildren(); },
    appendChild(child) { this.children.push(child); child.parentElement = this; },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector() { return this.label; }
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function harness() {
  const nodes = new Map();
  const requests = [];
  let frame;
  const getNode = name => {
    if (!nodes.has(name)) nodes.set(name, element());
    return nodes.get(name);
  };
  const button = getNode("generateBtn");
  button.label = element();
  const status = getNode("statusText");
  const context = vm.createContext({
    console: { log() {}, error() {} }, DOMException, AbortController,
    URL: { revokeObjectURL() {} },
    document: { hidden: false, getElementById: getNode, createElement: element },
    requestAnimationFrame(handler) { frame = handler; return 1; },
    chunks: ["第一段", "第二段", "第三段"], rewrittenChunks: [], contextReady: [],
    generatingSegmentIndices: new Set(), audioCache: {}, inflight: new Map(),
    currentIndex: 0, currentJobId: 1, playbackEpoch: 0, playbackControlId: 0,
    activeGenIndex: -1, currentAbort: null, preGenerateAbort: new AbortController(),
    isAutoPlaying: true, restoreTime: 0, restoreDuration: 0, audioChunkIndex: -1,
    currentAudioUrl: null, maxReachedIndex: -1, currentBookText: "测试书",
    listeningTitle: "测试书", listeningFrame: null, sourceChunks: [], chunksAreStoryScript: false,
    generateBtn: button, statusText: status, progressBar: getNode("progressBar"),
    modeSelect: { value: "original" }, voiceSelect: { value: "young_female" },
    speedSelect: { value: "1" }, audioPlayer: { pause() {}, removeAttribute() {}, load() {} },
    listeningProgress, formatPlaybackTime,
    playbackPosition() { return { time: 0, duration: 0 }; },
    deriveTitle() { return "测试书"; }, updateNowPlayingTitle() {}, syncPlaybackState() {},
    textLikelyNeedsTranslation() { return false; }, fillWindow() {},
    generateAudioFromText(...args) {
      const pending = deferred();
      requests.push({ ...pending, args });
      return pending.promise;
    }
  });
  vm.runInContext([
    section("function syncListeningUI()", "// ── 前置内容"),
    section("function abortError()", "function restartPlaybackIfActive"),
    section("function interruptPlayback(", "// 同一段只发一个 /tts"),
    section("function ensureChunkAudio(", "async function playChunk(")
  ].join("\n"), context);
  const flush = () => { const callback = frame; frame = null; callback?.(); };
  return { context, button, status, requests, getNode, flush };
}

{
  const { context, button, status } = harness();
  context.setStatus("正在解析 PDF…", "info", { busy: true, step: 2, total: 4, extra: "保留" });
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains("is-generating"), true);
  assert.equal(button.label.textContent, "生成中");
  assert.equal(button.attributes["aria-busy"], "true");
  const wrap = status.firstElementChild;
  assert.equal(wrap.children[0].children.length, 4);
  assert.equal(wrap.children[0].attributes["aria-hidden"], "true");
  assert.equal(wrap.children[1].textContent, "正在解析 PDF…");
  context.setStatus("其他提示", "info", { step: 3, total: 4 });
  assert.equal(button.disabled, true, "未传 busy 不能改变按钮状态");
  context.setStatus("播放第 1 段", "ok", { busy: false });
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains("is-generating"), false);
  assert.equal(button.label.textContent, "生成并播放");
  assert.equal(status.classList.contains("loading"), false);
  context.setStatus("单独 loading", "info", { loading: true });
  assert.equal(status.firstElementChild.firstElementChild.children.length, 4);
  assert.equal(button.disabled, false);
}

{
  const { context, requests, getNode, flush } = harness();
  const first = context.ensureChunkAudio(0, 1, { foreground: true });
  assert.equal(context.ensureChunkAudio(0, 1), first, "复用在途请求");
  assert.equal(requests.length, 1);
  flush();
  const segments = getNode("progressBar").children;
  assert.equal(segments[0].classList.contains("generating"), true);
  assert.equal(segments[1].classList.contains("generating"), false);
  requests[0].args[8]("改写稿");
  assert.equal(context.generatingSegmentIndices.has(0), true, "只有改写头到达、音频未完成时仍在生成");
  const next = context.ensureChunkAudio(1, 1);
  flush();
  assert.equal(segments[1].classList.contains("generating"), true, "预取也显示真实状态");
  requests[0].resolve({ url: "blob:first" });
  await first;
  flush();
  assert.equal(segments[0].classList.contains("generating"), false);
  assert.equal(segments[1].classList.contains("generating"), true);
  requests[1].resolve({ url: "blob:next" });
  await next;
  await context.ensureChunkAudio(1, 1);
  assert.equal(requests.length, 2, "缓存命中不重新生成");
  assert.equal(context.generatingSegmentIndices.size, 0);
}

for (const failure of [new Error("TTS failed"), new DOMException("Aborted", "AbortError")]) {
  const { context, requests } = harness();
  const pending = context.ensureChunkAudio(0, 1);
  requests[0].reject(failure);
  await assert.rejects(pending, error => error === failure);
  assert.equal(context.generatingSegmentIndices.size, 0, "失败/中止必须清理");
}

{
  const { context, requests, getNode, flush } = harness();
  const old = context.ensureChunkAudio(0, 1);
  context.interruptPlayback("切书/新文本");
  assert.equal(context.generatingSegmentIndices.size, 0);
  context.currentJobId += 1;
  const fresh = context.ensureChunkAudio(0, 2, { foreground: true });
  requests[0].resolve({ url: "blob:stale" });
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(context.generatingSegmentIndices.has(0), true, "旧请求 finally 不能清除新请求");
  context.chunks = Array.from({ length: 41 }, () => "段落");
  flush();
  assert.equal(getNode("progressBar").children.length, 1);
  assert.equal(getNode("progressBar").firstElementChild.classList.contains("generating"), true);
  requests[1].resolve({ url: "blob:fresh" });
  await fresh;
  flush();
  assert.equal(getNode("progressBar").firstElementChild.classList.contains("generating"), false);
}

for (const outcome of ["success", "failure", "interrupt"]) {
  const { context, getNode, flush } = harness();
  const rewrite = deferred();
  let played = false;
  Object.assign(context, {
    noteUserInput() {}, readTextInput() { return "短故事"; },
    currentFrontMatter: null, bindDerivedNameIfNeeded() {},
    needsStoryWholeRewrite() { return true; },
    planPlaybackChunks(text, mode, rewritten) {
      return { sourceChunks: [text], chunks: rewritten ? [rewritten] : [text], script: !!rewritten };
    },
    rewriteStoryWhole() { return rewrite.promise; },
    renderChunkNav() { context.syncListeningUI(); },
    saveToShelf() {}, saveSession() {},
    async playChunk() { played = true; }
  });
  vm.runInContext(section("function applyPlaybackPlan(", 'generateBtn?.addEventListener("click"'), context);
  const started = context.startGeneratedPlayback();
  flush();
  assert.equal(getNode("progressBar").firstElementChild.classList.contains("generating"), true);
  if (outcome === "failure") rewrite.reject(new Error("rewrite failed"));
  else {
    if (outcome === "interrupt") context.interruptPlayback("中止");
    rewrite.resolve("改写完成");
  }
  await started;
  flush();
  assert.equal(context.generatingSegmentIndices.size, 0, `整篇改写 ${outcome} 后清理`);
  assert.equal(getNode("progressBar").firstElementChild.classList.contains("generating"), false);
  assert.equal(played, outcome === "success");
}

console.log("generating_ui_node: busy/loading、并发预取、缓存、失败、中止竞态、continuous、整篇改写通过");
