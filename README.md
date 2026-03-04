
---

# AI-Reader 项目 README（开发状态说明）

## 一、项目概述

AI-Reader 是一个 **AI 文章朗读播放器**，支持：

* 文本 / PDF / Word / URL 导入
* AI 改写（OpenAI API）
* TTS 语音生成（Edge TTS）
* 自动分段朗读
* 后台预生成音频
* 本地缓存音频
* 播放进度恢复

目标是做成一个 **AI 有声书播放器**，而不是简单的 TTS 工具。

---

# 二、当前技术架构

整体流程：

```
文本输入
↓
文本分段（chunk）
↓
OpenAI API 改写文本
↓
Edge-TTS 生成语音
↓
前端 Audio 播放
↓
后台预生成下一段
```

---

# 三、核心播放逻辑

当前播放器实现 **流式播放 pipeline**：

```
播放 chunk N
↓
后台生成 chunk N+1
↓
后台生成 chunk N+2
```

实现方式：

```
currentAudioUrl
nextAudioUrl
nextNextAudioUrl
```

形成 **双缓冲播放结构**：

```
当前播放
下一段缓存
下下段缓存
```

---

# 四、启动速度优化（已实现）

为了减少启动等待时间：

原始逻辑：

```
chunk ≈ 2000字
LLM 改写
≈ 30秒
```

现在优化为：

```
第一段 ≈ 400字
后续段 ≈ 2000字
```

实现方式：

```
firstParts = splitTextIntoChunks(maxLen:400)
restParts  = splitTextIntoChunks(maxLen:2200)
chunks = [first, ...rest]
```

效果：

```
启动等待
50秒 → 10-20秒
```

---

# 五、缓存系统

使用 **IndexedDB** 缓存生成音频。

缓存 key：

```
hash(text + mode + voice)
```

缓存内容：

```
audioBlob
```

流程：

```
生成前
↓
检查缓存
↓
命中 → 直接播放
↓
未命中 → 请求 TTS
```

---

# 六、任务中断机制

播放器支持 **随时打断生成和播放**。

实现：

```
AbortController
currentJobId
interruptPlayback()
```

逻辑：

```
点击生成
↓
currentJobId++
↓
旧任务结果作废
```

保证：

```
旧音频不会污染新播放
```

---

# 七、播放器状态管理

关键变量：

```
chunks
currentIndex
isAutoPlaying
currentAbort
currentAudioUrl
nextAudioUrl
nextNextAudioUrl
```

播放流程：

```
playChunk(index)
↓
audioPlayer.play()
↓
ended → next chunk
```

---

# 八、Session 恢复

使用 localStorage 保存：

```
text
chunks
currentIndex
currentTime
mode
voice
speed
```

刷新页面后可以恢复：

```
播放进度
当前段落
语速
语音
```

---

# 九、文件导入支持

支持：

```
TXT
PDF
DOCX
URL抓取
```

流程：

```
上传文件
↓
后端解析
↓
返回文本
↓
填入 textInput
```

---

# 十、TTS 实现

TTS 使用：

```
edge-tts (Python)
```

调用流程：

```
Node server
↓
spawn python
↓
edge-tts
↓
生成 mp3
↓
返回前端
```

生成文件存储：

```
tts_cache/
```

---

# 十一、当前已实现功能

AI-Reader 已实现：

✔ 文本分段
✔ OpenAI 改写
✔ Edge-TTS 语音生成
✔ 自动播放
✔ 后台预生成
✔ 音频缓存（IndexedDB）
✔ 任务中断
✔ 播放进度恢复
✔ PDF / Word 解析
✔ URL 内容抓取

---

# 十二、当前已知限制

1️⃣ 启动仍需要等待第一段改写完成
2️⃣ OpenAI 改写速度较慢
3️⃣ UI 仍较简单
4️⃣ 没有跳段播放
5️⃣ 没有显示缓存进度

---

# 十三、下一阶段优化计划

优先级排序：

### P1 启动速度优化

* Streaming LLM
* 分句 TTS
* 几秒内开始播放

---

### P2 缓存改写文本

缓存：

```
rewrite_text
```

避免重复调用 OpenAI。

---

### P3 播放器 UI 升级

显示：

```
播放 3 / 60
缓存 8 段
```

---

### P4 跳段播放

支持：

```
点击段落
立即播放
```

---

### P5 MediaSession

支持：

```
锁屏控制
上一段 / 下一段
```

---

# 十四、当前项目状态

当前 AI-Reader 已达到：

```
功能完成度 ≈ 80%
```

核心架构稳定。

剩余工作主要是：

```
性能优化
UI优化
播放器体验
```

---

# 十五、开发环境

Node.js

主要依赖：

```
express
edge-tts (python)
pdf parser
docx parser
```

运行：

```
nodemon server.js
```

访问：

```
http://localhost:3000
```

---

# 十六、作者说明

该项目由开发者与 AI 协作开发。

目标是构建一个：

```
AI 有声书播放器
```

而不仅是一个简单的 TTS 工具。

---