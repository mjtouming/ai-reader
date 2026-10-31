// 只改送进 TTS 的文本。句末或行末的破折号改成句号，句中改成逗号。
export function normalizeDashesForSpeech(text) {
  return String(text || "").replace(/—+[ \t]*/g, (match, offset, str) => {
    const after = str.slice(offset + match.length);
    if (!after || after.startsWith("\n") || /^[。！？!?；;]/.test(after)) {
      if (/^[。！？!?]/.test(after)) return "";
      return "。";
    }
    if (/^[，,、]/.test(after)) return "";
    return "，";
  });
}
