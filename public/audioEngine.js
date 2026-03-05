// ===== IndexedDB 打开 =====
function openDB() {
  return new Promise((resolve, reject) => {

    const req = indexedDB.open("ai_reader_audio_cache", 1);

    req.onupgradeneeded = function (event) {
      const db = event.target.result;

      if (!db.objectStoreNames.contains("audio")) {
        db.createObjectStore("audio");
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
function createCacheKey(text, mode, voice) {

  const raw = text + "|" + mode + "|" + voice;

  let hash = 0;

  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }

  return "audio_" + Math.abs(hash);

}

// ===== 生成音频 =====
export async function generateAudioFromText(text, mode, voice, signal, previous) {

  const key = createCacheKey(text, mode, voice);

  // ===== 先查缓存 =====
  const cached = await getCachedAudio(key);

  if (cached) {
    console.log("🎧 使用缓存音频");
    return URL.createObjectURL(cached);
  }

  // ===== 自动 retry =====
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {

    try {

      const response = await fetch("/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode,
          voice,
          previous
        }),
        signal
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText);
      }

      const audioBlob = await response.blob();

      // ===== 写入缓存 =====
      await saveCachedAudio(key, audioBlob);

      return URL.createObjectURL(audioBlob);

    } catch (err) {

      lastError = err;

      // Abort 不 retry
      if (err?.name === "AbortError") {
        throw err;
      }

      console.log("TTS 请求失败，准备重试:", attempt);

      // 等待 1 秒再 retry
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
      }

    }

  }

  throw lastError;

}