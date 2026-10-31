import assert from "node:assert/strict";
import fs from "node:fs";
import { deriveDisplayTitle, fileNameApplies, shelfNames, titleFromText } from "../public/bookTitle.mjs";
import { textLikelyNeedsTranslation } from "../public/classicalDetect.mjs";
import { normalizeDashesForSpeech } from "../public/speechText.mjs";
import {
  buildReadingChunks,
  mergeStoryTail,
  needsStoryWholeRewrite,
  planPlaybackChunks,
  STORY_TAIL_MIN,
  STORY_WHOLE_MAX
} from "../public/readingChunks.mjs";
import {
  ANNOUNCER_PROMPT,
  buildStoryUserContent,
  COMMON_RULES,
  REWRITE_PROMPT_VERSION,
  rewriteKeyMaterial,
  selectRewriteSettings,
  STORY_PROMPT,
  STORY_TEMPERATURE,
  storyLengthTarget
} from "../public/rewritePrompts.mjs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

const defaultText = `
臣亮言：先帝创业未半而中道崩殂。今天下三分，益州疲弊，此诚危急存亡之秋也。
然侍卫之臣不懈于内，忠志之士忘身于外者，盖追先帝之殊遇，欲报之于陛下也。
诚宜开张圣听，以光先帝遗德，恢弘志士之气，不宜妄自菲薄，引喻失义，以塞忠谏之路也。
`.trim();

const english = "How to fix your entire life in 1 day\n\nMost people try to change their life by setting goals.";
const mulanPaste = "木兰辞\n\n乐府诗集 〔南北朝〕\n\n唧唧复唧唧，木兰当户织。不闻机杼声，唯闻女叹息。\n(唯 一作：惟)";

assert.equal(titleFromText("木兰辞"), "木兰辞");
assert.equal(titleFromText("《木兰辞》\n\n正文"), "木兰辞");
assert.equal(titleFromText(english), "How to fix your entire life in 1 day");
assert.equal(titleFromText(defaultText), "臣亮言");
assert.equal(titleFromText("", new Date("2026-10-31T12:00:00Z")), "未命名书籍 2026-10-31");

const longLine = "这是一个没有标点的超长第一行专门用来检查截断" + "补".repeat(40);
assert.ok(longLine.length > 60, `fixture length ${longLine.length}`);
const clipped = titleFromText(longLine);
assert.ok(clipped.endsWith("…"));
assert.ok(clipped.length >= 17 && clipped.length <= 21, clipped);

const uploaded = shelfNames({
  fileName: "How to fix your entire life in 1 day",
  fileNameText: english,
  text: english
});
assert.equal(uploaded.title, "How to fix your entire life in 1 day");
assert.equal(uploaded.fileName, "How to fix your entire life in 1 day");

const pasted = shelfNames({
  fileName: "How to fix your entire life in 1 day",
  fileNameText: english,
  text: mulanPaste
});
assert.equal(pasted.title, "木兰辞");
assert.equal(pasted.fileName, "木兰辞");

const firstVisit = shelfNames({
  fileName: "出师表节选",
  fileNameText: defaultText,
  text: defaultText
});
assert.equal(firstVisit.title, "出师表节选");
assert.equal(firstVisit.fileName, "出师表节选");

const cleaned = "正文开始。后面还有。";
const original = "目录\n\n" + cleaned;
assert.equal(deriveDisplayTitle({
  fileName: "我的书",
  fileNameText: cleaned,
  text: original,
  frontMatter: { cleaned, original }
}), "我的书");
assert.equal(fileNameApplies("旧文件", english, mulanPaste, null), false);
assert.equal(fileNameApplies("出师表节选", null, defaultText, null), false);

const youtube = deriveDisplayTitle({
  fileName: "Actual Video Title",
  fileNameText: "Welcome back\n\nToday we talk.",
  text: "Welcome back\n\nToday we talk."
});
assert.equal(youtube, "Actual Video Title");

