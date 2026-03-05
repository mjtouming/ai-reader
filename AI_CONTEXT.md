AI-Reader 项目 AI_CONTEXT v3
开发阶段说明（非常重要）

当前项目已经进入：

优化阶段

不是：

架构开发阶段

因此 AI 协作必须遵守以下规则：

禁止重写系统架构
禁止重写播放器逻辑
禁止大规模代码改动

AI 修改代码时必须：

一步一步修改

只修改必要代码

保持当前架构

提供可直接替换代码

不增加复杂设计

目标：

在稳定架构上逐步优化。

项目目标

AI-Reader 是一个 AI文章朗读播放器。

目标：

将普通文章转换为 接近有声书体验的连续播放。

用户流程：

输入文本 / PDF / Word / URL
↓
AI 改写文本
↓
TTS 生成语音
↓
自动分段播放
↓
后台预生成下一段

最终目标：

AI 有声书播放器

而不是简单 TTS。

系统架构图
Browser (Frontend)
│
├─ public/app.js
│   │
│   ├─ 文本分段
│   │   splitTextIntoChunks()
│   │
│   ├─ 播放器控制
│   │
│   ├─ pipeline 预生成
│   │
│   └─ 调用 audioEngine.js
│
├─ public/audioEngine.js
│   │
│   ├─ IndexedDB 音频缓存
│   │
│   └─ POST /tts
│
▼
Node Server (server.js)
│
├─ OpenAI API
│   │
│   ├─ 文本改写
│   └─ rewrite_cache.json
│
└─ Edge TTS
    │
    └─ tts_edge.py
         │
         └─ 生成 mp3
Pipeline 工作流程

播放器采用 预生成 Pipeline。

运行流程：

生成 chunk 1
↓
播放 chunk 1
↓
后台生成 chunk 2
↓
后台生成 chunk 3
↓
播放 chunk 2
↓
后台生成 chunk 4
↓
播放 chunk 3

目标：

保证播放器始终有 音频缓冲区。

播放器缓存结构

播放器维护三个核心变量：

currentAudioUrl
nextAudioUrl
nextNextAudioUrl

含义：

currentAudioUrl
当前播放音频

nextAudioUrl
下一段音频

nextNextAudioUrl
下下段音频

播放结束时：

next → current
nextNext → next
生成新的 nextNext
启动速度优化

为了减少启动等待：

第一段：

≈ 400 字

后续段：

≈ 2200 字

实现：

first chunk small
rest chunks large

效果：

显著减少首段等待时间。

缓存系统
音频缓存

前端使用：

IndexedDB

缓存 Key：

hash(text + mode + voice)

缓存内容：

audioBlob

流程：

先查缓存
命中 → 直接播放
未命中 → 请求 TTS
改写缓存

服务器缓存：

rewrite_cache.json

避免重复调用 OpenAI。

播放器状态机

播放器可以理解为以下状态：

Idle
Generating
Playing
Interrupted
Finished

状态转换：

Generate
↓
Generating
↓
Playing
↓
Ended
↓
Playing next
关键变量说明
currentJobId

用于防止任务串线。

每次生成：

currentJobId + 1

旧任务返回：

jobId != currentJobId
→ 直接丢弃
AbortController

用于中断任务。

interruptPlayback()

功能：

停止播放
abort TTS
abort 预生成
清理URL
主要代码文件

前端：

public/app.js
public/audioEngine.js

后端：

server.js
tts_edge.py

缓存：

IndexedDB
rewrite_cache.json
当前功能完成度

当前已经实现：

AI 改写
Edge TTS
自动分段
pipeline 预生成
音频缓存
改写缓存
PDF / Word 导入
URL 抓取
任务打断
播放恢复

项目完成度：

≈ 80%
当前最大瓶颈

启动时间仍然受影响：

LLM rewrite latency
≈ 20~40 秒

原因：

AI 改写耗时。

未来优化方向

未来可能优化：

