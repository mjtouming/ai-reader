cat > /Users/majun/ai-program/ai-reader/AI_CONTEXT.md << 'EOF'
# 灵听 AI_CONTEXT v12

---

## 一、开发阶段说明

**当前阶段：优化阶段，不是架构开发阶段**

### 禁止
- 重写系统架构
- 重写播放器核心 pipeline
- 修改分段算法（splitTextIntoChunks）
- 重写缓存机制
- 大规模代码重构

### 修改代码规则
- 一次只改一个地方
- 使用 python3 脚本做精确 str.replace
- 只给一个最稳妥方案，不列多个选项
- 改完必须用 grep 验证
- 版本号三处必须同步：index.html(style.css), index.html(app.js), app.js(audioEngine.js)
- 用 python3 统一更新版本号，用 re.sub 替换所有版本号，避免遗漏

---

## 二、产品定位

**AI有声书播放器（品牌名：灵听 · AI听书 / SONA）**
核心：AI Rewrite + Streaming Pipeline + 连续播放。不是简单 TTS 工具。

---

## 三、朗读模式

| 前端值 | 服务端角色 | temperature | 说明 |
|--------|-----------|-------------|------|
| original | ANNOUNCER | 0.4 | 播音员，忠于原文，修正断句 |
| story | STORYTELLER | 0.92 | 说书人，口语演绎 |
| translate | TRANSLATE | 0.2 | 翻译为现代中文 |

---

## 四、声线

| key | 说明 |
|-----|------|
| young_female | 青年女（original/translate 默认） |
| girl | 少女 |
| young_male | 青年男 |
| elder_male | 中老年男（story 默认） |

声线记忆：用户手动选择 → 存 localStorage `ai_reader_voice_manual` → 切换模式时优先用

---

## 五、Pipeline（audioCache 滚动窗口）
```
playChunk(index)
  └─ await audioPlayer.play()   ← play()先执行
  └─ fillWindow(index, jobId)   ← play()成功后再预生成（避免Safari并发拦截）

每段生成完：
  └─ audioCache[index] = url
  └─ fillWindow(currentIndex, jobId)

ended 事件：
  ├─ audioCache[currentIndex] 存在 → 直接切换
  │   └─ play()失败 → 回退到 playChunk 重试
  └─ 不存在 → playChunk(currentIndex)
```

关键变量：
- `audioCache = {}` (index → url)
- `preGeneratingSet` 防重复
- `preGenerateAbort` AbortController，interruptPlayback时取消所有预生成
- `PRE_WINDOW = 2`
- `currentJobId` 隔离任务

---

## 六、已修复的关键 Bug

### Safari URIError（最重要，根本原因）
- 现象：Safari 上播放失败，Chrome 正常，TTS 请求失败重试3次后停止
- 根因：audioEngine.js 里 `decodeURIComponent(response.headers.get("X-Rewritten-Text"))` 在 Safari 上遇到特殊字符抛 URIError
- 修复：加 try/catch，decode 失败时 rewritten=null，不影响播放
- 文件：`public/audioEngine.js`

### ended 事件 audioCache 分支 play() 无保护
- 修复：加 try/catch，play() 失败回退到 playChunk 重试

### Safari NotAllowedError
- playChunk 里 play() 失败显示"已生成，点击▶继续播放"

---

## 七、Smart Cleaner

函数：`cleanBookTextForReading(rawText)`，点击生成时调用（不是上传时）

处理流程：
1. metaLineRe 过滤版权/出版信息行（含"版权信息"标题）
2. 找**最后一个**"目录"标题作为 cutStart（不 break，取最后一个，支持多目录书籍）
3. cutStart 指向 CONTENTS 时，往前看一行是否是"目录"，是则 cutStart-1
4. nonTocCount >= 3 连续非章节行才认为目录结束，cutEnd = i-2
5. 换行合并：只合并行尾不是句号等标点的行（PDF 行内断字）
6. **兜底清理**：找第一个真正正文段落（>30字、中文占比>70%、不含版权关键词），firstContent>=1时截断

---

## 八、PDF 解析

**已从 pdf-parse 换成 pdfplumber（Python）**
- 脚本：`pdf_extract.py`
- 服务器需要：`pip3 install pdfplumber --break-system-packages`
- execFile maxBuffer: 50MB，timeout: 60s
- 优势：目录每章单独一行，Smart Cleaner 能正确识别
- 图片PDF检测：有效字符占比<20%返回422