const mulanChunk = `木兰辞

乐府诗集 〔南北朝〕

唧唧复唧唧，木兰当户织。不闻机杼声，唯闻女叹息。
(唯 一作：惟)

问女何所思，问女何所忆。女亦无所思，女亦无所忆。昨夜见军帖，可汗大点兵，军书十二卷，卷卷有爷名。阿爷无大儿，木兰无长兄，愿为市鞍马，从此替爷征。

东市买骏马，西市买鞍鞯，南市买辔头，北市买长鞭。`;
const samples = {
  "木兰辞第1段": [mulanChunk, true],
  "静夜思": ["床前明月光，疑是地上霜。举头望明月，低头思故乡。", true],
  "出师表": [defaultText, true],
  "英文": ["How to fix your entire life in 1 day. Most people try to change their life by setting goals.", true],
  "现代叙述": ["过去八个月，我们的威胁情报团队持续追踪了多个利用人工智能实施诈骗的团伙。这些团伙往往先在社交平台上建立信任，然后再诱导受害者下载伪装成投资工具的应用。", false],
  "白话译文": ["早晨辞别爹娘出发，傍晚宿在黄河边。听不到爹娘呼唤女儿的声音，只听见黄河流水哗哗作响。", false]
};
for (const [name, [text, expected]] of Object.entries(samples)) {
  assert.equal(textLikelyNeedsTranslation(text), expected, name);
}
assert.equal(
  textLikelyNeedsTranslation("国务院新闻办公室今天上午举行发布会，介绍前三季度国民经济运行情况。国家统计局新闻发言人表示，前三季度国内生产总值同比增长百分之五点二，经济运行总体平稳。"),
  true,
  "功能词很少的新闻通稿宁可送去改写"
);

assert.equal(normalizeDashesForSpeech("这帮人一抬头——哟。"), "这帮人一抬头，哟。");
assert.equal(normalizeDashesForSpeech("抓起包——\n"), "抓起包。\n");
assert.equal(normalizeDashesForSpeech("轰—"), "轰。");
assert.equal(normalizeDashesForSpeech("啾啾——啾啾——"), "啾啾，啾啾。");
assert.equal(normalizeDashesForSpeech("抬头——。"), "抬头。");
assert.equal(normalizeDashesForSpeech("抬头——，哟"), "抬头，哟");
assert.equal(normalizeDashesForSpeech("保留……省略号"), "保留……省略号");
assert.equal(normalizeDashesForSpeech("没有破折号。"), "没有破折号。");
assert.equal(normalizeDashesForSpeech("state-of-the-art"), "state-of-the-art");

const tail = ["甲".repeat(200), "乙".repeat(52)];
const merged = mergeStoryTail(tail);
assert.equal(STORY_TAIL_MIN, 100);
assert.equal(merged.length, 1);
assert.ok(merged[0].endsWith("乙".repeat(52)));
assert.equal(mergeStoryTail(tail)[0] === tail[0], false, "不要改原数组");
assert.deepEqual(mergeStoryTail(["甲".repeat(200), "乙".repeat(100)]).map(item => item.length), [200, 100]);
assert.deepEqual(mergeStoryTail(["只有一段"]), ["只有一段"]);

assert.equal(STORY_WHOLE_MAX, 2000);
assert.equal(needsStoryWholeRewrite("甲".repeat(2000), "story"), true);
assert.equal(needsStoryWholeRewrite("甲".repeat(2001), "story"), false);
assert.equal(needsStoryWholeRewrite("甲".repeat(100), "original"), false);

const sentence = "甲".repeat(90) + "。";
const rewritten = Array.from({ length: 16 }, () => sentence).concat(["乙".repeat(52)]).join("\n\n");
const rewrittenChunks = buildReadingChunks(rewritten);
assert.equal(rewrittenChunks.at(-1).length, 52);
const script = planPlaybackChunks("木兰辞\n\n唧唧复唧唧。", "story", rewritten);
assert.equal(script.script, true);
assert.equal(script.chunks.length, rewrittenChunks.length - 1);
assert.ok(script.chunks.at(-1).includes("乙".repeat(52)));
assert.equal(script.sourceChunks.join("\n"), buildReadingChunks("木兰辞\n\n唧唧复唧唧。").join("\n"));
const asOriginal = planPlaybackChunks(rewritten, "original");
assert.equal(asOriginal.script, false);
assert.equal(asOriginal.chunks.at(-1).length, 52);
const longStory = planPlaybackChunks("甲".repeat(2001), "story");
assert.equal(longStory.script, false);
assert.deepEqual(longStory.chunks, mergeStoryTail(longStory.sourceChunks));

assert.equal(STORY_TEMPERATURE, 0.9);
assert.equal(selectRewriteSettings("story").temperature, 0.9);
assert.equal(selectRewriteSettings("story").roleName, "STORYTELLER");
assert.equal(selectRewriteSettings("translate").temperature, 0.2);
assert.equal(selectRewriteSettings("translate").roleName, "TRANSLATE");
assert.equal(selectRewriteSettings("original").temperature, 0.4);
assert.equal(selectRewriteSettings("announcer").roleName, "ANNOUNCER");
assert.equal(REWRITE_PROMPT_VERSION, "20261031-4");
assert.equal(rewriteKeyMaterial("木兰", "story"), "prompt-20261031-4|木兰|story");
assert.equal(rewriteKeyMaterial("木兰", "story", "whole"), "prompt-20261031-4|whole|木兰|story");
assert.deepEqual(storyLengthTarget(52), { min: 156, max: 260 });
assert.deepEqual(storyLengthTarget(430), { min: 1290, max: 2150 });

