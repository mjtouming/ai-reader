// 书籍前置内容清洗。只删高置信的版权页和目录，而且只看文档前部。
// 拿不准就留下：序言、前言、正文里的编号列表和章节标题都要能读到。

const BOOK_SOURCES = new Set(["pdf", "docx", "txt", "epub"]);

const COPYRIGHT_RULES = [
  ["isbn", /ISBN|书号/i],
  ["isbn", /97[89][\d\-]{9,}/],
  ["cip", /图书在版编目|CIP\s*数据|数据核字|中国版本图书馆|\bCIP\b/i],
  ["rights", /版权所有|侵权必究|著作权|All rights reserved|©/i],
  ["rights", /^版权(声明|信息|页)?$/],
  ["publish", /出版发行|出版社|出版者/],
  ["print", /印刷|开本|印张|印次|版次|装帧|字数|千字|插页/],
  ["price", /定价|人民币/],
  ["staff", /责任编辑|封面设计|责任校对|策划编辑|责任印制|责任技术/]
];

const TOC_HEADING = /^(目录|目\s*录|contents|table\s+of\s+contents)\s*$/i;
const LEADER = /(?:[.\u00b7\u2022\u2026\u30fb\uff0e\u2027]{2,}|[-—–_]{3,})/;
const PREFACE_TITLE = /^(序言|序章|自序|代序|他序|前言|引言|楔子|导言|导读|作者序|译者序|译者前言|推荐序|编辑序|卷首语|开篇)/;

function compactLen(s) {
  return String(s || "").replace(/\s/g, "").length;
}

function copyrightCategory(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 120) return null;
  if (/[。！？!?]/.test(t) && t.length > 36) return null;
  for (const [id, re] of COPYRIGHT_RULES) {
    if (re.test(t)) return id;
  }
  return null;
}

function isBodyProse(line) {
  const t = String(line || "").trim();
  return t.length >= 36 && /[。！？!?]/.test(t);
}

function substantialProseBefore(lines, index) {
  let n = 0;
  for (let i = 0; i < index; i++) {
    if (isBodyProse(lines[i])) n++;
    if (n >= 2) return true;
  }
  return false;
}

function isTocHeading(line) {
  return TOC_HEADING.test(String(line || "").trim());
}

function trailingPageNumber(line) {
  const m = String(line || "").trim().match(/\s(\d{1,4})$/);
  if (!m) return false;
  if (m[1].length === 4 && /^(19|20)/.test(m[1])) return false;
  return true;
}

function isTocEntry(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 80 || isTocHeading(t)) return false;
  if (LEADER.test(t) && /\d{1,4}\s*$/.test(t)) {
    const title = t.replace(LEADER, " ").replace(/\d{1,4}\s*$/, "").trim();
    if (title.length >= 1 && title.length <= 40) return true;
  }
  if (!trailingPageNumber(t) || t.length > 40) return false;
  if (/^第[0-9零一二三四五六七八九十百千万]+\s*[章节回部篇卷]/.test(t)) return true;
  if (/^(chapter|part)\s+[0-9ivxlcdm]+\b/i.test(t)) return true;
  if (/^[一二三四五六七八九十百千]+\s*[、.．]/.test(t)) return true;
  if (/^\d{1,2}\s*[.、．]\s*\S/.test(t)) return true;
  return false;
}

function findCopyrightSpans(lines) {
  const limit = Math.min(lines.length, 360);
  const cats = lines.map(copyrightCategory);
  const spans = [];
  let i = 0;
  while (i < limit) {
    if (!cats[i]) {
      i++;
      continue;
    }
    if (substantialProseBefore(lines, i)) break;

    let j = i;
    let lastSignal = i;
    let weak = 0;
    let blanks = 0;
    while (j < limit && j < i + 90) {
      if (cats[j]) {
        lastSignal = j;
        weak = 0;
        blanks = 0;
        j++;
        continue;
      }
      const raw = lines[j].trim();
      if (!raw) {
        blanks++;
        if (blanks > 8) break;
        j++;
        continue;
      }
      blanks = 0;
      if (isBodyProse(raw)) break;
      weak++;
      if (weak > 6) break;
      j++;
    }

    const categories = new Set();
    let signals = 0;
    for (let k = i; k <= lastSignal; k++) {
      if (!cats[k]) continue;
      categories.add(cats[k]);
      signals++;
    }
    if (categories.size >= 3 && signals >= 3) {
      spans.push([i, lastSignal]);
      i = lastSignal + 1;
    } else {
      i++;
    }
  }
  return spans;
}

