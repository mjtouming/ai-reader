# CHANGELOG

> 本文档根据代码结构、功能模块和开发文档整理，记录 AI-Reader 各阶段已实现的功能。

---

## [v1.8] — 2026-03  YouTube 字幕 + VPS 部署（当前版本）

对应 AI_CONTEXT v8，项目进入稳定运维阶段。

### 新增

**YouTube 字幕提取**
- 新增 `/fetch-youtube` 后端接口，调用 `yt-dlp` 提取英文 VTT 字幕
- 新增 `cleanVTT()` 函数：自动清除时间戳、去除重复行、每 5 句合并为一段
- 前端识别正则 `/youtube\.com\/watch|youtu\.be\//`，用户粘贴 YouTube URL 后自动触发字幕流程
- 提取成功后自动切换到 `translate` 模式、`young_female` 声线，无需手动配置
- 接口 timeout 设为 60 秒，失败返回清晰错误信息
- 使用 `cookies.txt` 进行 YouTube 账号认证，避免访问频率限制

**VPS 生产部署**
- 部署到 Ubuntu 24.04 VPS（207.148.105.250:3000）
- 使用 PM2 进行进程守护与自动重启
- 服务绑定 `0.0.0.0:3000`，UFW 防火墙开放端口
- 服务器环境：Node.js 20、Python 3.12 + edge-tts、yt-dlp 2026.3.3、deno 2.7.4

**前端版本管理**
- 引入资源版本号机制（`app.js?v=20260310-4`、`audioEngine.js?v=20260310-5`）
- 避免 iOS Safari 等浏览器强缓存旧版 JS/CSS

---

## [v1.7] — Smart Cleaner + 启动速度优化

### 新增

**Smart Cleaner（电子书结构清理）**
- 新增 `cleanBookTextForReading()` 函数，仅扫描文本开头约 220 行
- 自动过滤：作者/编者/出版社/ISBN/CIP/定价/版权声明等元信息行
- 自动识别并跳过目录块（支持"目录"标题、"第X章"密集行、`Chapter N`、数字编号列表）
- 目录检测策略：先查"目录"标题关键词，未命中则对连续 18 行中目录行密度做滑动窗口统计（≥ 60% 触发）
- 清理后压缩多余空行，保证正文干净

**启动速度优化**
- 首段分段长度从 ~2000 字缩减至约 400 字，大幅缩短首段 LLM 改写时间
- 后续段保持约 2200 字，兼顾效率
- 实现方案：先用 `maxLen:400` 切出首段，再用 `maxLen:2200` 切剩余，合并为 chunks 数组

---

## [v1.6] — 说书人 Prompt v3 + 角色联动声线

### 优化

**说书人（Storyteller）Prompt 重大升级至 v3**
- 明确风格定位：单田芳 / 郭德纲 / 深夜说书风格
- 新增详细示范：原文 vs 说书人版对比（推门、摔门、战场三个示例）
- 引入语气词使用规范：`哎/嘿/唉/得嘞` 各有专属情绪场景，禁止乱用
- 引入点评质量规则：禁止套话废话，宁可不评也不说无聊话
- 新增拟声词规范：`轰——/砰。/哗啦啦` 等增强现场感
- temperature 调整为 0.92，增强创意演绎幅度

**朗读角色与声线自动联动**
- 切换"原文朗读"模式 → 自动设为 `young_female` 声线
- 切换"改成故事"模式 → 自动设为 `elder_male` 声线
- 通过 `modeSelect.addEventListener("change")` 实现前端实时联动

---

## [v1.5] — 可靠性加固：任务隔离 + 错误容错

### 新增

**任务隔离机制（JobId）**
- 引入 `currentJobId` 全局计数器，每次新任务 `+1`
- Pipeline 生成时记录任务启动时的 jobId，回调时比对，不匹配则静默丢弃
- 防止旧任务音频污染新任务播放队列