const bans = STORY_PROMPT.match(/禁止使用破折号[^\n]*/g) || [];
assert.ok(bans.length >= 1);
const withoutBan = bans.reduce((text, line) => text.replace(line, ""), STORY_PROMPT);
assert.equal(withoutBan.includes("—"), false);
assert.match(STORY_PROMPT, /砰。/);
assert.match(STORY_PROMPT, /抖包袱/);
assert.match(STORY_PROMPT, /以今说古/);
assert.match(STORY_PROMPT, /跟听众搭话/);
assert.match(STORY_PROMPT, /开头好玩，中间好玩，结尾一样好玩/);
assert.match(STORY_PROMPT, /结尾不单独来一段升华总结/);
assert.match(STORY_PROMPT, /姓氏/);
assert.match(STORY_PROMPT, /3 到 5 倍/);
assert.equal(STORY_PROMPT.includes("300 到 400 字"), false);
assert.equal(STORY_PROMPT.includes("拟声词只用原文"), false);
assert.equal(STORY_PROMPT.includes("宁可不点评"), false);
assert.match(COMMON_RULES, /一作/);
assert.match(ANNOUNCER_PROMPT, /只直译/);
assert.match(ANNOUNCER_PROMPT, /乐府诗集/);

const tailPrompt = buildStoryUserContent({
  source: "乙".repeat(52),
  previous: "他一抬头——哟。",
  chunkLabel: "3/3",
  nextPreview: "",
  whole: false
});
assert.match(tailPrompt, /原文 52 字/);
assert.match(tailPrompt, /156 到 260 字/);
assert.match(tailPrompt, /3 到 5 倍/);
assert.equal(tailPrompt.includes("最多 0 处"), false);
assert.equal(/最多 \d+ 处/.test(tailPrompt), false);
assert.match(tailPrompt, /总结升华/);
assert.match(tailPrompt, /他一抬头，哟。/);
assert.equal(tailPrompt.includes("—"), false);
assert.equal(tailPrompt.includes("下一段原文"), false);

const middlePrompt = buildStoryUserContent({
  source: "甲".repeat(224),
  previous: "",
  chunkLabel: "1/3",
  nextPreview: "旦辞爷娘去，暮宿黄河边。" + "后".repeat(180),
  whole: false
});
assert.match(middlePrompt, /这是第一段/);
assert.match(middlePrompt, /不要提前收尾/);
assert.match(middlePrompt, /旦辞爷娘去，暮宿黄河边。/);
assert.equal(middlePrompt.includes("后".repeat(101)), false);
assert.equal(middlePrompt.includes("—"), false);

const wholePrompt = buildStoryUserContent({
  source: "木".repeat(430),
  previous: "不应出现",
  chunkLabel: "全文",
  nextPreview: "不应出现的下一段",
  whole: true
});
assert.match(wholePrompt, /一次讲完/);
assert.match(wholePrompt, /原文 430 字/);
assert.match(wholePrompt, /1290 到 2150 字/);
assert.match(wholePrompt, /总结升华/);
assert.equal(/最多 \d+ 处/.test(wholePrompt), false);
assert.equal(wholePrompt.includes("不应出现"), false);

assert.match(app, /currentFileName\s*=\s*"出师表节选";\s*currentFileNameText = defaultText;/);
assert.match(app, /isOriginalFirstChunk && !textLikelyNeedsTranslation\(textToSend\)/);
assert.match(app, /rewriteStoryWhole/);
assert.match(html, /app\.js\?v=20261031-4/);
assert.match(html, /style\.css\?v=20261031-4/);
assert.match(html, /title:\s*'灵听'/);
assert.equal(html.includes("20261031-3"), false);
assert.equal(app.includes("20261031-3"), false);
assert.match(server, /"--sub-langs", "en"/);
assert.match(server, /"--print", "%\(title\)s"/);
assert.match(server, /rewriteKeyMaterial/);
assert.match(server, /app\.post\("\/rewrite-story"/);
const normalizedAt = server.indexOf("normalizeDashesForSpeech(inputText)");
const keyAt = server.indexOf("const ttsKey");
assert.ok(normalizedAt > 0 && keyAt > normalizedAt);
assert.match(server, /update\(spokenText \+ "\|"/);
assert.equal(server.includes("0.92"), false);
assert.equal(server.includes("STORY_PROMPT"), false);

console.log("reader_fixes_node: ok");
