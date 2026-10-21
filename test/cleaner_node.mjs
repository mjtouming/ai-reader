import assert from "node:assert/strict";
import { cleanBookText } from "../public/bookCleaner.mjs";
import {
  BEIJING_INTRO,
  BODY_SENTENCE,
  CHAPTER_BODY,
  CHENGDU_PREFACE,
  PREFACE,
  SAMPLE_BEIJING,
  SAMPLE_BOOK,
  SAMPLE_CHENGDU,
  SAMPLE_PASTE,
  SAMPLE_REPORT,
  SAMPLE_SHORT_FIRST,
  SAMPLE_THREAT,
  SAMPLE_WEAK,
  THREAT_SENTENCE
} from "./frontmatter_samples.mjs";

function clean(text, source = "pdf", extra = {}) {
  return cleanBookText(text, { source, ...extra });
}

function assertKept(result, label, pieces) {
  for (const piece of pieces) {
    assert.ok(result.text.includes(piece), `${label} 应保留：${piece}`);
  }
}

function assertGone(result, label, pieces) {
  for (const piece of pieces) {
    assert.ok(!result.text.includes(piece), `${label} 应去掉：${piece}`);
  }
}

function assertUntouched(text, source, label) {
  const result = clean(text, source);
  assert.equal(result.changed, false, `${label} 不应改动`);
  assert.equal(result.text, text, `${label} 正文被改写`);
  assert.equal(result.removedChars, 0, `${label} removedChars`);
}

// (a) 典型中文书：版权页 + 多种目录去掉，序言和正文整段留下
{
  const result = clean(SAMPLE_BOOK, "txt");
  assert.equal(result.changed, true);
  assert.ok(result.removedChars > 0);
  assertGone(result, "样书", [
    "ISBN 978-7-5447-1234-5",
    "图书在版编目（CIP）数据",
    "出版发行：译林出版社",
    "版权所有 侵权必究",
    "开本：787mm×1092mm 1/32",
    "字数：210千字",
    "定价：48.00元",
    "一、起程",
    "1. 旧城",
    "第一章 旧城 ……………… 1",
    "Chapter 1  Beginning",
    "Part I  The Road",
    "Contents"
  ]);
  assertKept(result, "样书", [
    "序言",
    PREFACE,
    BODY_SENTENCE,
    "“你来了。”",
    "“嗯。”",
    "床前明月光",
    "疑是地上霜",
    "第一章 旧城\n",
    CHAPTER_BODY,
    "1. 先把灯点着",
    "2. 再把窗户打开",
    "第2章其实不是标题，这是正文里的一句话，里面提到第3章的草稿还在桌上。"
  ]);
  assert.ok(result.removed.includes("ISBN 978-7-5447-1234-5"));
  assert.ok(result.removed.includes("目录"));
}

{
  const result = clean(SAMPLE_CHENGDU, "docx");
  assertGone(result, "川版", [
    "ISBN 9787223456789",
    "出版发行：四川人民出版社",
    "版权所有 侵权必究",
    "1. 春 .........."
  ]);
  assertKept(result, "川版", ["前言", CHENGDU_PREFACE]);
}

{
  const result = clean(SAMPLE_BEIJING, "pdf");
  assertGone(result, "三联", [
    "ISBN：978-7-108-00000-0",
    "出版发行：生活·读书·新知三联书店",
    "版权所有　侵权必究",
    "第一章 北窗",
    "一、春"
  ]);
  assertKept(result, "三联", ["引言", BEIJING_INTRO]);
}

// (b)(c) 没有前置页的报告，以及会被旧规则误伤的开头
assertUntouched(SAMPLE_REPORT, "pdf", "报告");
assertUntouched(SAMPLE_THREAT, "pdf", "威胁情报报告");
assertUntouched(SAMPLE_WEAK, "txt", "弱元信息");
assertUntouched(SAMPLE_SHORT_FIRST, "docx", "短对白和诗");
assert.ok(clean(SAMPLE_THREAT, "pdf").text.includes(THREAT_SENTENCE));

// (d) 粘贴和 YouTube 字幕不清洗，哪怕内容长得像版权页
assertUntouched(SAMPLE_PASTE, "paste", "粘贴");
assertUntouched(SAMPLE_BOOK, "youtube", "YouTube");
assertUntouched(SAMPLE_BOOK, "", "未知来源");

// 书签：序言之前的整页可去，序言本身留下；没标成序言的正文页也不能被章书签带走
{
  const cover = "月光下的城\n林深 著\n";
  const copyright = [
    "ISBN 978-7-5447-1234-5",
    "出版发行：译林出版社",
    "印刷：南京先锋印刷厂",
    "开本：787mm×1092mm",
    "字数：210千字",
    "定价：48.00元",
    "版权所有 侵权必究"
  ].join("\n");
  const toc = [
    "目录",
    "第一章 旧城 ……………… 1",
    "第二章 新雪 ……………… 28",
    "第三章 离歌 ……………… 55"
  ].join("\n");
  const preface = `序言\n\n${PREFACE}\n`;
  const chapter = `第一章 旧城\n\n${CHAPTER_BODY}\n`;
  const pages = [cover, copyright, toc, preface, chapter];
  const bookmarks = [
    { level: 1, title: "封面", page: 1 },
    { level: 1, title: "版权页", page: 2 },
    { level: 1, title: "目录", page: 3 },
    { level: 1, title: "序言", page: 4 },
    { level: 1, title: "第一章 旧城", page: 5 }
  ];
  const result = clean(pages.join("\n"), "pdf", { pages, toc: bookmarks });
  assertGone(result, "有书签", ["ISBN 978-7-5447-1234-5", "第一章 旧城 ……………… 1"]);
  assertKept(result, "有书签", ["序言", PREFACE, "第一章 旧城", CHAPTER_BODY]);
}

