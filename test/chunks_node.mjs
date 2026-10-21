import assert from "node:assert/strict";
import {
  CHUNK_ABS_MAX,
  CHUNK_GROWTH,
  CHUNK_LADDER,
  buildReadingChunks,
  maxCharsForChunk,
  resolvePlaybackChunks,
  savedChunksUsable,
  splitLegacyBook
} from "../public/readingChunks.mjs";
import { MONSTER, buildLongText } from "./long_text.mjs";

const text = buildLongText();
assert.ok(text.replace(/\s+/g, "").length >= 24000, "long text should be ~2.6万字");
assert.ok(text.startsWith("序\n\n"), "opens with a standalone title paragraph");

const chunks = buildReadingChunks(text);
const legacy = splitLegacyBook(text);

assert.ok(chunks.length > 8, `expected many chunks, got ${chunks.length}`);
assert.ok(legacy.length > 4, `legacy should also segment, got ${legacy.length}`);

const norm = s => s.replace(/\s+/g, "");
assert.equal(norm(chunks.join("")), norm(text), "progressive split must keep every character");
assert.equal(norm(legacy.join("")), norm(text), "legacy split must keep every character");

assert.ok(legacy[0].length < 40, `legacy leaves the title as its own chunk, got ${legacy[0].length}: ${legacy[0]}`);
assert.ok(chunks[0].includes("序"), "title is merged into the first chunk");
assert.ok(chunks[0].length > 80 && chunks[0].length <= 150, `first chunk should sit near 150, got ${chunks[0].length}`);

for (let i = 0; i < chunks.length; i++) {
  assert.ok(chunks[i].length <= CHUNK_ABS_MAX || !/[，、,：:。！？!?；;]/.test(chunks[i].slice(0, -1)),
    `chunk ${i} length ${chunks[i].length} exceeds max and still has internal breaks`);
  if (i === chunks.length - 1) continue;
  const end = chunks[i].slice(-1);
  assert.match(end, /[。！？!?；;，、,：:\n]/, `chunk ${i} ends mid-sentence: …${chunks[i].slice(-16)}`);
}

for (let i = 1; i < chunks.length; i++) {
  const prev = chunks[i - 1].length;
  const cur = chunks[i].length;
  const cap = Math.floor(prev * CHUNK_GROWTH);
  if (cur <= cap + 1) continue;
  const internal = chunks[i].slice(0, -1);
  assert.ok(!/[。！？!?；;，、,：:]/.test(internal),
    `chunk ${i} is ${cur} chars, over ${CHUNK_GROWTH}x previous ${prev}, but it could have been split`);
}

// 均匀短句应顺着阶梯变长，而不是第 4 段突然到 2200。
for (let i = 1; i < 6; i++) {
  assert.ok(chunks[i].length > chunks[i - 1].length,
    `chunk ${i} (${chunks[i].length}) should be longer than chunk ${i - 1} (${chunks[i - 1].length})`);
  assert.ok(chunks[i].length <= Math.floor(chunks[i - 1].length * CHUNK_GROWTH) + 1,
    `chunk ${i} grew faster than ${CHUNK_GROWTH}x`);
}
assert.ok(chunks.every(c => c.length <= CHUNK_ABS_MAX), "no chunk above 2200 when the text has breakpoints");

const monsterChunk = chunks.find(c => c.includes("甲甲甲"));
assert.ok(monsterChunk, "monster sentence should survive");
assert.ok(monsterChunk.includes(MONSTER.trim()) || monsterChunk.includes("甲".repeat(500)),
  "500-char sentence without commas must stay in one chunk");

// 播放时长覆盖下一段生成时间（1x，0.19s/字 对 0.10s/字），跳过被长句撑破比例的那一对。
const PLAY = 0.19;
const GEN = 0.10;
for (let i = 0; i < 8 && i + 1 < chunks.length; i++) {
  const play = chunks[i].length * PLAY;
  const gen = chunks[i + 1].length * GEN;
  assert.ok(play + 0.05 >= gen,
    `chunk ${i} plays ${play.toFixed(1)}s but chunk ${i + 1} generates in ${gen.toFixed(1)}s`);
}

// 旧进度：保存过的分段原样沿用；没有分段时走旧算法，段索引含义不变。
const saved = ["甲段", "乙段", "丙段"];
const reused = resolvePlaybackChunks(text, saved);
assert.deepEqual(reused, saved);
assert.notEqual(reused, saved, "return a copy");
assert.equal(savedChunksUsable(saved), true);
assert.equal(savedChunksUsable([]), false);
assert.equal(savedChunksUsable(null), false);
const rebuilt = resolvePlaybackChunks(text, null);
assert.deepEqual(rebuilt, legacy);

// 上一段没填满阶梯时，下一段仍按阶梯走，不跟着实际字数缩。
assert.equal(maxCharsForChunk(1, 53), CHUNK_LADDER[1]);
assert.equal(maxCharsForChunk(3, 70), CHUNK_LADDER[3]);
assert.equal(maxCharsForChunk(1, 140), Math.min(CHUNK_LADDER[1], Math.floor(140 * CHUNK_GROWTH)));
assert.equal(maxCharsForChunk(1, 500), Math.min(CHUNK_ABS_MAX, Math.floor(500 * CHUNK_GROWTH)));

// 没有句读的短开场（目录行粘在一起）不能把后面的段长冻在一百字附近。
const shortUnits = Array.from({ length: 24 }, (_, i) => "目".repeat(86) + `条${String(i).padStart(2, "0")}`);
const shortText = shortUnits.join("\n\n");
const shortChunks = buildReadingChunks(shortText);
const shortLens = shortChunks.slice(0, 5).map(c => c.length);
assert.ok(shortChunks[0].length < 160, `short opening first chunk ${shortChunks[0].length}`);
assert.ok(shortChunks[1].length > shortChunks[0].length * 1.5,
  `second chunk collapsed: ${shortLens.join(", ")}`);
assert.ok(shortChunks[2].length > shortChunks[1].length, `third chunk did not grow: ${shortLens.join(", ")}`);
assert.ok(shortChunks[3].length > 300, `fourth chunk still tiny: ${shortLens.join(", ")}`);
console.log("short opening lengths:", shortLens.join(", "));

const legacyLens = legacy.slice(0, 6).map(c => c.length);
const newLens = chunks.slice(0, 8).map(c => c.length);
console.log("legacy first lengths:", legacyLens.join(", "));
console.log("progressive first lengths:", newLens.join(", "));
console.log("chunks", chunks.length, "legacy", legacy.length, "chars", norm(text).length);
console.log("chunks_node: ok");
