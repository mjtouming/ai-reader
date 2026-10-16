// ===== IndexedDB 打开 =====
// DB v2：audio（音频缓存）+ texts（书籍全文，storage.js 使用）
function openDB() {
  return new Promise((resolve, reject) => {

    const req = indexedDB.open("ai_reader_audio_cache", 2);

    req.onupgradeneeded = function (event) {
      const db = event.target.result;

      if (!db.objectStoreNames.contains("audio")) {
        db.createObjectStore("audio");
      }
      if (!db.objectStoreNames.contains("texts")) {
        db.createObjectStore("texts");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);

  });
}

// ===== 读取缓存 =====
async function getCachedAudio(key) {

  const db = await openDB();

  return new Promise((resolve) => {

    const tx = db.transaction("audio", "readonly");
    const store = tx.objectStore("audio");

    const req = store.get(key);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);

  });
}

// ===== 写入缓存 =====
async function saveCachedAudio(key, blob) {

  const db = await openDB();

  return new Promise((resolve) => {

    const tx = db.transaction("audio", "readwrite");
    const store = tx.objectStore("audio");

    store.put(blob, key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();

  });
}

// ===== 生成缓存 key =====
// SHA-256（C4d）：原 djb2 32-bit 空间在千段级别有真实碰撞概率，碰撞会播错音频。
// 前缀升 v2：故意让旧弱哈希时代的缓存记录失效，避免新旧 key 空间混用。
async function createCacheKey(text, mode, voice) {

  const raw = "cosyvoice-http-v2|" + text + "|" + mode + "|" + voice;

  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return "audio_" + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

}

// ===== 音频缓存软上限 =====
// 缓存可随时重建：每写 20 次查一次站点存储用量，超过软上限整体清空 audio store
let audioCacheSaveCount = 0;
const AUDIO_CACHE_SOFT_LIMIT = 1.5 * 1024 * 1024 * 1024;

function maybeTrimAudioCache() {
  audioCacheSaveCount++;
  if (audioCacheSaveCount % 20 !== 0) return;
  if (!navigator.storage?.estimate) return;
  navigator.storage.estimate().then(({ usage }) => {
    if ((usage || 0) <= AUDIO_CACHE_SOFT_LIMIT) return;
    openDB().then(db => new Promise(resolve => {
      const tx = db.transaction("audio", "readwrite");
      tx.objectStore("audio").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    })).then(() => {
      console.log("🧹 音频缓存超过软上限，已整体清空（可按需重新生成）");
    });
  }).catch(() => {});
}

// ===== TTS 阶段推送（WebSocket）=====
// 服务端通过 WS 推送"改写中/合成中"阶段事件；连接失败静默降级，不影响生成流程
let stageSocket = null;

function ensureStageSocket() {
  if (stageSocket && stageSocket.readyState <= 1) return;
  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}`);
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.requestId) {
          window.dispatchEvent(new CustomEvent("tts-stage", { detail: msg }));
        }
      } catch {}
    };
    socket.onerror = () => { if (stageSocket === socket) stageSocket = null; };
    socket.onclose = () => { if (stageSocket === socket) stageSocket = null; };
    stageSocket = socket;
  } catch {
    stageSocket = null;
  }
}

// ===== 生成音频 =====
// ✅ 修复1：增加 chunkIndex / totalChunks 参数，传给 /tts
// ✅ 修复2：返回 { url, rewritten } 对象，而不是直接返回字符串
export async function generateAudioFromText(text, mode, voice, signal, previous, chunkIndex, totalChunks, skipRewrite = false) {

  const key = await createCacheKey(text, mode, voice);

  // ===== 先查缓存 =====
  const cached = await getCachedAudio(key);

  if (cached) {
    console.log("🎧 使用缓存音频");
    // ✅ 修复2：缓存命中也返回对象格式
    return { url: URL.createObjectURL(cached), rewritten: null };
  }

  // ===== 自动 retry =====
  let lastError = null;

  // 阶段推送关联 ID：每次生成一个，服务端用它标记阶段事件归属
  const requestId = (crypto.randomUUID && crypto.randomUUID())
    || `r_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {

    try {

      ensureStageSocket();

      const response = await fetch("/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode,
          voice,
          previous,
          // ✅ 修复1：把段落信息传给服务端
          chunkIndex,
          totalChunks,
          skipRewrite,
          requestId
        }),
        signal
      });

      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(errText);
        // 4xx（如 text is empty）是确定性失败，重试无意义；5xx 才值得重试
        err.noRetry = response.status < 500;
        throw err;
      }

      // ✅ 修复2：从响应头读取 rewritten 文本（需要服务端配合，见下方说明）
      let rewritten = null;
      try {
        const raw = response.headers.get("X-Rewritten-Text");
        rewritten = raw ? decodeURIComponent(raw) : null;
      } catch (e) {
        console.log("X-Rewritten-Text decode 失败，忽略:", e);
      }

      const audioBlob = await response.blob();

      // ===== 写入缓存（后台进行，不阻塞起播）=====
      saveCachedAudio(key, audioBlob);
      maybeTrimAudioCache();

      // ✅ 修复2：返回对象
      return { url: URL.createObjectURL(audioBlob), rewritten };

    } catch (err) {

      lastError = err;

      // Abort 与 4xx 不 retry
      if (err?.name === "AbortError" || err?.noRetry) {
        throw err;
      }

      console.log("TTS 请求失败，准备重试:", attempt);

      // 等待 3 秒再 retry
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 3000));
      }

    }

  }

  throw lastError;

}