改写缓存优化
rewrite 与 TTS 并行
Streaming LLM
更智能分段
控制预生成数量
允许 AI 修改的内容
预生成策略优化
缓存策略优化
性能优化
日志优化
UI小改动
禁止 AI 修改的内容
播放器核心结构
pipeline逻辑
分段算法
缓存机制
整体架构
开发原则

优先级：

稳定性
↓
播放连续性
↓
启动速度
↓
功能扩展

避免复杂设计。

AI 修改代码规则：

1 必须提供完整可替换代码
2 不允许只给片段
3 不允许提出多种方案
4 用户是初学者
5 必须一步一步修改

# AI-Reader 项目 AI_CONTEXT v3.1（优化阶段）

## 开发阶段说明（非常重要）
当前项目已进入【优化阶段】，不是【架构开发阶段】。

协作规则：
- 禁止重写系统架构
- 禁止重写播放器核心 pipeline 逻辑
- 禁止大规模代码改动
- 必须一步一步修改
- 只改必要代码
- 必须提供可直接整体替换的完整代码（禁止只给片段）
- 不提供多方案分支（默认给最稳妥单方案）

目标：在稳定架构上逐步优化。

---

## 产品定位（新增：最重要）
对外产品概念从“朗读模式”升级为【朗读角色】（Role-based Reading）。

当前只做两个角色：
1) 播音员：忠于原文、克制、不点评、不加戏
2) 说书人：忠于主线与事实，可适度点评/调侃/铺垫，让听感更像“讲故事”

说明：
- 对内实现字段暂时仍使用 mode（避免大改），但对外统一称“角色”。

### 角色与声线默认绑定（新增）
- 播音员：默认 young_female
- 说书人：默认 elder_male
- 当前阶段不做 UI 大改，声线选择器可暂保留，但默认值必须按角色绑定。

### 翻译规则（新增：两角色共用）
- 输入为古文/外文：无论播音员/说书人，必须先翻译成现代中文再进入后续流程。
- 当前阶段可先不做自动识别，后续再优化；但产品规则先定死。

---

## 项目目标
AI-Reader 是一个 AI 文章朗读播放器。
目标：将普通文章转换为接近有声书体验的连续播放。

用户流程：
输入文本 / PDF / Word / URL
↓
AI 文本处理（翻译/改写，取决于角色与输入类型）
↓
TTS 生成语音
↓
自动分段播放
↓
后台预生成下一段

最终目标：AI 有声书播放器，而不是简单 TTS。

---

## 系统架构图
Browser (Frontend)
│
├─ public/app.js
│   ├─ 文本分段 splitTextIntoChunks()
│   ├─ 播放器控制
│   ├─ pipeline 预生成
│   └─ 调用 audioEngine.js
│
├─ public/audioEngine.js
│   ├─ IndexedDB 音频缓存
│   └─ POST /tts
│
▼
Node Server (server.js)
│
├─ OpenAI API
│   ├─ 文本处理（翻译/改写）
│   └─ rewrite_cache.json
│
└─ Edge TTS
    └─ tts_edge.py → 生成 mp3

---

## Pipeline 工作流程
生成 chunk1 → 播放 chunk1
同时后台生成 chunk2、chunk3
播放 chunk2 时生成 chunk4
目标：播放器始终有音频缓冲区。

---

## 缓存一致性规则（新增：防止坏缓存）
- tts_cache 命中条件：文件存在且 size > 100 bytes（阈值可调整）
- 否则视为坏缓存：删除并重新生成
- 目的：避免 edge-tts 失败留下空文件导致“cache hit 但无法播放”

---

## 错误处理原则（新增：不中断播放）
- 任一段生成失败不得让播放“卡死在下一段”
- 最低兜底：提示用户，并提供 重试 / 跳过 / 停止
- 优先级：不中断用户体验 > 完美改写/完美音质

---

## 验证与日志（新增）
- server 每次 /tts 打印 rewrite previous: NONE 或 last 60 chars
- 目标：从第 2 段开始不再是 NONE（说明 previous 传递生效）
- 听感目标：段与段之间不再像“重新开场”

---

## 其余章节（沿用 v3 原文）
（pipeline 三段缓存、首段加速、jobId、Abort、文件列表、完成度、未来方向等保持不变）