**AbortController 中断机制**
- 切换文本、重新生成、上传文件、URL 抓取、YouTube 提交均触发 `interruptPlayback()`
- 使用 `AbortController` 和 `signal` 向 `/tts` 请求发送中止信号
- 中止后清空 `currentAudioUrl / nextAudioUrl / nextNextAudioUrl` 三层缓冲

**自动重试**
- `generateAudioFromText()` 内置最多 2 次自动重试（间隔 1 秒）
- AbortError 不重试，直接抛出
- 单段失败不中断全局播放，记录错误后继续推进

---

## [v1.4] — 缓存系统：IndexedDB + Rewrite Cache

### 新增

**前端音频缓存（IndexedDB）**
- 使用 IndexedDB 数据库 `ai_reader_audio_cache`，object store 名：`audio`
- 缓存 key：`"audio_" + hash(text + "|" + mode + "|" + voice)`（djb2 哈希）
- 命中缓存直接返回 `URL.createObjectURL(blob)`，不发起网络请求
- 未命中时请求 `/tts`，响应后写入缓存，下次复用

**后端改写缓存（rewrite_cache.json）**
- 缓存 key：`SHA1(text + "|" + mode)`
- 命中时跳过 OpenAI 调用，直接进入 TTS 环节
- 每次写入后同步持久化到磁盘（`fs.writeFileSync`）
- 防护规则：服务器端 TTS 缓存文件 size ≤ 100 bytes 视为损坏，自动删除并重新生成

**X-Rewritten-Text 响应头**
- `/tts` 接口在响应头中返回改写后文本（`encodeURIComponent` 编码）
- 前端读取 `X-Rewritten-Text`，支持后续展示改写内容

---

## [v1.3] — Streaming Pipeline + 断点恢复 + 定时关闭

### 新增

**三段式 Streaming Pipeline**
- 三层音频缓冲：`currentAudioUrl / nextAudioUrl / nextNextAudioUrl`
- 播放 chunk N 时，后台同时预生成 chunk N+1 和 N+2
- 播放结束后：next → current，nextNext → next，新生成 nextNext
- 最大并发 2 段，控制 OpenAI API 并发量和服务器 CPU 占用
- 严格按 `chunkIndex` 顺序播放，禁止按返回速度乱序

**断点恢复（localStorage）**
- Session key：`ai_reader_session_v1`
- 保存字段：`text / chunks / currentIndex / currentTime / mode / voice / speed`
- 页面刷新后自动恢复：定位到上次段落序号 + 段内播放时间（`currentTime`）
- 切换内容、重新生成等操作自动更新 session

**定时关闭（Sleep Timer）**
- 支持四挡：10 分钟 / 30 分钟 / 60 分钟 / 播完当前段
- 实现：`sleepTargetTime`（时间戳到期）和 `sleepMode="end"`（段结束触发）
- UI：`<select id="sleepTimer">` 下拉选择

**进度条**
- `<progress id="progressBar">` 显示当前段 / 总段数
- `progressLabel` 文字标注 `当前段/总段数`
- `statusText` 显示运行状态（就绪 / 生成中 / 播放中 / 错误）

---

## [v1.2] — 文件导入 + URL 抓取

### 新增

**PDF 导入**
- 后端接口：`POST /upload-pdf`（multer 接收文件，pdf-parse 解析）
- 提取全部正文文本，返回 JSON `{ text }`
- 前端通过 `<input type="file" accept=".pdf">` 触发上传

**Word（.docx）导入**
- 后端接口：`POST /upload-word`（multer 接收文件，mammoth 解析）
- 提取纯文本（`extractRawText`），去除格式标签
- 前端通过文件选择器触发

**URL 抓取**
- 前端提供 URL 输入框 + "抓取"按钮（fetchUrlBtn）
- 后端使用 axios + cheerio 抓取网页正文（实现在 app.js 客户端调用）
- 抓取结果填入 textInput，继续正常播放流程

