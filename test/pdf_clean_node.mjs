import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanBookText } from "../public/bookCleaner.mjs";
import {
  CHAPTER_BODY,
  PREFACE,
  SAMPLE_BOOK,
  SAMPLE_THREAT,
  THREAT_SENTENCE
} from "./frontmatter_samples.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sona-pdf-"));
const font = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc";

const builder = `
import fitz, json, pathlib, sys
font = ${JSON.stringify(font)}
out = pathlib.Path(sys.argv[1])

def new_doc():
    doc = fitz.open()
    return doc

def wrap_lines(lines, width=32):
    out = []
    for line in lines:
        if line == "":
            out.append("")
            continue
        while len(line) > width:
            out.append(line[:width])
            line = line[width:]
        out.append(line)
    return out

def add_page(doc, lines):
    page = None
    y = 999
    for line in wrap_lines(lines):
        if page is None or y > 800:
            page = doc.new_page()
            page.insert_font(fontname="cjk", fontfile=font)
            y = 48
        page.insert_text((50, y), line, fontsize=10, fontname="cjk")
        y += 16
    return page

def save(doc, name, toc):
    if toc:
        doc.set_toc(toc)
    path = out / name
    doc.save(path)
    doc.close()
    return str(path)

# 有书签：封面/版权/目录在序言之前，序言和第一章要留下
marked = new_doc()
add_page(marked, ["月光下的城", "林深 著"])
add_page(marked, [
    "ISBN 978-7-5447-1234-5",
    "图书在版编目（CIP）数据",
    "出版发行：译林出版社",
    "印刷：南京先锋印刷厂",
    "开本：787mm×1092mm",
    "字数：210千字",
    "定价：48.00元",
    "版权所有 侵权必究",
])
add_page(marked, [
    "目录",
    "第一章 旧城 ……………… 1",
    "第二章 新雪 ……………… 28",
    "第三章 离歌 ……………… 55",
])
add_page(marked, ["序言", "", ${JSON.stringify(PREFACE)}])
add_page(marked, ["第一章 旧城", "", ${JSON.stringify(CHAPTER_BODY)}])
save(marked, "marked.pdf", [
    [1, "封面", 1],
    [1, "版权页", 2],
    [1, "目录", 3],
    [1, "序言", 4],
    [1, "第一章 旧城", 5],
])

# 第一章有书签，序言没有：序言页不能被整页删掉
plain_preface = "很多年后他仍然记得那个下雨的下午，这段没有书签的序言必须留下来。"
unmarked = new_doc()
add_page(unmarked, ["山南"])
add_page(unmarked, [
    "目录",
    "一、春 ………… 1",
    "二、夏 ………… 8",
    "三、秋 ………… 15",
])
add_page(unmarked, [plain_preface])
add_page(unmarked, ["第一章 旧城", "", ${JSON.stringify(CHAPTER_BODY)}])
save(unmarked, "unmarked-preface.pdf", [
    [1, "封面", 1],
    [1, "目录", 2],
    [1, "第一章 旧城", 4],
])

# 没有书签的报告
report = new_doc()
add_page(report, ${JSON.stringify(SAMPLE_THREAT.split("\\n"))})
save(report, "report.pdf", [])

# 没有书签的书：回到行级规则
book = new_doc()
add_page(book, ${JSON.stringify(SAMPLE_BOOK.split("\\n"))})
save(book, "book.pdf", [])
print("ok")
`;

await execFileAsync("python3", ["-c", builder, dir], { cwd: root });

function squash(value) {
  return String(value || "").normalize("NFKC").replace(/\s/g, "");
}

async function extract(name) {
  const { stdout } = await execFileAsync("python3", [
    path.join(root, "pdf_extract.py"),
    path.join(dir, name)
  ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error, undefined, `${name} 提取失败: ${parsed.error || stdout}`);
  assert.ok(Array.isArray(parsed.pages) && parsed.pages.length > 0, `${name} 没有页文本`);
  assert.ok(Array.isArray(parsed.toc), `${name} 没有书签字段`);
  return parsed;
}

function cleanExtract(extracted) {
  return cleanBookText(extracted.text, {
    source: "pdf",
    pages: extracted.pages,
    toc: extracted.toc
  });
}

{
  const extracted = await extract("marked.pdf");
  assert.ok(extracted.toc.some(item => item.title === "序言" && item.page === 4), "书签应指向序言所在页");
  assert.ok(extracted.toc.some(item => item.title.includes("第一章") && item.page === 5));
  const result = cleanExtract(extracted);
  assert.equal(result.changed, true);
  const kept = squash(result.text);
  assert.ok(!kept.includes("ISBN978-7-5447-1234-5"), "有书签时应去掉版权页");
  assert.ok(!kept.includes("第一章旧城………………1"), "有书签时应去掉目录页");
  assert.ok(kept.includes("序言"));
  assert.ok(kept.includes(squash(PREFACE)));
  assert.ok(kept.includes(squash(CHAPTER_BODY)));
}

{
  const extracted = await extract("unmarked-preface.pdf");
  const result = cleanExtract(extracted);
  const kept = squash(result.text);
  assert.ok(kept.includes(squash("很多年后他仍然记得那个下雨的下午，这段没有书签的序言必须留下来。")), "无书签的序言页必须留下");
  assert.ok(kept.includes(squash(CHAPTER_BODY)));
  assert.ok(!kept.includes("一、春"), "目录页仍应去掉");
}

{
  const extracted = await extract("report.pdf");
  const result = cleanExtract(extracted);
  assert.equal(result.changed, false, "报告不应被清洗");
  assert.equal(result.text, extracted.text);
  const kept = squash(result.text);
  assert.ok(kept.includes(squash(THREAT_SENTENCE)));
  assert.ok(kept.includes("第1章观察"));
  assert.ok(kept.includes("“收到。”"));
  assert.ok(kept.includes("白日依山尽"));
  assert.ok(kept.includes("1.样本没有被污染"));
}

{
  const extracted = await extract("book.pdf");
  assert.equal(extracted.toc.length, 0);
  const result = cleanExtract(extracted);
  assert.equal(result.changed, true);
  const kept = squash(result.text);
  assert.ok(!kept.includes("ISBN978-7-5447-1234-5"));
  assert.ok(!kept.includes("版权所有侵权必究"));
  assert.ok(!kept.includes("Chapter1Beginning"));
  assert.ok(kept.includes("序言"));
  assert.ok(kept.includes(squash(PREFACE)));
  assert.ok(kept.includes(squash(CHAPTER_BODY)));
  assert.ok(kept.includes("1.先把灯点着"));
  assert.ok(kept.includes("“你来了。”"));
}

console.log("pdf_clean_node: ok");
