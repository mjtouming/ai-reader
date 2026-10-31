// 原文模式第 1 段：只有确认是现代汉语才跳过改写。
// 漏判会把古文直接读出来；误判只是多一次短改写。

export function textLikelyNeedsTranslation(text) {
  if (!text) return false;
  const sample = String(text).slice(0, 300);
  const meaningful = sample.replace(/[\s\d\p{P}]/gu, "");
  if (!meaningful) return false;

  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk / meaningful.length < 0.6) return true;
  if (cjk < 20) return false;

  const modern = (sample.match(/[的了们这那吗呢吧着么]|没有|一个|什么|就是|因为|所以|我们|他们|自己|已经|可以/g) || []).length;
  const classical = (sample.match(/[之乎者也矣焉哉兮曰亦其而於吾汝尔乃皆莫弗遂耳欤邪兹]/g) || []).length;
  const perHundred = count => count * 100 / cjk;
  if (perHundred(modern) < 1.5) return true;
  if (classical >= 3 && perHundred(classical) > perHundred(modern)) return true;
  return false;
}