{
  const cover = "山南\n";
  const toc = "目录\n一、春 ………… 1\n二、夏 ………… 8\n三、秋 ………… 15\n";
  const preface = `很多年后他仍然记得那个下雨的下午，序言没有单独的书签，但这段话必须留下来，一个字都不能删。\n`;
  const chapter = `第一章 旧城\n\n${CHAPTER_BODY}\n`;
  const pages = [cover, toc, preface, chapter];
  const bookmarks = [
    { level: 1, title: "封面", page: 1 },
    { level: 1, title: "目录", page: 2 },
    { level: 1, title: "第一章 旧城", page: 4 }
  ];
  const result = clean(pages.join("\n"), "pdf", { pages, toc: bookmarks });
  assert.ok(!result.text.includes("一、春"), "未标序言时仍应去掉目录页");
  assert.ok(result.text.includes("很多年后他仍然记得那个下雨的下午"), "无书签的序言页不能被第一章书签整页删掉");
  assert.ok(result.text.includes(CHAPTER_BODY));
}

{
  const pages = [1, 2, 3, 4, 5].map(i =>
    `月光下的城\n\n第${i}页的正文句子各不相同，这是第${i}句，不能丢。\n\n${i}\n`
  );
  const result = clean(pages.join("\n"), "pdf", { pages, toc: [] });
  for (let i = 1; i <= 5; i++) {
    assert.ok(result.text.includes(`这是第${i}句，不能丢。`), `页眉样本丢掉了第${i}页正文`);
  }
  assert.equal(result.text.split("月光下的城").length - 1, 1, "重复页眉只留第一次");
  assert.ok(!/(^|\n)[1-5]\n/.test(`\n${result.text}\n`), "重复页码应去掉");
}

{
  const pages = ["序言\n\n" + PREFACE, "第一章\n\n" + CHAPTER_BODY];
  const bookmarks = [{ level: 1, title: "序言", page: 1 }];
  const result = clean(pages.join("\n"), "pdf", { pages, toc: bookmarks });
  assert.equal(result.changed, false);
  assert.equal(result.text, pages.join("\n"));
}

// 斜杠/竖线页码、前导零、间隔号小节、图次表次。正文里的同名标题和广告口吻要留下。
{
  const dotLine = "战场上的俘虏·康熙母亲的娘家·孝庄的决定·消除奴籍";
  const adLine = "加小编QQ一起读书，海量资源每日更新";
  const text = [
    "一章 佟家的奴才／003",
    "二章 战场／021",
    "三章 京城／045",
    "",
    dotLine,
    "",
    "第四章 内务府的人／111",
    "第五章 京城的雪／130",
    "第六章 红票／158",
    "图3.1 …／086",
    "图3.2 南怀仁车模型图／088",
    "表1.1 八旗人口／090",
    "第七章 运河/201",
    "第八章 雪山 | 220",
    "第九章 归旗｜018",
    "",
    adLine,
    "",
    "序言",
    "",
    PREFACE,
    "",
    "第一章 旧城",
    "",
    CHAPTER_BODY,
    "1. 先把灯点着",
    "2. 再把窗户打开",
    "“你来了。”",
    "床前明月光",
    "疑是地上霜",
    "第四章 内务府的人",
    "图3.2 南怀仁车模型图",
    "战场上的俘虏·康熙母亲的娘家·这行在正文里，不能删",
    "他说加小编QQ一起读书，但这是正文，不能当成广告删掉。"
  ].join("\n");
  const result = clean(text, "txt");
  assert.equal(result.changed, true);
  assertGone(result, "红票目录", [
    "一章 佟家的奴才／003",
    "第四章 内务府的人／111",
    dotLine,
    "图3.1 …／086",
    "图3.2 南怀仁车模型图／088",
    "表1.1 八旗人口／090",
    "第七章 运河/201",
    "第八章 雪山 | 220",
    "第九章 归旗｜018",
    adLine
  ]);
  assertKept(result, "红票正文", [
    "序言",
    PREFACE,
    "第一章 旧城",
    CHAPTER_BODY,
    "1. 先把灯点着",
    "2. 再把窗户打开",
    "“你来了。”",
    "床前明月光",
    "疑是地上霜",
    "第四章 内务府的人",
    "图3.2 南怀仁车模型图",
    "战场上的俘虏·康熙母亲的娘家·这行在正文里，不能删",
    "他说加小编QQ一起读书，但这是正文，不能当成广告删掉。"
  ]);
}

console.log("cleaner_node: ok");
