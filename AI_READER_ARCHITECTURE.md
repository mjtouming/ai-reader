AI-Reader Architecture v1
一、系统总体架构

AI-Reader 是一个 AI 有声书播放器系统。

核心流程：

用户输入文本 / PDF / Word / URL
        ↓
文本解析
        ↓
文本分段 (chunks)
        ↓
AI Rewrite
        ↓
TTS 生成音频
        ↓
播放器连续播放

系统由三部分组成：

Frontend (Browser)
↓
Node Server
↓
Edge TTS
二、整体系统结构
Browser
│
├─ UI
│
├─ 文本处理
│
├─ Rewrite 请求
│
├─ 音频缓存
│
└─ Audio Player
      ↓
      API
      ↓
Node Server
│
├─ Rewrite (OpenAI)
│
├─ Rewrite Cache
│
└─ Edge TTS
      ↓
      MP3
三、Frontend 架构

Frontend 主要负责：

用户输入

文本分段

音频 pipeline

播放控制

音频缓存

主要代码文件：

public/
 ├─ index.html
 ├─ style.css
 ├─ app.js
 └─ audioEngine.js
四、Frontend 模块说明
1. app.js

核心功能：

用户输入处理
文本分段
播放控制
pipeline 预生成
任务控制

主要逻辑：

输入文本
↓
splitTextIntoChunks()
↓
开始生成 chunk1
↓
播放 chunk1
↓
后台生成 chunk2
↓
后台生成 chunk3
2. audioEngine.js

负责：

调用 /tts API
IndexedDB 音频缓存
返回 audio URL

缓存流程：

hash(text + mode + voice)
↓
查 IndexedDB
↓
命中 → 直接播放
↓
未命中 → 请求 /tts

缓存内容：

audioBlob
五、Backend 架构

Backend 使用：

Node.js

主要文件：

server.js
tts_edge.py
rewrite_cache.json
六、Rewrite 系统

Rewrite 使用：

OpenAI API

流程：

previous chunk
+
current chunk
↓
Rewrite Prompt
↓
返回改写文本

Rewrite 目标：

优化朗读体验
保持故事连续
减少 AI 痕迹

Rewrite 结果会缓存：

rewrite_cache.json

避免重复调用 OpenAI。

七、TTS 系统

TTS 使用：

Edge TTS

调用流程：

server.js
↓
spawn python
↓
tts_edge.py
↓
Edge TTS
↓
生成 mp3

返回：

audio file
八、Audio Pipeline（核心机制）

播放器采用：

预生成 Pipeline

正确流程：

生成 chunk1
↓
播放 chunk1
↓
后台生成 chunk2
↓
后台生成 chunk3
↓
播放 chunk2
↓
后台生成 chunk4

目标：

播放器始终保持：

音频缓冲区

避免：

播放结束
↓
等待生成
九、Pipeline 并发规则

播放器最多允许同时生成：

2 段音频

例如：

播放 chunk1 时：

chunk2
chunk3

禁止生成：

chunk4
chunk5

原因：

控制 OpenAI API 成本
控制 CPU
避免生成无用音频
十、Chunk 顺序规则

后台生成顺序可能不同。

但播放必须严格按照：

chunk1
chunk2
chunk3
chunk4

禁止：

根据返回时间播放

必须：

根据 chunkIndex 播放
十一、播放器状态管理

播放器维护三个核心变量：

currentAudioUrl
nextAudioUrl
nextNextAudioUrl

含义：

currentAudioUrl
当前播放

nextAudioUrl
下一段

nextNextAudioUrl
下下段

播放结束：

next → current
nextNext → next
生成新的 nextNext
十二、任务隔离机制

播放器使用：

currentJobId

规则：

新任务
↓
jobId + 1

旧任务返回：

jobId != currentJobId

直接丢弃。

防止：

旧任务覆盖新任务
十三、任务中断机制

使用：

AbortController

核心函数：

interruptPlayback()

作用：

停止播放
终止 API
终止 pipeline
清理音频 URL
十四、缓存系统

系统有两层缓存：

前端缓存
IndexedDB

缓存：

音频文件
后端缓存
rewrite_cache.json

缓存：

AI Rewrite 结果

目的：

减少 OpenAI API 调用
十五、当前系统特点

AI-Reader 当前特点：

Rewrite + TTS

Rewrite 负责：

内容好不好听

TTS 负责：

声音像不像人

因此：

Rewrite 是核心能力
十六、未来架构扩展方向

未来可能扩展：

1 上下文窗口
previous chunk
→
previous chunks

提升故事连续性。

2 情绪控制

根据文本自动调整：

紧张
平静
惊悚
轻松
3 角色系统

未来可能增加：

历史讲述者
脱口秀风格
老师讲解
解说员
十七、设计原则

AI-Reader 架构设计原则：

简单
稳定
可扩展

开发优先级：

稳定性
↓
播放连续性
↓
启动速度
↓
功能扩展
十八、最重要的一条

AI-Reader 的核心不是播放器。

而是：

Rewrite + Pipeline

Rewrite 决定：

内容质量

Pipeline 决定：

听书体验