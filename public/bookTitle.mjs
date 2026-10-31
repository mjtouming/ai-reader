// 文件名只在它和当前正文仍是同一份文本时才当标题。
// 粘贴了新内容之后，改用第一条非空行：不超过 24 字直接用；
// 没有句读、最多 60 字的标题行也整行用（英文标题常超过 24 个字符）；
// 否则取第一句，超过 20 字就截到 16–20 字并加上省略号。

function sameText(a, b) {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

function stripTitleLine(line) {
  return String(line || "")
    .replace(/[《》〈〉「」『』“”""]/g, "")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function clipTitle(sentence) {
  if (sentence.length <= 20) return sentence;
  let end = 18;
  const window = sentence.slice(16, 21);
  const spaceAt = window.lastIndexOf(" ");
  if (spaceAt >= 0) end = 16 + spaceAt;
  if (end < 16) end = 16;
  if (end > 20) end = 20;
  const cut = sentence.slice(0, end).trimEnd();
  return (cut.length >= 16 ? cut : sentence.slice(0, 16)) + "…";
}

export function titleFromText(text, now = new Date()) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) {
    const date = now instanceof Date ? now : new Date(now);
    return `未命名书籍 ${date.toISOString().slice(0, 10)}`;
  }
  const firstLine = raw.split("\n").map(line => line.trim()).find(Boolean) || "";
  let line = stripTitleLine(firstLine);
  if (!line) line = firstLine.trim();
  const hasSentenceBreak = /[。！？；，：:!?.]/.test(line);
  if (line.length <= 24 || (line.length <= 60 && !hasSentenceBreak)) return line;
  const sentence = stripTitleLine(line.split(/[。！？；，：:!?.]+/).find(part => part.trim()) || line);
  return clipTitle(sentence || line);
}

export function fileNameApplies(fileName, fileNameText, text, frontMatter) {
  if (!fileName || fileNameText == null) return false;
  if (sameText(text, fileNameText)) return true;
  if (!frontMatter) return false;
  const cleaned = frontMatter.cleaned;
  const original = frontMatter.original;
  const boundToThisBook = sameText(fileNameText, cleaned) || sameText(fileNameText, original);
  if (!boundToThisBook) return false;
  return sameText(text, cleaned) || sameText(text, original);
}

export function deriveDisplayTitle({ fileName, fileNameText, text, frontMatter, now }) {
  if (fileNameApplies(fileName, fileNameText, text, frontMatter)) return fileName;
  return titleFromText(text, now);
}

export function shelfNames(opts) {
  const title = deriveDisplayTitle(opts);
  const bound = fileNameApplies(opts.fileName, opts.fileNameText, opts.text, opts.frontMatter);
  return { title, fileName: bound ? opts.fileName : title };
}
