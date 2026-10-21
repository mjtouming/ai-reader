// 渐进分段：段长逐段放大，让上一段的播放时长盖住下一段的生成时间。
//
// 计时模型（与无头测试的 mock 一致，真实 CosyVoice 的 TTS 部分还更宽裕）：
//   改写约 0.04s/字 + 合成约 0.06s/字 = 生成 0.10s/字
//   成片约 0.19s/字
// 因此下一段最多约为上一段的 1.9 倍才会在 1x 语速下无缝衔接。
// 这里把增长封在 1.6 倍、并把每步上限走阶梯，给 1.2x 语速和句边界取整留余量。
// 1.5x 时最后几步增长仍可能有空档，但按这个模型应落在大约 30 秒以内。

export const CHUNK_LADDER = [150, 240, 380, 600, 960, 1500, 2200];
export const CHUNK_ABS_MAX = 2200;
export const CHUNK_GROWTH = 1.6;
const TINY_PARAGRAPH = 40;

export function maxCharsForChunk(index, prevLen) {
  const ladder = CHUNK_LADDER[Math.min(Math.max(index, 0), CHUNK_LADDER.length - 1)];
  if (!prevLen) return CHUNK_LADDER[0];
  const growthCap = Math.max(1, Math.floor(prevLen * CHUNK_GROWTH));
  // 上一段因为“不能硬切”已经超过本步阶梯时，不再把下一段硬压回更短的阶梯。
  if (prevLen > ladder) return Math.min(CHUNK_ABS_MAX, Math.max(ladder, growthCap));
  return Math.min(CHUNK_ABS_MAX, ladder, growthCap);
}

function normalize(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// 开头或段间的标题（几十字、单独成段）并进下一段，避免极短段把预生成窗口吃光。
function mergeTinyParagraphs(paragraphs) {
  const out = [];
  for (const p of paragraphs) {
    if (!p) continue;
    if (out.length && out[out.length - 1].length < TINY_PARAGRAPH) {
      out[out.length - 1] = out[out.length - 1] + "\n\n" + p;
    } else {
      out.push(p);
    }
  }
  if (out.length > 1 && out[out.length - 1].length < TINY_PARAGRAPH) {
    const last = out.pop();
    out[out.length - 1] += "\n\n" + last;
  }
  return out;
}

function unitsFromParagraphs(paragraphs) {
  const units = [];
  paragraphs.forEach((p, pi) => {
    const sentences = p
      .split(/(?<=[。！？!?；;])\s*/)
      .map(s => s.trim())
      .filter(Boolean);
    const pieces = [];
    const source = sentences.length ? sentences : [p];
    for (const s of source) {
      if (s.length > 80) {
        const clauses = s
          .split(/(?<=[，、,：:])\s*/)
          .map(x => x.trim())
          .filter(Boolean);
        if (clauses.length > 1) pieces.push(...clauses);
        else pieces.push(s);
      } else {
        pieces.push(s);
      }
    }
    pieces.forEach((text, idx) => {
      units.push({ text, newPara: pi > 0 && idx === 0 });
    });
  });
  return units;
}

export function buildReadingChunks(text) {
  const cleaned = normalize(text);
  if (!cleaned) return [];

  if (cleaned.length <= CHUNK_LADDER[0]) return [cleaned];

  const paragraphs = mergeTinyParagraphs(
    cleaned.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
  );
  const units = unitsFromParagraphs(paragraphs);
  if (!units.length) return [];

  const chunks = [];
  let i = 0;
  while (i < units.length) {
    const prevLen = chunks.length ? chunks[chunks.length - 1].length : 0;
    const limit = maxCharsForChunk(chunks.length, prevLen);
    let buf = "";
    while (i < units.length) {
      const u = units[i];
      if (!buf) {
        buf = u.text;
        i++;
        // 单句/单分句比上限还长：整段收下，不在汉字中间切开。
        if (buf.length >= limit) break;
        continue;
      }
      const sep = u.newPara ? "\n\n" : "";
      const addition = sep + u.text;
      if (buf.length + addition.length <= limit) {
        buf += addition;
        i++;
      } else {
        break;
      }
    }
    const t = buf.trim();
    if (t) chunks.push(t);
  }
  return chunks;
}

// ── 旧分段（20261016 及以前）：前 3 段最多 300 字，其后 2200/800 ──
// 只在「没有保存过分段结果」时用来重建，让旧的 currentIndex 仍指向同一段文字。
function splitLegacy(text, opts = {}) {
  const { maxLen = 2200, minLen = 800 } = opts;

  const cleaned = (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (!cleaned) return [];

  if (cleaned.length <= maxLen) return [cleaned];

  const paragraphs = cleaned.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  const chunks = [];
  let buf = "";

  const pushBuf = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const p of paragraphs) {
    if (p.length > maxLen) {
      pushBuf();

      const sentences = p
        .split(/(?<=[。！？!?；;。\.])\s*/)
        .map(s => s.trim())
        .filter(Boolean);

      let sbuf = "";
      for (const s of sentences) {
        if ((sbuf + " " + s).trim().length <= maxLen) {
          sbuf = (sbuf ? sbuf + " " : "") + s;
        } else {
          if (sbuf) chunks.push(sbuf.trim());
          if (s.length > maxLen) {
            for (let i = 0; i < s.length; i += maxLen) {
              const cut = s.slice(i, i + maxLen).trim();
              if (cut) chunks.push(cut);
            }
            sbuf = "";
          } else {
            sbuf = s;
          }
        }
      }
      if (sbuf) chunks.push(sbuf.trim());
      continue;
    }

    const candidate = buf ? (buf + "\n\n" + p) : p;
    if (candidate.length <= maxLen) {
      buf = candidate;
    } else {
      pushBuf();
      buf = p;
    }
  }
  pushBuf();

  for (let i = chunks.length - 1; i > 0; i--) {
    if (chunks[i].length < minLen) {
      const merged = chunks[i - 1] + "\n\n" + chunks[i];
      if (merged.length <= maxLen) {
        chunks[i - 1] = merged;
        chunks.splice(i, 1);
      }
    }
  }

  return chunks;
}

export function splitLegacyBook(text) {
  const warmupParts = splitLegacy(text, { maxLen: 300, minLen: 150 });
  if (warmupParts.length > 3) {
    const warmup = warmupParts.splice(0, 3);
    const restText = warmupParts.join("\n\n");
    const restParts = splitLegacy(restText, { maxLen: 2200, minLen: 800 });
    return [...warmup, ...restParts];
  }
  return warmupParts;
}

export function savedChunksUsable(chunks) {
  return Array.isArray(chunks)
    && chunks.length > 0
    && chunks.every(c => typeof c === "string" && c.trim().length > 0);
}

// 已保存的分段原样沿用（旧 session 的段索引仍然有效）。
// 没有分段结果时（v1 迁移来的书架书）用旧算法重建，而不是按新规则重切。
export function resolvePlaybackChunks(text, savedChunks) {
  if (savedChunksUsable(savedChunks)) return savedChunks.slice();
  return splitLegacyBook(text || "");
}
