# 灵听 AI_CONTEXT v13

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
- 只给一个最稳妥方案，不列多个选项
- 版本号三处必须同步：index.html(style.css), index.html(app.js), app.js(audioEngine.js)
- 用 python3 统一更新版本号（见十一节）

---

## 二、产品定位

**AI有声书播放器（品牌名：灵听 · AI听书）**
核心：AI Rewrite + Streaming Pipeline + 连续播放。不是简单 TTS 工具。
访问地址：https://sona.solonova.top

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

**声线自动切换**：播放中切换声线 → voiceSelect change 事件 → 自动 interruptPlayback + 从 currentIndex 重新生成，无需手动点"生成并播放"

---

## 五、Pipeline（audioCache 滚动窗口）

```
playChunk(index)
  └─ await audioPlayer.play()   ← play() 先执行
  └─ fillWindow(index, jobId)   ← play() 成功后再预生成（避免Safari并发拦截）

每段生成完：
  └─ audioCache[index] = url
  └─ fillWindow(currentIndex, jobId)

ended 事件：
  ├─ audioCache[currentIndex] 存在 → 直接切换
  │   └─ play() 失败 → 回退到 playChunk 重试
  └─ 不存在 → playChunk(currentIndex)
```

关键变量：
- `audioCache = {}` (index → url)
- `preGeneratingSet` 防重复
- `preGenerateAbort` AbortController，interruptPlayback 时取消所有预生成
- `PRE_WINDOW = 2`
- `currentJobId` 隔离任务

---

## 六、已修复的关键 Bug

### Safari URIError（最重要）
- 现象：Safari 上播放失败，Chrome 正常
- 根因：`decodeURIComponent(response.headers.get("X-Rewritten-Text"))` 遇特殊字符抛 URIError
- 修复：try/catch，decode 失败时 rewritten=null
- 文件：`public/audioEngine.js`

### ended 事件 play() 无保护
- 修复：加 try/catch，失败回退到 playChunk 重试

### Safari NotAllowedError
- playChunk 里 play() 失败显示"已生成，点击▶继续播放"

---

## 七、UI 设计（暖白编辑风格）

**2026-04 全量重设计，基于 Pencil 设计稿**

设计语言：
- 背景：`#FCFAF7`（暖白）
- 主文字：`#000`
- 分割线：`#E5E2DD`
- 字体：Playfair Display（标题）/ Geist Mono（标签/数字）/ Inter（正文）

布局结构（从上到下）：
1. Header：Logo + 灵听 · AI听书 + 书架按钮
2. Settings Row：朗读模式 / 朗读者 / 语速（三列，分隔线）
3. 文字/YouTube链接：文本框
4. Actions：生成并播放 / 播放 / 定时关闭
5. 进度区：段落选择 + 状态
6. 上传文件：支持 PDF · TXT · DOCX
7. 底部播放器（fixed）：进度条 + 控制行

底部播放器控制行：
- [上一段] [后退10s] [▶/⏸] [前进10s] [下一段] + 书架按钮（右侧绝对定位）
- 书架按钮用 `position: absolute; right: 0; top: 50%; transform: translateY(-50%)`

深色模式：**已移除**，统一使用暖白风格

---

## 八、自定义播放器（inline script）

index.html 底部有一段非 module 的 inline `<script>`，负责：
- 进度条实时更新（timeupdate）
- 进度条点击/触摸 seek（click + touchstart + touchmove）
- 主播放按钮 SVG 图标切换（play/pause/ended）
- mainPlayBtn → 委托给 playPauseBtn.click()
- playPauseBtn MutationObserver 拦截 emoji，替换为 SVG 图标
- 跳段（skipBackBtn/skipFwdBtn → chunkNav select）
- 定时关闭下拉菜单
- 书架/playerShelfBtn → shelfBtn.click()
- 书架关闭按钮（sheetCloseBtn → sheetOverlay.click()）
- Media Session API：锁屏显示 ±10s seek 按钮

**注意**：app.js 是 type="module"，inline script 是普通 script，两者不共享变量

---

## 九、Smart Cleaner

函数：`cleanBookTextForReading(rawText)`，点击生成时调用

