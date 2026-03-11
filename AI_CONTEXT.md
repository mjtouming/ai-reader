# AI-Reader 项目 AI_CONTEXT v10

---

## 一、开发阶段说明（非常重要）

**当前阶段：优化阶段，不是架构开发阶段**

### 禁止
- 重写系统架构
- 重写播放器核心 pipeline
- 修改分段算法（splitTextIntoChunks）
- 重写缓存机制
- 大规模代码重构

### 修改代码规则
- 一次只改一个地方
- 使用 python3 脚本做精确 str.replace，不提供完整文件替换
- 只给一个最稳妥方案，不列多个选项
- 改完必须用 grep 验证

---

## 二、产品定位

**AI有声书播放器**，核心是 AI Rewrite + Streaming Pipeline + 连续播放。
不是简单 TTS 工具。

---

## 三、朗读模式（前端 modeSelect）

| 前端值 | 服务端 | temperature | 说明 |
|--------|--------|-------------|------|
| original | ANNOUNCER | 0.4 | 播音员，忠于原文 |
| story | STORYTELLER | 0.92 | 说书人，口语演绎 |
| translate | TRANSLATE | 0.2 | 翻译为现代中文 |

### ANNOUNCER_PROMPT 核心规则（当前实际）
- 忠于原文，克制，不点评不玩梗
- 允许轻量润色：拆长句、调语序、补主语
- **多音字修正**：根据上下文判断正确读音，有歧义替换同义词
- **缺字补全**：识别缺字错字，根据上下文补全
- 禁止主持人开场白

### STORY_PROMPT 核心规则（当前实际）
- 风格：单田芳 / 郭德纲 / 深夜说书
- 任务是"重新讲故事"，不是朗读或改写原文
- 大量短句，换行制造停顿
- 语气词有专属情绪场景，宁可不用也不用错
- 点评必须有洞察，禁止套话废话，每段最多一次
- 禁止新增主要人物/关键剧情/改变结局

### TRANSLATE_PROMPT
- 古文/外文翻译为自然现代中文白话，适合朗读

---

## 四、声线

| key | 说明 |
|-----|------|
| young_female | 青年女（default for original/translate） |
| girl | 少女 |
| young_male | 青年男 |
| elder_male | 中老年男（default for story） |

### 声线记忆逻辑（v10）
- 用户手动操作 voiceSelect → 记录到 localStorage `ai_reader_voice_manual`
- 切换朗读模式时：有手动记录则用手动记录，否则用默认规则

---

## 五、书名规则（v10）

| 来源 | 书名 |
|------|------|
| 上传文件 | 文件名去掉扩展名 |
| 手动粘贴 | 文本前10个字 + "…" |
| YouTube字幕 | 文本前10个字 + "…" |
| 首次访问默认文本 | 固定"出师表节选"（currentFileName 手动设置） |
| 兜底 | "未命名书籍 YYYY-MM-DD" |

---

## 六、书架功能

- 最多10本，localStorage key：`ai_reader_shelf_v1`
- 右上角 SVG 书架图标（线条风格，30x30），点击底部抽屉滑出
- 书本 ID：文本前500字的 djb2 hash
- 切换书本时：恢复进度+设置，播放按钮重置为"▶ 播放"
- 刷新恢复：用文本 hash 匹配书架中对应书，修正 currentBookId 避免错位

---

## 七、正在播放书名显示（v10）

- 位置：header 右上角，书架图标左边，id="nowPlayingTitle"
- 样式：透明背景纯文字，固定宽度 5em，无边框无底色
- 超过5个字：marquee 循环滚动动画（复制一份文字实现无缝）
- 不超过5个字：静止显示
- 停止/中断播放时消失（opacity:0，300ms后清空）
- 切换书本 / 页面恢复时立即更新

---

## 八、段落导航

- 下拉菜单，所有段落可随意跳转（无 disabled 限制）
- 当前播放段显示"▶ 第X段"
- 跳转触发 interruptPlayback + 重新 playChunk

---

## 九、Pipeline 核心
```
playChunk(index) 开始播放
  └─ preGenerateNext(index+1, jobId, "next")    ← 预生成下一段

ended 事件触发
  ├─ 如果 nextAudioUrl 存在：直接切换播放
  │    └─ preGenerateNext(currentIndex+1, jobId, "nextNext")  ← 填满空槽
  └─ 如果没有缓存：调用 playChunk(currentIndex)
```