function findTocSpans(lines) {
  const limit = Math.min(lines.length, 480);
  const spans = [];
  let i = 0;
  while (i < limit) {
    if (!isTocEntry(lines[i])) {
      i++;
      continue;
    }
    if (substantialProseBefore(lines, i)) break;

    let last = i;
    let count = 1;
    let j = i + 1;
    let weak = 0;
    while (j < limit) {
      const raw = lines[j].trim();
      if (!raw) {
        j++;
        continue;
      }
      if (isTocEntry(raw) || isTocHeading(raw)) {
        if (isTocEntry(raw)) {
          last = j;
          count++;
        } else {
          last = j;
        }
        weak = 0;
        j++;
        continue;
      }
      if (raw.length <= 24 && !/[。！？!?]/.test(raw)) {
        weak++;
        if (weak > 2) break;
        j++;
        continue;
      }
      break;
    }

    let headingAt = -1;
    for (let h = i - 1; h >= Math.max(0, i - 6); h--) {
      const raw = lines[h].trim();
      if (!raw) continue;
      if (isTocHeading(raw)) {
        headingAt = h;
        break;
      }
      if (raw.length > 24 || /[。！？!?]/.test(raw)) break;
    }
    const headed = headingAt !== -1;
    if ((headed && count >= 3) || count >= 4) {
      const nonEmpty = lines.slice(headingAt === -1 ? i : headingAt, last + 1)
        .filter(line => line.trim()).length;
      if (nonEmpty > 0 && count / nonEmpty >= 0.5) {
        spans.push([headingAt === -1 ? i : headingAt, last]);
        i = last + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

function removeMarkedLines(lines, spans) {
  if (!spans.length) return null;
  const drop = new Set();
  for (const [start, end] of spans) {
    for (let i = start; i <= end; i++) drop.add(i);
  }
  const removed = [];
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) removed.push(lines[i]);
    else kept.push(lines[i]);
  }
  while (kept.length && kept[0].trim() === "") kept.shift();
  return { text: kept.join("\n"), removed: removed.join("\n") };
}

// 规则清洗：版权信息要聚成一页（至少三类关键词），目录条目要带页码或点线。
export function removeFrontMatterLines(text) {
  const original = String(text ?? "");
  const normalized = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const spans = findCopyrightSpans(lines).concat(findTocSpans(lines));
  const result = removeMarkedLines(lines, spans);
  if (!result) return { text: original, removed: "", changed: false };
  return { text: result.text, removed: result.removed, changed: true };
}

function isPrefaceBookmark(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/^序$/.test(t)) return true;
  return PREFACE_TITLE.test(t);
}

function isBodyBookmark(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/^正文(?:\s|$)/.test(t)) return true;
  if (/^第\s*[0-9零一二三四五六七八九十百千万]+\s*[章回部篇卷]/.test(t)) return true;
  if (/^(?:chapter|part)\s+[0-9ivxlcdm]+\b/i.test(t)) return true;
  return false;
}

function findAnchorPage(toc) {
  if (!Array.isArray(toc)) return null;
  for (const item of toc) {
    if (!isPrefaceBookmark(item && item.title) && !isBodyBookmark(item && item.title)) continue;
    const page = Number(item.page);
    if (Number.isFinite(page) && page >= 1) return page;
  }
  return null;
}

function pageIsSkippableFront(pageText) {
  const lines = String(pageText || "").split(/\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return true;
  let prose = 0;
  let signal = 0;
  for (const line of lines) {
    if (isBodyProse(line)) prose++;
    if (copyrightCategory(line) || isTocEntry(line) || isTocHeading(line)) signal++;
  }
  if (prose >= 1) return false;
  if (signal >= 3 && signal / lines.length >= 0.35) return true;
  if (lines.length <= 2 && lines.every(line => line.length <= 30)) return true;
  if (signal >= 1 && lines.length <= 6 && lines.every(line => line.length <= 36)) return true;
  return false;
}

function firstLastNonEmpty(pageText) {
  const lines = String(pageText || "").replace(/\r/g, "").split("\n");
  const idxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) idxs.push(i);
  }
  if (!idxs.length) return { lines, first: -1, last: -1 };
  return { lines, first: idxs[0], last: idxs[idxs.length - 1] };
}

