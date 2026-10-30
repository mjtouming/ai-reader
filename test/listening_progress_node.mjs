import assert from "node:assert/strict";
import { listeningProgress, formatPlaybackTime } from "../public/listeningProgress.mjs";

const cases = [
  [13, 7, 192, 400, 58],
  [4, 0, 0, 100, 0],
  [4, 0, 50, 100, 13],
  [4, 1, 0, 100, 25],
  [4, 2, 50, 100, 63],
  [4, 3, 100, 100, 100],
  [4, 4, 0, 0, 100],
  [0, 0, 20, 100, 0],
  [4, 1, 20, NaN, 25],
  [4, 1, 20, Infinity, 25],
  [4, 1, -20, 100, 25],
  [4, 1, 200, 100, 50],
  [4, 1, NaN, 100, 25],
  [4, -1, 0, 100, 0],
  [4, 9, 50, 100, 100]
];
for (const [total, index, time, duration, percent] of cases) {
  const progress = listeningProgress(total, index, time, duration);
  assert.equal(progress.percent, percent, JSON.stringify({ total, index, time, duration }));
  assert.ok(progress.ratio >= 0 && progress.ratio <= 1);
}
assert.equal(listeningProgress(40, 0, 0, 1).continuous, false);
assert.equal(listeningProgress(41, 0, 0, 1).continuous, true);
assert.equal(formatPlaybackTime(599, true), "09:59");
assert.equal(formatPlaybackTime(192), "3:12");
assert.equal(formatPlaybackTime(NaN, true), "00:00");
console.log(`listening_progress_node: ${cases.length} percentage boundaries, >40 fallback and clock formatting ok`);
