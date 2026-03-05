AI-Reader 项目 AI_CONTEXT v5（稳定开发版）

一、开发阶段说明（非常重要）
当前项目阶段：优化阶段（不是架构开发阶段）
因此 AI 协作必须遵守：
禁止事项：
- 禁止重写系统架构
- 禁止重写播放器核心 pipeline
- 禁止修改分段算法
- 禁止重写缓存机制
- 禁止进行大规模代码重构

AI 修改代码时必须：
- 一步一步修改
- 只修改必要代码
- 保持当前架构
- 提供“完整可替换代码”（不允许只给片段）
- 不允许提出多个方案（默认给一个最稳妥方案）
- 用户是初学者：必须给可直接复制替换的一体化代码

二、产品定位（最重要）
AI-Reader 是：AI 有声书播放器
不是：简单 TTS 朗读工具
目标：把普通文章转换为“接近有声书体验”的连续播放。

三、朗读角色（Role-based Reading）
对外概念：朗读角色（Role）
当前支持两个角色：
1) 播音员（Announcer）
- 特点：忠于原文、不评论、不加戏、语气克制、朗读更“干净”
- 默认声线：young_female
2) 说书人（Storyteller）
- 特点：忠于主线、允许适度点评/调侃、更像“讲”而不是“念”
- 默认声线：elder_male

内部实现说明：
- 前端 modeSelect 目前使用：original / story / translate（以及可扩展 announcer）
- 服务端根据 mode 选择不同 prompt（ANNOUNCER / STORYTELLER / TRANSLATE）
- 目前阶段：对外统一叫“角色”，内部继续沿用 mode，避免大改动

四、翻译规则
如果输入文本为：古文 / 英文 / 日文 / 其他外文
必须先：翻译成现代中文
再进入：AI 改写 → TTS
当前阶段：可以先不做自动识别（产品规则先确定）。

五、系统架构（保持不变）
Browser (Frontend)
│
├─ public/app.js
│   ├─ 文本分段 splitTextIntoChunks()（禁止改动算法）
│   ├─ 播放器控制（播放/暂停/自动续播）
│   ├─ pipeline 预生成（最多领先 1~2 段）
│   └─ 调用 audioEngine.js
│
├─ public/audioEngine.js
│   ├─ IndexedDB 音频缓存
│   └─ POST /tts
│
▼
Node Server
│
├─ server.js
│   ├─ OpenAI API：rewrite / translate（含 rewrite_cache.json）
│   └─ Edge TTS 调用（tts_cache 文件校验）
│
└─ Edge TTS
   └─ tts_edge.py 生成 mp3

六、Pipeline 工作流程（核心）
正确流程：
生成 chunk1 → 播放 chunk1
同时后台生成 chunk2 / chunk3
播放 chunk2 的同时继续生成 chunk4…
目标：播放器始终有音频缓冲区，避免“播完再等生成”。

七、Pipeline 并行规则（非常重要）
播放 与 生成 必须并行。
禁止：播放结束 → 再生成下一段。
生成必须领先播放至少 1~2 段。
AI 修改代码时禁止破坏该机制。

八、Chunk 顺序规则（非常重要）
即使后台生成顺序不同：播放顺序必须严格按 chunkIndex。
禁止：按返回快慢来播放。

九、Pipeline 并发限制
最多同时生成 2 段（next / nextNext）。
目的：控制 OpenAI 并发与 CPU，避免生成无用音频。

十、播放器缓存结构（前端）
currentAudioUrl：当前播放
nextAudioUrl：下一段
nextNextAudioUrl：下下段
播放结束：next → current；nextNext → next；再生成新的 nextNext。

十一、启动速度优化
首段较小：≈ 400 字（更快出第一段）
后续段：≈ 2200 字（整体效率更好）

十二、音频缓存（前端）
IndexedDB
key：hash(text + mode + voice)
命中：直接播放
未命中：请求 /tts → 缓存 blob

十三、改写缓存（后端）
rewrite_cache.json
目的：避免重复调用 OpenAI。

十四、缓存一致性规则
任何缓存命中必须校验 size > 100 bytes
否则删除并重新生成（避免空文件/坏缓存）。

十五、播放器状态机（原则）
Idle → Generating → Playing → Finished / Interrupted
任何错误不得导致“卡死”。

十六、任务隔离机制
currentJobId：每次新任务 +1
旧任务返回：jobId != currentJobId → 直接丢弃，避免串线。

十七、任务中断机制
AbortController + interruptPlayback()
功能：停止播放 / abort 当前请求 / abort 预生成 / 清理 objectURL。

十八、错误处理原则
任何一段失败：不中断整体可控性
最低兜底：能停止 / 能重试 / 能继续下一段（优先“不卡死”）。

十九、验证与日志（后端）
每次 /tts 建议打印：
- MODE
- rewrite previous: NONE 或 last 60 chars
- rewrite meta: role / chunk / previous
用于确认上下文衔接是否生效。

二十、UI/交互规则（v5 新增）
1) 默认声线自动切换：
- 选择 original → 自动设置 voice=young_female
- 选择 story → 自动设置 voice=elder_male
2) 播放/暂停合并为一个按钮：playPauseBtn（随播放状态切换文案）
3) 增加“定时关闭（sleep timer）”：到点后停止播放并终止预生成（走 interruptPlayback）
4) actions 行不换行：按钮与 sleepTimer 控件同一行展示（窄屏不掉到第二行）

二十一、进度条策略（当前）
当前进度显示仍以“段落进度”为主（chunk 级）。
播放器本身也提供时间进度条；后续是否移除段落进度，等试用后再定。

二十二、主要代码文件
前端：public/app.js / public/audioEngine.js
后端：server.js / tts_edge.py
缓存：IndexedDB / rewrite_cache.json / tts_cache

二十三、当前功能完成度
已实现：AI 改写、Edge TTS、自动分段、pipeline 预生成、音频缓存、rewrite 缓存、PDF/Word 导入、URL 抓取、任务打断、播放恢复、默认声线、播放按钮合并、定时关闭
完成度：≈ 85%

二十四、当前最大瓶颈
启动时间主要受：LLM rewrite latency（约 20~40 秒）影响。

二十五、开发优先级（不变）
稳定性 → 播放连续性 → 启动速度 → 功能扩展

二十六、AI 修改代码规则（最终版）
1) 必须提供完整可替换代码
2) 不允许只给代码片段
3) 不允许提出多种方案
4) 用户是初学者
5) 必须一步一步修改