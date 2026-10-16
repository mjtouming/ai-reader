// ===== 灵听本地存储 v2（2026-10-16）=====
// 变更背景：v1 把书籍全文（session 双份 + 书架每本一份）都塞进 localStorage，
// 5MB 配额下一本 30 万字的长书就会写满，且 QuotaExceededError 被静默吞掉，
// 用户以为进度已保存实际没有。
// v2 方案：全文与分段存 IndexedDB（texts store），localStorage 只保存
// session/书架的小体积元数据（进度指针、模式、声线等）。

const DB_NAME = "ai_reader_audio_cache";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

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

// ===== 文本记录（IndexedDB texts store）=====
// record: { text: string, chunks: string[] | null, fileName: string | null }

export async function saveTextRecord(id, record) {
  if (!id) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("texts", "readwrite");
    tx.objectStore("texts").put(record || {}, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("saveTextRecord failed"));
  });
}

export async function loadTextRecord(id) {
  if (!id) return null;
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction("texts", "readonly");
    const req = tx.objectStore("texts").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

export async function deleteTextRecord(id) {
  if (!id) return;
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction("texts", "readwrite");
    tx.objectStore("texts").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ===== 书籍身份 hash =====
// v2：头500字 + 全文长度 + 尾500字 参与散列。
// v1 只看前 500 字，开头相同的两本书（同书不同版本等）会互相覆盖进度。
export function hashText(text) {
  const t = String(text || "");
  const s = t.slice(0, 500) + "|" + t.length + "|" + (t.length > 1000 ? t.slice(-500) : "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

// v1 的旧 hash（只看前 500 字），仅用于一次性迁移时匹配旧书籍 ID
function legacyHashText(text) {
  const t = String(text || "");
  let h = 5381;
  for (let i = 0; i < Math.min(t.length, 500); i++) {
    h = ((h << 5) + h) + t.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

// ===== v1 → v2 一次性迁移 =====
// 幂等：v1 key 不存在时直接返回；迁移完成后删除 v1 key。
export async function migrateV1IfNeeded() {
  const OLD_SESSION = "ai_reader_session_v1";
  const OLD_SHELF   = "ai_reader_shelf_v1";
  const NEW_SESSION = "ai_reader_session_v2";
  const NEW_SHELF   = "ai_reader_shelf_v2";

  try {
    // 1) 书架：全文移入 IndexedDB，localStorage 只留元数据（保留旧 id 不变）
    const oldShelfRaw = localStorage.getItem(OLD_SHELF);
    if (oldShelfRaw) {
      const shelf = JSON.parse(oldShelfRaw);
      const books = shelf.books || [];
      for (const b of books) {
        if (b && b.id && b.text) {
          await saveTextRecord(b.id, { text: b.text, chunks: null, fileName: b.fileName || null });
          b.textLength = b.text.length;
          delete b.text;
        }
      }
      localStorage.setItem(NEW_SHELF, JSON.stringify(shelf));
      localStorage.removeItem(OLD_SHELF);
      console.log("📦 书架 v1→v2 迁移完成，书籍数:", books.length);
    }

    // 2) 会话：全文移入 IndexedDB，refId 指向记录 key
    const oldSessRaw = localStorage.getItem(OLD_SESSION);
    if (oldSessRaw) {
      const s = JSON.parse(oldSessRaw);
      let refId = null;
      if (s.text) {
        // 优先用旧 hash 匹配已迁移的书架书（保持 refId === 书籍 id），
        // 匹配不上（纯粘贴未入库）才用新 hash 立新记录
        const shelfNow = JSON.parse(localStorage.getItem(NEW_SHELF) || '{"books":[]}');
        const legacyId = legacyHashText(s.text);
        const matched = (shelfNow.books || []).find(b => b.id === legacyId);
        refId = matched ? matched.id : hashText(s.text);
        await saveTextRecord(refId, { text: s.text, chunks: s.chunks || null, fileName: null });
      }
      localStorage.setItem(NEW_SESSION, JSON.stringify({
        refId,
        currentIndex:     s.currentIndex || 0,
        maxReachedIndex:  s.maxReachedIndex ?? 0,
        currentTime:      s.currentTime || 0,
        mode:             s.mode || "original",
        voice:            s.voice || "young_female",
        speed:            s.speed || "1",
        updatedAt:        Date.now()
      }));
      localStorage.removeItem(OLD_SESSION);
      console.log("📦 会话 v1→v2 迁移完成");
    }
  } catch (e) {
    console.log("v1→v2 迁移失败（不影响使用，旧数据保留）:", e);
  }
}
