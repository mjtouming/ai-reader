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
        t = page.get_text()
        if t:
            pages.append(t)
    doc.close()
    text = '\n'.join(pages)

    valid = len(re.findall(r'[一-龥a-zA-Z0-9]', text))
    total = max(len(text), 1)
    if len(text) < 50 or valid / total < 0.2:
        print(json.dumps({'error': '此 PDF 为图片扫描件，无法提取文字 ❌'}))
    else:
        print(json.dumps({'text': text}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
