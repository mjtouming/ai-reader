import sys
import asyncio
import os
import edge_tts

VOICE_MAP = {
    "young_female": "zh-CN-XiaoxiaoNeural",
    "girl":         "zh-CN-XiaoyiNeural",
    "young_male":   "zh-CN-YunxiNeural",
    "elder_male":   "zh-CN-YunjianNeural",
}

async def main():
    try:
        # argv: voice_key, out_path
        if len(sys.argv) < 3:
            print("Usage: tts_edge.py <voice_key> <out_path>", file=sys.stderr, flush=True)
            sys.exit(2)

        voice_key = sys.argv[1]
        out_path = sys.argv[2]
        voice = VOICE_MAP.get(voice_key, VOICE_MAP["young_female"])

        text = sys.stdin.read()
        if not text.strip():
            print("Empty text from stdin", file=sys.stderr, flush=True)
            sys.exit(3)

        out_dir = os.path.dirname(out_path)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)

        print(f"[edge-tts] voice_key={voice_key} voice={voice}", file=sys.stderr, flush=True)
        print(f"[edge-tts] out_path={out_path}", file=sys.stderr, flush=True)
        print(f"[edge-tts] text_len={len(text)}", file=sys.stderr, flush=True)

        communicate = edge_tts.Communicate(text=text, voice=voice)
        await communicate.save(out_path)

        if (not os.path.exists(out_path)) or os.path.getsize(out_path) == 0:
            print("[edge-tts] save finished but file missing/empty", file=sys.stderr, flush=True)
            sys.exit(4)

        print("[edge-tts] ok", file=sys.stderr, flush=True)
        sys.exit(0)

    except Exception as e:
        print("[edge-tts] exception:", repr(e), file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())