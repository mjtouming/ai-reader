function referenceKey(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripLinks(text, references) {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const image = text[index] === "!" && text[index + 1] === "[";
    const start = index + (image ? 1 : 0);
    if (text[start] !== "[") {
      result += text[index];
      continue;
    }
    let depth = 1;
    let end = start + 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === "\\") end++;
      else if (text[end] === "[") depth++;
      else if (text[end] === "]") depth--;
    }
    if (depth) {
      result += text[index];
      continue;
    }
    const label = text.slice(start + 1, end - 1);
    let next = end;
    let linked = false;
    if (text[next] === "(") {
      depth = 1;
      for (next++; next < text.length && depth; next++) {
        if (text[next] === "\\") next++;
        else if (text[next] === "(") depth++;
        else if (text[next] === ")") depth--;
      }
      linked = depth === 0;
    } else if (text[next] === "[") {
      const close = text.indexOf("]", next + 1);
      if (close !== -1 && references.has(referenceKey(text.slice(next + 1, close) || label))) {
        next = close + 1;
        linked = true;
      }
    } else if (references.has(referenceKey(label))) {
      linked = true;
    }
    if (!linked) {
      result += text[index];
      continue;
    }
    result += stripLinks(label, references);
    index = next - 1;
  }
  return result;
}

function inlineText(text, references) {
  const literals = [];
  const protect = value => `\u0000${literals.push(value) - 1}\u0000`;
  let result = text
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, (_, literal) => protect(literal))
    .replace(/(`+)([\s\S]*?)\1(?!`)/g, (_, marker, code) => protect(code.replace(/\n/g, " ").trim()));
  result = stripLinks(result, references)
    .replace(/<https?:\/\/[^>]+>/gi, "")
    .replace(/<([\w.+-]+@[\w.-]+)>/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "");
  for (let pass = 0; pass < 3; pass++) {
    result = result
      .replace(/(\*\*|__|~~)(?=\S)(.+?\S|\S)\1/g, "$2")
      .replace(/\*(?=\S)([^*\n]*\S|\S)\*/g, "$1")
      .replace(/(^|[^\w])_(?=\S)([^_\n]*\S|\S)_(?!\w)/g, "$1$2");
  }
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return result
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
      if (name[0] !== "#") return entities[name.toLowerCase()];
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\u0000(\d+)\u0000/g, (_, index) => literals[Number(index)])
    .replace(/[ \t]+\n/g, "\n");
}

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
}

function isRule(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*)$/.test(line);
}

export function markdownToText(markdown) {
  let text = String(markdown ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  text = text.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, "");
  const lines = text.split("\n");
  const prose = [];
  let fence = null;
  let indented = false;
  let inList = false;
  for (const rawLine of lines) {
    let line = rawLine.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      prose.push("");
      continue;
    }
    if (isRule(line)) {
      prose.push("");
      continue;
    }
    line = line.replace(/^\s*[-+*][ \t]+(?:\[[ xX]\][ \t]+)?/, "").replace(/^\s*\d+[.)][ \t]+/, "");
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = opening[1];
      prose.push("");
      continue;
    }
    if (line !== rawLine.replace(/^(?: {0,3}>[ \t]?)+/, "")) inList = true;
    else if (line.trim() && !/^(?: {4}|\t)/.test(line)) inList = false;
    if (/^(?: {4}|\t)/.test(line) && !inList && (indented || !prose.length || !prose[prose.length - 1].trim())) {
      indented = true;
      prose.push("");
      continue;
    }
    if (line.trim()) indented = false;
    prose.push(line);
  }
  text = prose.join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/?(?:p|div|h[1-6]|li|tr|blockquote|section|article)\b[^>]*>/gi, "\n");
  const references = new Set();
  text = text.replace(/^ {0,3}\[([^\]\n]+)\]:[^\n]*(?:\n[ \t]+["'(][^\n]*["')][ \t]*)?/gm, (_, label) => {
    references.add(referenceKey(label));
    return "";
  });
  const blocks = text.split("\n");
  const output = [];
  let inTable = false;
  for (let index = 0; index < blocks.length; index++) {
    let line = blocks[index];
    const separator = value => value.includes("|") && tableCells(value).every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
    if (index + 1 < blocks.length && separator(blocks[index + 1]) && line.includes("|")) {
      inTable = true;
      index++;
    } else if (!line.trim() || !line.includes("|")) {
      inTable = false;
    }
    if (isRule(line)) line = "";
    line = line.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, "").replace(/[ \t]+#+[ \t]*$/, "");
    output.push(inTable
      ? tableCells(line).map(cell => inlineText(cell.trim(), references)).filter(Boolean).join("，")
      : inlineText(line, references).trim());
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
