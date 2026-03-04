
---

# AI-Reader 项目 AI_CONTEXT

## 项目目标

AI-Reader 是一个 **AI文章朗读播放器**。

核心功能：

1. 用户输入文章 / PDF / Word / URL
2. 使用 OpenAI API **改写文本**
3. 使用 Edge-TTS **生成语音**
4. 自动 **分段播放**
5. 后台 **预生成下一段音频**
6. 实现 **接近流式的听书体验**

目标是做成：

**AI 有声书播放器**

而不是简单 TTS。

---

# 当前核心架构

整体流程：

```
文本
↓
文本分段 (chunks)
↓
OpenAI 改写
↓
Edge TTS
↓
Audio 播放
```

播放采用 **pipeline 预生成**：

```
播放 chunk N
后台生成 chunk N+1
后台生成 chunk N+2
```

播放器维护：

```
currentAudioUrl
nextAudioUrl
nextNextAudioUrl
```

---

# 启动速度优化（已实现）

为了减少启动等待：

第一段：

```
≈ 400字
```

后续段：

```
≈ 2200字
```

实现：

```
first chunk small
rest chunks large
```

效果：

启动时间：

```
≈ 50s → 10~20s
```

---

# 缓存系统

前端使用 **IndexedDB** 缓存音频：

```
key = hash(text + mode + voice)
```

缓存：

```
audioBlob
```

流程：

```
先查缓存
命中 → 直接播放
未命中 → 请求 TTS
```

---

# 当前播放机制

播放器自动：

```
播放 chunk N
↓
后台生成 N+1
↓
后台生成 N+2
```

播放结束：

```
ended → play next
```

支持：

```
任务打断
进度恢复
```

---

# 主要代码文件

前端：

```
public/app.js
public/audioEngine.js
```

后端：

```
server.js
tts_edge.py
```

缓存：

```
IndexedDB (audio cache)
```

TTS：

```
Edge-TTS
```

AI 改写：

```
OpenAI API
```

---

# 当前状态

项目已经实现：

✔ AI 改写
✔ TTS 生成
✔ 分段播放
✔ 后台预生成
✔ 音频缓存
✔ PDF / Word 导入
✔ 播放恢复

整体完成度：

```
≈ 80%
```

---

# 当前最大瓶颈

启动时间仍然较长：

原因：

```
LLM 改写
≈ 30s
```

未来优化方向：

1️⃣ 缓存改写文本
2️⃣ Streaming LLM
3️⃣ 分句生成音频

---

# 与 AI 协作要求

该项目用户 **不是程序员**。

AI 修改代码必须：

1. **一步一步修改**
2. **只改必要代码**
3. **不要大规模重写**
4. **保证代码能直接替换运行**

避免复杂方案。

---
