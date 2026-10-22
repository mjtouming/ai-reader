// 正文框「聚焦先清空、没有新内容就恢复」。
// 清空只存在于可见字符串里。播放、书架、会话保存必须读 read()，
// 这样聚焦后的空框不会被当成换了书。

export function createTextDraft() {
  let original = null;
  let composing = false;
  let suppress = 0;
  let userEdited = false;

  function read(visible) {
    const value = visible ?? "";
    if (original !== null && (composing || value === "")) return original;
    return value;
  }

  function onFocus(visible) {
    const value = visible ?? "";
    if (suppress > 0 || original !== null) return { type: "noop", value };
    if (!value) return { type: "noop", value: "" };
    original = value;
    userEdited = false;
    return { type: "clear", value: "" };
  }

  function shouldReclear(visible, isActive) {
    if (!isActive || suppress > 0 || composing || userEdited || original === null) return false;
    return (visible ?? "") === original;
  }

  function onBlur(visible) {
    const value = visible ?? "";
    if (original === null) return { type: "noop", value };
    const saved = original;
    original = null;
    composing = false;
    userEdited = false;
    if (value === "") return { type: "restore", value: saved };
    return { type: "keep", value };
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd(visible) {
    composing = false;
    if (original !== null && (visible ?? "") !== "") userEdited = true;
  }

  function onPaste() {
    if (suppress > 0 || original === null) return;
    userEdited = true;
  }

  function onUserInput(inputType) {
    if (suppress > 0 || composing || original === null) return;
    if (!inputType) return;
    userEdited = true;
  }

  function runWrite(write) {
    suppress += 1;
    try {
      original = null;
      composing = false;
      userEdited = false;
      write();
    } finally {
      suppress -= 1;
    }
  }

  function isPending() {
    return original !== null;
  }

  return {
    read,
    onFocus,
    onBlur,
    shouldReclear,
    onCompositionStart,
    onCompositionEnd,
    onPaste,
    onUserInput,
    runWrite,
    isPending
  };
}
