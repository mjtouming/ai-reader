import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { markdownToText } from "../public/markdownText.mjs";

const cases = [
  ["YAML", "---\ntitle: 不朗读\ntags: [书]\n---\n# 正文", "正文"],
  ["BOM、CRLF", "\uFEFF---\r\ntitle: 不朗读\r\n---\r\n正文\r\n换行", "正文\n换行"],
  ["不是开头的 YAML", "正文\n---\ntitle: 保留\n---", "正文\n\ntitle: 保留"],
  ["不完整 YAML 保留正文", "---\ntitle: 未闭合\n正文", "title: 未闭合\n正文"],
  ["标题", "# 一级\n## 二级 ##\n###### 六级\n七级标题\n=======", "一级\n二级\n六级\n七级标题"],
  ["样式", "**粗体** __粗体__ *斜体* _斜体_ ~~删除线~~ ***加粗斜体***", "粗体 粗体 斜体 斜体 删除线 加粗斜体"],
  ["行内代码", "使用 `hello_world` 和 ``a ` b``，不要改 snake_case。", "使用 hello_world 和 a ` b，不要改 snake_case。"],
  ["链接图片", '[链接](https://example.com/a_(b) "标题") ![山景](image.png) ![](empty.png)', "链接 山景"],
  ["嵌套链接文字", "[**粗体** 与 [括号]](https://example.com)", "粗体 与 [括号]"],
  ["引用链接", "[链接][id]、[标题][]、[快捷]\n\n[id]: https://example.com\n[标题]: /title\n[快捷]: /short", "链接、标题、快捷"],
  ["引用列表", "> 引用\n> > 嵌套\n\n- 无序\n  * 二级\n+ 第三项\n1. 有序\n2) 第二项\n- [x] 完成\n- [ ] 待办", "引用\n嵌套\n\n无序\n二级\n第三项\n有序\n第二项\n完成\n待办"],
  ["水平线", "前文\n\n---\n***\n___\n- - -\n* * *\n\n后文", "前文\n\n后文"],
  ["表格", "| 姓名 | 年龄 |\n| :--- | ---: |\n| **小明** | 20 |\n| 小红 | 21 |", "姓名，年龄\n小明，20\n小红，21"],
  ["无外框表格、转义竖线", "名字 | 备注\n--- | ---\n甲 | A\\|B\n\n后文", "名字，备注\n甲，A|B\n\n后文"],
  ["HTML", "<!-- 不读\n注释 -->\n<div>段落 <b>加粗</b><br>换行</div>\n<script>不读()</script><style>不读{}</style>\n后文", "段落 加粗\n换行\n\n后文"],
  ["HTML 实体", "A &amp; B&nbsp;&#20013;&#x6587; &lt;标签&gt;", "A & B 中文 <标签>"],
  ["HTML 代码块", "前文\n<pre><code>不读的代码</code></pre>\n后文", "前文\n\n后文"],
  ["代码围栏", "前文\n\n```js\nconst secret = 123;\n```\n\n后文\n~~~python\nprint('不读')\n~~~", "前文\n\n后文"],
  ["更短围栏不结束代码块", "````js\n```\n不读\n````\n正文", "正文"],
  ["引用和列表内代码块", "> ```js\n> 不读\n> ```\n\n- ```\n  不读\n  ```\n正文", "正文"],
  ["未闭合代码块", "前文\n```\n不读", "前文"],
  ["缩进代码与列表续行", "前文\n\n    不读代码\n\t不读代码\n\n后文\n\n- 列表\n    保留续行", "前文\n\n后文\n\n列表\n保留续行"],
  ["段落与换行", "第一段\n续行  \n\n第二段\n\n\n第三段", "第一段\n续行\n\n第二段\n\n第三段"],
  ["纯文本不误删", "C# 语言，#不是标题，2 * 3 = 6，snake_case。", "C# 语言，#不是标题，2 * 3 = 6，snake_case。"],
  ["空内容", "", ""],
  ["空值", null, ""]
];

for (const [label, input, expected] of cases) {
  assert.equal(markdownToText(input), expected, label);
}
console.log(`markdown_node: ${cases.length} cases ok`);

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const uploadSource = app.slice(app.indexOf('fileInput?.addEventListener("change"'), app.indexOf("// ── Generate"));
assert.ok(uploadSource.startsWith("fileInput?.addEventListener") && uploadSource.endsWith("\n\n"));
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const accepted = html.match(/id="fileInput" accept="([^"]+)"/)[1].split(",");
for (const type of [".txt", ".docx", ".pdf", ".md", ".markdown", "text/plain", "text/markdown", "text/x-markdown", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
  assert.ok(accepted.includes(type), `accept 缺少 ${type}`);
}
assert.ok(html.includes("style.css?v=20261031-6") && html.includes("app.js?v=20261031-6"));
for (const match of app.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)) {
  assert.ok(match[1].endsWith("?v=20261031-6"), `import 版本未同步: ${match[1]}`);
}

for (const extension of ["md", "MD", "markdown", "MaRkDoWn", "txt", "TXT", "pdf", "PDF", "docx", "DOCX"]) {
  let change;
  let loaded;
  let acceptedFile;
  let requestPath;
  const markdown = /^md$|^markdown$/i.test(extension);
  const raw = "# 书名\n\n**正文** [链接](https://example.com)";
  const context = vm.createContext({
    fileInput: {
      files: [{ name: `书名.${extension}`, content: raw }],
      addEventListener(event, handler) { assert.equal(event, "change"); change = handler; }
    },
    FileReader: class {
      readAsText(file) { loaded = this.onload({ target: { result: file.content } }); }
    },
    FormData: class { append() {} },
    async fetch(url) {
      requestPath = url;
      return { ok: true, async json() { return { text: "解析后的正文" }; } };
    },
    markdownToText,
    currentFileName: null,
    noteUserInput() {},
    interruptPlayback() {},
    async acceptBookFile(text, source) { acceptedFile = { text, source }; },
    setStatus() {},
    console
  });
  vm.runInContext(uploadSource, context);
  await change();
  await loaded;
  assert.equal(context.currentFileName, "书名", extension);
  if (/^(pdf|docx)$/i.test(extension)) {
    assert.equal(requestPath, /^pdf$/i.test(extension) ? "/upload-pdf" : "/upload-word");
    assert.deepEqual(acceptedFile, { text: "解析后的正文", source: extension.toLowerCase() });
  } else {
    assert.deepEqual(acceptedFile, { text: markdown ? "书名\n\n正文 链接" : raw, source: "txt" }, extension);
  }
}
console.log("markdown_import_node: 10 extensions, existing upload routes, accept and versions ok");