---

## 九、深色模式

- 自动跟随系统（`prefers-color-scheme: dark`）
- 深色背景：#0f1117 / #1e2130
- select/option/textarea 用 `!important` 覆盖
- audio 播放器：`filter: invert(0.85) hue-rotate(180deg)`
- input.file 上传区域单独处理

---

## 十、文件输入

| 格式 | 处理 |
|------|------|
| .txt | 前端 FileReader |
| .pdf | 服务端 pdfplumber（pdf_extract.py），图片PDF返回422 |
| .docx | 服务端 mammoth |
| YouTube | 服务端 yt-dlp，支持 watch/live，cookies定期需更新 |

---

## 十一、版本号（每次前端更新必须同步三处）
```
index.html:  style.css?v=YYYYMMDD-N
index.html:  app.js?v=YYYYMMDD-N
app.js:      audioEngine.js?v=YYYYMMDD-N
```
当前版本：`20260312-29`

统一更新版本号（推荐）：
```bash
python3 << 'PYEOF'
import re
NEW = "20260312-XX"
for path, pat in [
    ('public/index.html', r'style\.css\?v=[\w-]+'),
    ('public/index.html', r'app\.js\?v=[\w-]+'),
    ('public/app.js',     r'audioEngine\.js\?v=[\w-]+'),
]:
    with open(path, 'r') as f: c = f.read()
    c = re.sub(pat, pat.split('\\\\')[0].replace('\\','').replace('?','?') + f'?v={NEW}', c)
    with open(path, 'w') as f: f.write(c)
print("OK")
PYEOF
```

---

## 十二、稳定版 Tag

- `stable-v1`：Safari URIError修复+深色模式之前
- `stable-v2`：pdfplumber+Smart Cleaner+深色模式+Safari修复后的稳定版

---

## 十三、开发工作流
```bash
cd /Users/majun/ai-program/ai-reader
# 改代码 → 更新版本号
git add -A && git commit -m "..." && git push
ssh tokyo "cd ~/ai-reader && git fetch origin && git reset --hard origin/main && pm2 restart ai-reader"
```

---

## 十四、环境信息

| 项目 | 内容 |
|------|------|
| SSH | `ssh tokyo` |
| 服务器路径 | `/home/linuxuser/ai-reader` |
| PM2服务名 | ai-reader |
| 访问地址 | http://207.148.105.250:3000 |
| GitHub | https://github.com/mjtouming/ai-reader |
| 本地路径 | /Users/majun/ai-program/ai-reader |
| Railway | 自动监听 main 分支部署 |

---

## 十五、主要文件

| 文件 | 说明 |
|------|------|
| public/app.js | 前端主逻辑 |
| public/audioEngine.js | 音频引擎（IndexedDB），URIError修复在此 |
| public/style.css | 样式，含深色模式 |
| public/index.html | 页面结构 |
| server.js | Node.js 后端 |
| tts_edge.py | Edge TTS |
| pdf_extract.py | pdfplumber PDF解析脚本 |
| rewrite_cache.json | 改写缓存（gitignore） |
| cookies.txt | YouTube cookies（gitignore，需定期更新） |
| .env | OPENAI_API_KEY（gitignore） |

---

## 十六、已实现功能

- AI Rewrite（播音员/说书人/翻译）
- 声线记忆（localStorage）
- Edge TTS 4种声线
- 自动分段 + Smart Cleaner（含兜底清理）
- Pipeline 滚动窗口预生成（PRE_WINDOW=2）
- 第一段跳过改写直接TTS
- 音频缓存（IndexedDB）+ 改写缓存（json）
- PDF（pdfplumber，含图片检测）/ Word / YouTube（含直播链接）
- 任务隔离（JobId + AbortController + preGenerateAbort）
- 断点恢复
- 定时关闭
- 书架（最多10本）
- 段落导航（随意跳转）
- 正在播放书名（marquee）
- 禁止页面缩放
- 深色模式（跟随系统）
- 品牌：灵听 SONA，自定义logo + 桌面icon（PWA）
- VPS(PM2) + Railway 双部署
EOF
echo "AI_CONTEXT v12 OK"