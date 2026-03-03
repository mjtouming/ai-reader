export async function generateAudioFromText(text, mode, voice, signal) {
  const response = await fetch("/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode, voice }),
    signal // ✅ 允许中断
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(errText);
  }

  const audioBlob = await response.blob();
  return URL.createObjectURL(audioBlob);
}