处理流程：
1. metaLineRe 过滤版权/出版信息行
2. 找最后一个"目录"标题作为 cutStart
3. nonTocCount >= 3 连续非章节行认为目录结束
4. 换行合并：只合并行尾不是句号等标点的行
5. 兜底清理：找第一个真正正文段落（>30字、中文占比>70%）

---

## 十、文件输入

| 格式 | 处理 |
|------|------|
| .txt | 前端 FileReader |
| .pdf | 服务端 pdfplumber（pdf_extract.py），图片PDF返回422 |
| .docx | 服务端 mammoth |
| YouTube | 服务端 yt-dlp，支持 watch/live |

---

## 十一、版本号（每次前端更新必须同步三处）

```
index.html:  style.css?v=YYYYMMDD-N
index.html:  app.js?v=YYYYMMDD-N
app.js:      audioEngine.js?v=YYYYMMDD-N
```

当前版本：`20260416-1`

统一更新命令：
```bash
cd /Users/majun/ai-program/ai-reader && python3 << 'PYEOF'
import re
NEW = "20260416-X"  # 改这里
files = [
    ('public/index.html', r'style\.css\?v=[\w-]+',      f'style.css?v={NEW}'),
    ('public/index.html', r'app\.js\?v=[\w-]+',         f'app.js?v={NEW}'),
    ('public/app.js',     r'audioEngine\.js\?v=[\w-]+', f'audioEngine.js?v={NEW}'),
]
for path, pat, repl in files:
    with open(path, 'r') as f: c = f.read()
    c2 = re.sub(pat, repl, c)
    with open(path, 'w') as f: f.write(c2)
    print(f"OK {path}")
PYEOF
```

---

## 十二、稳定版 Tag

- `stable-v1`：Safari URIError修复+深色模式之前
- `stable-v2`：pdfplumber+Smart Cleaner+深色模式+Safari修复
- `stable-v3`：暖白 UI 重设计完成（2026-04）

---

## 十三、开发工作流

```bash
cd /Users/majun/ai-program/ai-reader
# 改代码 → 更新版本号（见十一节）
git add public/index.html public/style.css public/app.js
git commit -m "..."
git push origin main
# 服务器更新
ssh mj "cd /root/ai-reader && git pull origin main && pm2 restart all"
```

---

## 十四、环境信息

| 项目 | 内容 |
|------|------|
| SSH | `ssh mj` → `root@23.94.143.238` |
| 服务器路径 | `/root/ai-reader` |
| PM2 服务名 | ai-reader |
| 访问地址 | https://sona.solonova.top |
| GitHub | https://github.com/mjtouming/ai-reader |
| 本地路径 | `/Users/majun/ai-program/ai-reader` |

---

## 十五、主要文件

| 文件 | 说明 |
|------|------|
| public/app.js | 前端主逻辑（ES module） |
| public/audioEngine.js | 音频引擎，URIError修复在此 |
| public/style.css | 样式，暖白编辑风格 |
| public/index.html | 页面结构 + inline 播放器控件 script |
| public/icon.svg | App 图标（512×512 矢量） |
| public/apple-touch-icon.png | iOS 主屏幕图标（192×192） |
| server.js | Node.js 后端 |
| tts_edge.py | Edge TTS |
| pdf_extract.py | pdfplumber PDF 解析 |
| rewrite_cache.json | 改写缓存（gitignore） |
| cookies.txt | YouTube cookies（gitignore，需定期更新） |
| .env | OPENAI_API_KEY（gitignore） |

---

## 十六、已实现功能

- AI Rewrite（播音员 / 说书人 / 翻译）
- 声线记忆（localStorage）+ 切换声线自动重新生成
- Edge TTS 4种声线
- 自动分段 + Smart Cleaner
- Pipeline 滚动窗口预生成（PRE_WINDOW=2）
- 音频缓存（IndexedDB）+ 改写缓存（json）
- PDF（pdfplumber）/ Word / YouTube
- 任务隔离（JobId + AbortController）
- 断点恢复 / 定时关闭 / 书架（最多10本）
- 段落导航 / 书架关闭按钮（✕）
- 自定义播放器（SVG 控件 + 进度条触摸 seek）
- Media Session API（锁屏 ±10s 快进快退）
- App 图标（icon.svg + apple-touch-icon.png，支持 iOS 添加到主屏幕）
- 禁止页面缩放（viewport）
