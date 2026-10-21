import sys
import json
import re

try:
    import fitz  # pymupdf
except ImportError:
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "pymupdf", "--break-system-packages", "-q"])
    import fitz

path = sys.argv[1]

try:
    doc = fitz.open(path)
    pages = []
    for page in doc:
        pages.append(page.get_text() or "")
    toc = []
    for level, title, page in doc.get_toc():
        toc.append({"level": level, "title": title, "page": page})
    doc.close()
    text = "\n".join(pages)

    valid = len(re.findall(r'[一-龥a-zA-Z0-9]', text))
    total = max(len(text), 1)
    if len(text) < 50 or valid / total < 0.2:
        print(json.dumps({"error": "此 PDF 为图片扫描件，无法提取文字 ❌"}, ensure_ascii=False))
    else:
        print(json.dumps({"text": text, "pages": pages, "toc": toc}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
