import sys
import json
import pdfplumber

path = sys.argv[1]

try:
    with pdfplumber.open(path) as pdf:
        pages = []
        for page in pdf.pages[:500]:  # 最多提取前500页
            t = page.extract_text()
            if t:
                pages.append(t)
        text = '\n'.join(pages)
        # 过滤乱码检测
        import re
        valid = len(re.findall(r'[\u4e00-\u9fa5a-zA-Z0-9]', text))
        total = max(len(text), 1)
        if len(text) < 50 or valid / total < 0.2:
            print(json.dumps({'error': '此 PDF 为图片扫描件，无法提取文字 ❌'}))
        else:
            print(json.dumps({'text': text}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