function mostCommon(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item) continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [item, n] of counts) {
    if (n > bestN) {
      best = item;
      bestN = n;
    }
  }
  return { value: best, count: bestN };
}

function isPageNumberLine(line) {
  return /^[（(\[【\s\-—–]*\d{1,4}[）)\]】\s\-—–]*$/.test(String(line || "").trim())
    || /^第\s*\d{1,4}\s*页$/.test(String(line || "").trim());
}

// 同一短行在大多数页的页首重复，才当成页眉去掉；每一页的第一次出现留下。
function stripRunningFurniture(pages) {
  if (!Array.isArray(pages) || pages.length < 4) {
    return { pages: pages || [], removed: "" };
  }
  const edges = pages.map(firstLastNonEmpty);
  const headers = edges.map(edge => edge.first >= 0 ? edge.lines[edge.first].trim() : "");
  const headerPick = mostCommon(headers.filter(line =>
    line &&
    line.length <= 20 &&
    !/[。！？!?]/.test(line) &&
    !/^第[0-9零一二三四五六七八九十百千万]+[章节回部篇卷]/.test(line) &&
    !isPageNumberLine(line)
  ));
  const headerOk = headerPick.value && headerPick.count >= 3 && headerPick.count / pages.length >= 0.6;

  const footers = edges.map(edge => edge.last >= 0 ? edge.lines[edge.last].trim() : "");
  const footerCount = footers.filter(isPageNumberLine).length;
  const footerOk = footerCount >= 3 && footerCount / pages.length >= 0.6;

  if (!headerOk && !footerOk) return { pages, removed: "" };

  const removed = [];
  let headerKept = false;
  const next = pages.map((page, index) => {
    const edge = edges[index];
    if (edge.first < 0) return page;
    const drop = new Set();
    if (headerOk && headers[index] === headerPick.value) {
      if (headerKept) drop.add(edge.first);
      else headerKept = true;
    }
    if (footerOk && isPageNumberLine(footers[index]) && edge.last !== edge.first) {
      drop.add(edge.last);
    }
    if (!drop.size) return page;
    for (const lineNo of drop) removed.push(edge.lines[lineNo]);
    return edge.lines.filter((_, lineNo) => !drop.has(lineNo)).join("\n");
  });
  return { pages: next, removed: removed.join("\n") };
}

function cleanPages(pages, toc) {
  const anchor = findAnchorPage(toc);
  let drop = 0;
  if (anchor && anchor > 1) {
    const maxDrop = Math.min(anchor - 1, pages.length, 40);
    for (let i = 0; i < maxDrop; i++) {
      if (!pageIsSkippableFront(pages[i])) break;
      drop++;
    }
  }
  const removedParts = [];
  if (drop > 0) removedParts.push(pages.slice(0, drop).join("\n"));
  const kept = pages.slice(drop);
  const furniture = stripRunningFurniture(kept);
  if (furniture.removed) removedParts.push(furniture.removed);
  const joined = furniture.pages.join("\n");
  const lined = removeFrontMatterLines(joined);
  if (lined.changed && lined.removed) removedParts.push(lined.removed);
  return {
    text: lined.changed ? lined.text : joined,
    removed: removedParts.filter(Boolean).join("\n\n")
  };
}

export function cleanBookText(text, opts = {}) {
  const source = opts && opts.source;
  const input = String(text ?? "");
  if (!BOOK_SOURCES.has(source)) {
    return { text: input, original: input, removed: "", removedChars: 0, changed: false };
  }

  const pages = Array.isArray(opts.pages) && opts.pages.length ? opts.pages : null;
  let cleaned = input;
  let removed = "";
  if (pages) {
    const pageResult = cleanPages(pages, opts.toc || []);
    cleaned = pageResult.text;
    removed = pageResult.removed;
  } else {
    const lined = removeFrontMatterLines(input);
    cleaned = lined.text;
    removed = lined.removed;
  }

  const removedChars = Math.max(0, compactLen(input) - compactLen(cleaned));
  if (removedChars === 0) {
    return { text: input, original: input, removed: "", removedChars: 0, changed: false };
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return {
    text: cleaned,
    original: input,
    removed,
    removedChars,
    changed: true
  };
}
