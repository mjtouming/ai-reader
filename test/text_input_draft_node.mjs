import assert from "node:assert/strict";
import { createTextDraft } from "../public/textInputDraft.mjs";

{
  const draft = createTextDraft();
  assert.deepEqual(draft.onFocus(""), { type: "noop", value: "" });
  assert.equal(draft.isPending(), false);
  assert.deepEqual(draft.onBlur(""), { type: "noop", value: "" });
  assert.equal(draft.read(""), "");
}

{
  const draft = createTextDraft();
  assert.deepEqual(draft.onFocus("先帝创业未半"), { type: "clear", value: "" });
  assert.equal(draft.isPending(), true);
  assert.equal(draft.read(""), "先帝创业未半");
  assert.deepEqual(draft.onFocus(""), { type: "noop", value: "" });
  assert.equal(draft.isPending(), true);
  assert.deepEqual(draft.onBlur(""), { type: "restore", value: "先帝创业未半" });
  assert.equal(draft.isPending(), false);
  assert.equal(draft.read("先帝创业未半"), "先帝创业未半");
}

{
  const draft = createTextDraft();
  draft.onFocus("正在听的正文");
  draft.onPaste();
  draft.onUserInput("insertFromPaste");
  assert.equal(draft.read("粘贴进来的新文章"), "粘贴进来的新文章");
  assert.equal(draft.shouldReclear("粘贴进来的新文章", true), false);
  assert.deepEqual(draft.onBlur("粘贴进来的新文章"), { type: "keep", value: "粘贴进来的新文章" });
}

{
  const draft = createTextDraft();
  draft.onFocus("正在听的正文");
  draft.onPaste();
  assert.equal(draft.shouldReclear("正在听的正文", true), false, "原样粘贴不能被再次清空");
  assert.deepEqual(draft.onBlur("正在听的正文"), { type: "keep", value: "正在听的正文" });
}

{
  const draft = createTextDraft();
  draft.onFocus("正在听的正文");
  draft.onUserInput("insertText");
  assert.equal(draft.read("新"), "新");
  assert.equal(draft.read(""), "正在听的正文", "删光之后保存逻辑仍要看到原文");
  assert.deepEqual(draft.onBlur(""), { type: "restore", value: "正在听的正文" });
}

{
  const draft = createTextDraft();
  draft.onFocus("正在听的正文");
  assert.deepEqual(draft.onBlur(" "), { type: "keep", value: " " });
}

{
  const draft = createTextDraft();
  draft.onFocus("原文");
  assert.equal(draft.shouldReclear("原文", true), true);
  assert.equal(draft.shouldReclear("原文", false), false);
  assert.equal(draft.shouldReclear("", true), false);
  draft.onUserInput("");
  assert.equal(draft.shouldReclear("原文", true), true, "没有 inputType 的事件不是用户输入");
  draft.onUserInput("insertText");
  assert.equal(draft.shouldReclear("原文", true), false);
}

{
  const draft = createTextDraft();
  draft.onFocus("原文");
  draft.onCompositionStart();
  assert.equal(draft.isPending(), true);
  assert.equal(draft.read("nihao"), "原文", "组字过程不能当成新正文");
  assert.equal(draft.shouldReclear("原文", true), false);
  draft.onCompositionEnd("");
  assert.equal(draft.read(""), "原文");
  assert.deepEqual(draft.onBlur(""), { type: "restore", value: "原文" });
}

{
  const draft = createTextDraft();
  draft.onFocus("原文");
  draft.onCompositionStart();
  draft.onCompositionEnd("你好");
  assert.equal(draft.read("你好"), "你好");
  assert.deepEqual(draft.onBlur("你好"), { type: "keep", value: "你好" });
}

{
  const draft = createTextDraft();
  draft.onCompositionStart();
  draft.onCompositionEnd("你好");
  assert.equal(draft.isPending(), false);
  assert.equal(draft.read("你好"), "你好");
  assert.deepEqual(draft.onFocus("你好"), { type: "clear", value: "" });
}

{
  const draft = createTextDraft();
  draft.onFocus("旧正文");
  let written = "";
  draft.runWrite(() => {
    written = "切换后的书";
    const during = draft.onFocus("切换后的书");
    assert.deepEqual(during, { type: "noop", value: "切换后的书" });
  });
  assert.equal(written, "切换后的书");
  assert.equal(draft.isPending(), false);
  assert.equal(draft.read("切换后的书"), "切换后的书");
  assert.deepEqual(draft.onBlur("切换后的书"), { type: "noop", value: "切换后的书" });
}

{
  const draft = createTextDraft();
  draft.onFocus("旧正文");
  draft.runWrite(() => {});
  assert.equal(draft.isPending(), false);
  assert.deepEqual(draft.onBlur(""), { type: "noop", value: "" });
  assert.equal(draft.read(""), "");
}

console.log("text_input_draft_node: ok");
