cat > /Users/majun/ai-program/ai-reader/AI_CONTEXT.md << 'EOF'
# 灵听 AI_CONTEXT v11

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

---

## 二、产品定位

**AI有声书播放器（品牌名：灵听 SONA）**
核心：AI Rewrite + Streaming Pipeline + 连续播放。不是简单 TTS 工具。

---

## 三、朗读模式

| 前端值 | 服务端角色 | temperature | 说明 |
|--------|-----------|-------------|------|
| original | ANNOUNCER | 0.4 | 播音员，忠于原文，修正断句 |
| story | STORYTELLER | 0.92 | 说书人，口语演绎 |
| translate | TRANSLATE | 0.2 | 翻译为现代中文 |

### ANNOUNCER_PROMPT（当前实际，已简化）
- 忠于原文，不点评，不玩梗
- 修正断句：合并因换行导致的词语切断
- 不加观点、不加评论、不加开场白
- 不做润色、不做总结、不改变原文内容

### STORY_PROMPT
- 风格：单田芳 / 郭德纲 / 深夜说书
- 任务是"重新讲故事"，不是朗读或改写
- 大量短句，换行制造停顿，语气词有专属情绪场景
- 点评必须有洞察，每段最多一次
- 禁止新增主要人物/关键剧情/改变结局

### TRANSLATE_PROMPT
- 古文/外文翻译为自然现代中文白话，适合朗读

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

## 五、书名规则

| 来源 | 书名 |
|------|------|
| 上传文件 | 文件名去掉扩展名 |
| 手动粘贴 | 文本前10个字 + "…" |
| 首次访问默认文本 | 固定"出师表节选" |
| 兜底 | "未命名书籍 YYYY-MM-DD" |

---

## 六、书架

- 最多10本，localStorage key：`ai_reader_shelf_v1`
- 右上角 SVG 书架图标，点击底部抽屉滑出
- 书本 ID：文本前500字的 djb2 hash
- 切换书本：恢复进度+设置，播放按钮重置为"▶ 播放"
- 刷新恢复：用文本 hash 匹配书架，修正 currentBookId 避免错位

---

## 七、正在播放书名显示

- 位置：header 右上角书架图标左边，id="nowPlayingTitle"
- 超过5个字：marquee 循环滚动；不超过5个字：静止
- 停止/中断时消失

---

## 八、Pipeline（audioCache 滚动窗口）
```
playChunk(index)
  └─ fillWindow(index, jobId)  ← 预生成后续 PRE_WINDOW=3 段

每段生成完：
  └─ audioCache[index] = url
  └─ fillWindow(currentIndex, jobId)  ← 继续填满

ended 事件：
  ├─ audioCache[currentIndex] 存在 → 直接切换，fillWindow 继续
  └─ 不存在 → playChunk(currentIndex)
```

关键变量：
- `audioCache = {}` (index → url)
- `preGeneratingSet` 记录生成中的 index，防重复
- `PRE_WINDOW = 3`
- `currentJobId` 隔离任务

---

## 九、启动加速

- 首段：maxLen=420，minLen=200
- 后续：maxLen=2200，minLen=800
- **index=0 的段落跳过 OpenAI 改写（skipRewrite=true），直接 TTS**

---

## 十、缓存机制

| 缓存 | 位置 | key |
|------|------|-----|
| 音频缓存 | 前端 IndexedDB | hash(text+mode+voice) |
| 改写缓存 | 后端 rewrite_cache.json | sha1(text+mode) |

**改完 prompt 后必须清空 rewrite_cache.json（本地+服务器）**

---

## 十一、Smart Cleaner

函数：`cleanBookTextForReading(rawText)`，点击生成时调用（不是上传时）

- MAX_HEAD_LINES=400，SEARCH_LIMIT=300，DENSE_LIMIT=200，WINDOW=30
- 清理：版权页（metaLineRe）、目录页（tocLineRe）
- tocLineRe 注意：`\b` 在中文环境失效，已去掉
- 换行合并在函数最后做：单个换行合并，双换行保留
- **局限：pdf-parse 提取的目录如果是单行长串，无法清理**

---

## 十二、文件输入

| 格式 | 处理 |
|------|------|
| .txt | 前端 FileReader |
| .pdf | 服务端 pdf-parse，图片PDF返回422 |
| .docx | 服务端 mammoth |
| YouTube | 服务端 yt-dlp，支持 watch/live，无字幕返回友好提示 |

---

## 十三、版本号（每次前端更新必须同步三处）
```
index.html:  style.css?v=YYYYMMDD-N
index.html:  app.js?v=YYYYMMDD-N
app.js:      audioEngine.js?v=YYYYMMDD-N
```
当前版本：`20260312-8`

---

## 十四、开发工作流
```bash
cd /Users/majun/ai-program/ai-reader
# 改代码 → 更新版本号
git add -A && git commit -m "..." && git push
ssh tokyo "cd ~/ai-reader && git stash && git pull && pm2 restart ai-reader"
```

Claude Code：终端 cd 到项目目录后运行 `claude`，确认底部显示 `~/ai-program/ai-reader`

---

## 十五、环境信息

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

## 十六、主要文件

| 文件 | 说明 |
|------|------|
| public/app.js | 前端主逻辑 |
| public/audioEngine.js | 音频引擎（IndexedDB） |
| public/style.css | 样式 |
| public/index.html | 页面结构 |
| server.js | Node.js 后端 |
| tts_edge.py | Edge TTS |
| rewrite_cache.json | 改写缓存（gitignore） |
| cookies.txt | YouTube cookies（gitignore） |
| .env | OPENAI_API_KEY（gitignore） |

---

## 十七、已实现功能

- AI Rewrite（播音员/说书人/翻译）
- 声线记忆
- Edge TTS 4种声线
- 自动分段 + Smart Cleaner
- Pipeline 滚动窗口预生成（PRE_WINDOW=3）
- 第一段跳过改写直接TTS
- 音频缓存（IndexedDB）+ 改写缓存（json）
- PDF（含图片检测）/ Word / YouTube（含直播链接）
- 任务隔离（JobId + AbortController）
- 断点恢复
- 定时关闭（10/30/60分钟 / 本段结束）
- 书架（最多10本）
- 段落导航（随意跳转）
- 正在播放书名（marquee）
- 禁止页面缩放
- 品牌：灵听 SONA，自定义 logo + 桌面 icon（PWA）
- MiSans字体
- 生成等待动画
- VPS(PM2) + Railway 双部署

---

## 十八、新对话开始时的背景说明

> 我有一个 AI 有声书播放器项目"灵听"，本地路径 /Users/majun/ai-program/ai-reader，部署在 207.148.105.250:3000（PM2），GitHub：https://github.com/mjtouming/ai-reader，Railway 自动部署。
EOF
echo "AI_CONTEXT v11 OK"