- slot 参数（"next"/"nextNext"）避免异步 race condition
- 最多并发缓冲2段
- currentJobId 隔离任务，旧任务返回时 jobId 不匹配直接丢弃

---

## 十、前端缓存结构
```
currentAudioUrl   ← 当前播放
nextAudioUrl      ← 下一段已生成
nextNextAudioUrl  ← 下下段已生成
```

---

## 十一、启动加速分段

- 首段：maxLen=420，minLen=200（更快启动）
- 后续：maxLen=2200，minLen=800

---

## 十二、断点恢复

保存：text / chunks / currentIndex / currentTime / mode / voice / speed
恢复：刷新 → 用文本 hash 找书架对应书 → 恢复书名显示 → 恢复播放位置

---

## 十三、缓存机制

| 缓存 | 位置 | key |
|------|------|-----|
| 音频缓存 | 前端 IndexedDB | hash(text+mode+voice) |
| 改写缓存 | 后端 rewrite_cache.json | sha1(text+mode) |

缓存命中条件：文件 size > 100 bytes，否则删除重新生成

---

## 十四、版本号规则（每次前端更新必须同步）

三处同时改：
```
index.html:  style.css?v=YYYYMMDD-N
index.html:  app.js?v=YYYYMMDD-N
app.js:      audioEngine.js?v=YYYYMMDD-N
```
当前版本：`20260311-10`

---

## 十五、开发工作流
```bash
# 本地修改完后
cd /Users/majun/ai-program/ai-reader
# 更新版本号（三处）
git add -A && git commit -m "..." && git push
ssh tokyo "cd ~/ai-reader && git stash && git pull && pm2 restart ai-reader"
# Railway 自动部署（监听 main 分支）
```

### Claude Code 使用
- 终端 cd 到项目目录后运行 `claude`
- 确认底部显示 `~/ai-program/ai-reader`，不是 worktrees 路径

---

## 十六、VPS 信息

| 项目 | 内容 |
|------|------|
| SSH | `ssh tokyo` |
| 项目路径 | `/home/linuxuser/ai-reader` |
| 进程管理 | PM2（服务名：ai-reader） |
| 访问 | http://207.148.105.250:3000 |
| GitHub | https://github.com/mjtouming/ai-reader |
| 本地路径 | /Users/majun/ai-program/ai-reader |

---

## 十七、主要文件

| 文件 | 说明 |
|------|------|
| public/app.js | 前端主逻辑 |
| public/audioEngine.js | 音频引擎（IndexedDB） |
| public/style.css | 样式 |
| public/index.html | 页面结构 |
| server.js | Node.js 后端 |
| tts_edge.py | Edge TTS |
| rewrite_cache.json | 改写缓存（.gitignore） |
| cookies.txt | YouTube cookies（.gitignore） |
| .env | OPENAI_API_KEY（.gitignore） |

---

## 十八、已实现功能

- AI Rewrite（播音员/说书人/翻译）
- 多音字修正 + 缺字补全（ANNOUNCER_PROMPT）
- 声线记忆（localStorage）
- Edge TTS 4种声线
- 自动分段 + Smart Cleaner（电子书开头清理）
- Streaming Pipeline（slot机制防race condition）
- 音频缓存（IndexedDB）+ 改写缓存（json）
- PDF / Word / YouTube字幕导入
- 任务隔离（JobId + AbortController）
- 断点恢复（文本hash匹配书架）
- 定时关闭（10/30/60分钟 / 本段结束）
- 书架（最多10本，Bottom Sheet）
- 段落导航（可随意跳转）
- 正在播放书名显示（marquee滚动）
- MiSans字体 + UI
- 生成等待动画（旋转雪花+呼吸文字）
- VPS(PM2) + Railway 双部署

---

## 十九、新对话开始时的背景说明

> 我有一个 AI 有声书播放器项目 ai-reader，本地路径 /Users/majun/ai-program/ai-reader，部署在 207.148.105.250:3000（PM2），GitHub：https://github.com/mjtouming/ai-reader，Railway 自动部署。