**统一文件选择器**
- `<input accept=".txt,.docx,.pdf">` 三种格式统一入口
- 上传成功后自动填充文本框并触发播放准备

---

## [v1.1] — 角色系统 + 多声线 + 分段算法

### 新增

**三种朗读角色**
- `original / announcer`：播音员模式（ANNOUNCER_PROMPT），temperature 0.4，专业克制
- `story`：说书人模式（STORY_PROMPT），temperature 0.92，口语演绎
- `translate`：翻译模式（TRANSLATE_PROMPT），temperature 0.2，古文/外文翻译为白话

**通用改写规则（COMMON_RULES）**
- 禁止输出解释或前后缀，只输出可朗读正文
- 禁止编造事实（新人物/新事件/新数据）
- 朗读友好：短句、自然停顿、去除"点击这里"等网页口吻
- 连续性：必须承接上一段，禁止每段重新开场
- 外文/古文：先翻译为现代中文，再做朗读化

**段落连续性（Previous Context）**
- 每段请求时携带上一段改写后文本（截取后 400 字）
- 服务端将 `previous` 注入 userContent，保持叙事衔接

**四种声线（Edge TTS）**
- `young_female`：zh-CN-XiaoxiaoNeural
- `girl`：zh-CN-XiaoyiNeural
- `young_male`：zh-CN-YunxiNeural
- `elder_male`：zh-CN-YunjianNeural

**文本分段算法（splitTextIntoChunks）**
- 按双空行（`\n\n`）切分段落，贪婪合并至 maxLen（默认 2200 字）
- 超长单段按句号/问号/感叹号切分（`splitBySentence`）
- 极超长单句强制按字符数切分
- 尾部短段（< 800 字）自动合并到上一段，避免碎片化

---

## [v1.0] — 核心 MVP

### 新增

**基础 TTS 流程**
- 后端接口 `POST /tts`：接收文本 + 角色 + 声线，调用 `runEdgeTTS()` 生成 mp3
- `runEdgeTTS()`：通过 `spawn` 调用 Python 脚本 `tts_edge.py`，stdin 传入文本，异步等待完成
- Python 路径自动检测：优先使用 `.venv/bin/python`，其次 `python3`，支持 `PYTHON_PATH` 环境变量覆盖
- 音频通过 `fs.createReadStream().pipe(res)` 流式返回，Content-Type 为 `audio/mpeg`

**基础前端播放器**
- 单按钮 `playPauseBtn` 控制播放/暂停
- `generateBtn`"生成并播放"触发整个流程
- `audioPlayer`（HTML5 `<audio controls>`）作为底层播放器
- 支持语速选择：0.8x / 1x / 1.2x / 1.5x

**基础 Express 服务**
- 静态文件服务（`public/` 目录）
- CORS 全域允许
- 端口通过 `PORT` 环境变量配置，默认 3000
- dotenv 加载 `.env` 文件（OPENAI_API_KEY）

**Docker 支持**
- 基于 `node:22` 镜像，内置 Python 3 + 虚拟环境
- 自动安装 Node 依赖（npm install）和 Python 依赖（edge-tts）
- 暴露端口 8080，`CMD ["node", "server.js"]`

---

## 已知限制 / 待优化

- 首段启动时间受 LLM Rewrite latency 影响，当前约 20～40 秒
- 没有用户鉴权，不建议公开传播服务地址
- `cookies.txt` 需定期手动刷新（每隔数周），失效会导致 YouTube 功能不可用
- 没有跳段播放功能（当前只能顺序播放）
- 没有缓存进度可视化

---

## 路线图（规划中）

- **v2.x** — 听书体验：Rewrite 质量提升、多段上下文、Rewrite + TTS 并行加速首段
- **v3.x** — AI 讲故事系统：动态情绪识别、语速自动调节
- **v4.x** — 有声书平台：用户上传、生成、分享
