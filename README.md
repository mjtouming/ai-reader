README.md
# AI Reader

AI Reader 是一个 **网页 AI 朗读工具**，可以把文本内容转换成语音播放，方便在通勤、散步、做家务等场景下听文章。

用户可以输入文本、上传文件或读取网页内容，然后通过 AI 改写与语音合成，将内容转换为可连续播放的音频。

项目当前是一个 **轻量级 Web 应用（Node + Edge TTS）**，重点在于实现：

- AI理解文本
- AI改写为适合朗读的内容
- 高质量语音播放

---

# 功能 Features

目前 AI Reader 支持以下功能：

### 1 文本朗读
用户可以直接输入文本进行朗读。

支持三种模式：

**原文朗读**


文本 → Edge TTS


**故事模式**


文本
↓
OpenAI 改写为更口语化内容
↓
Edge TTS


**翻译模式**


文本
↓
OpenAI 翻译 / 白话
↓
Edge TTS


---

### 2 文件上传

支持上传以下文件：

- TXT
- PDF
- DOCX

服务器会解析文件内容并转换为文本进行朗读。

接口：


/upload-pdf
/upload-word


---

### 3 网页内容朗读

用户可以输入网页链接：


/fetch-url


服务器抓取网页正文并转换为可朗读文本。

---

### 4 自动分段朗读

长文本会自动分段：


splitTextIntoChunks()


避免 TTS 长文本限制，同时支持连续播放。

---

### 5 自动连续播放

播放流程：


生成第一段音频
↓
播放
↓
audio ended
↓
生成下一段
↓
继续播放


实现类似 **有声书 / 播客** 的连续播放体验。

---

### 6 任务中断机制

如果用户在播放过程中点击 **生成并播放**：


AbortController


会立即终止旧任务，避免任务堆积。

---

### 7 播放控制

支持：

- 播放
- 暂停
- 调整语速

---

### 8 播放进度记忆

使用：


localStorage


保存：


audio currentTime


刷新页面可以恢复播放位置。

---

# 首页默认体验

为了优化新用户体验，首页设置了特殊逻辑。

### 第一次访问

自动：

- 填充《出师表》
- 默认 **故事模式**
- 默认 **老年男声**
- 自动开始朗读

通过：


localStorage ai_reader_visited


判断是否第一次访问。

---

### 再次访问

默认：

- 不自动填充文本
- 不自动播放
- 默认 **原文朗读**
- 默认 **青年女声**

---

# 技术架构

前端：


HTML
CSS
Vanilla JavaScript


后端：


Node.js
Express


部署：


Railway


AI能力：


OpenAI API


语音合成：


Microsoft Edge TTS


---

# 项目结构


ai-reader/
│
├── index.html
├── app.js
├── audioEngine.js
├── storage.js
├── style.css
│
├── server.js
├── tts_edge.py
│
├── uploads/
├── tts_cache/
│
├── package.json
└── README.md


---

# 主要文件说明

### index.html

页面结构与 UI。

---

### app.js

前端核心逻辑：

- 文本分段
- 自动播放控制
- AbortController 中断
- 播放队列

---

### audioEngine.js

负责：


调用后端 TTS
生成音频
返回 audio URL


---

### storage.js

负责：


localStorage
保存播放进度


---

### server.js

Node 后端服务：

- OpenAI API 调用
- TTS 调用
- 文件上传解析
- 网页抓取

---

### tts_edge.py

使用：


edge-tts


生成 MP3 音频。

---

# 本地运行

安装依赖：


npm install


启动服务器：


node server.js


或


nodemon server.js


服务器默认运行：


http://localhost:3000


---

# 环境变量

需要在 `.env` 中配置：


OPENAI_API_KEY=your_api_key


---

# 部署

当前部署平台：


Railway


流程：


GitHub push
↓
Railway 自动构建
↓
部署 Node 服务


---

# 当前项目阶段

项目当前处于：


MVP 完成
功能基本稳定


当前重点优化：

- 朗读体验
- AI 改写质量
- 语音自然度

---

# 未来优化方向

可能升级：

### 更好的 TTS

候选：


Google TTS
ElevenLabs


---

### AI播客模式

未来可能增加：


文本理解
AI改写
播客式朗读


---

# 项目目标

AI Reader 的目标不是简单朗读文本，而是实现：


文本
↓
AI理解
↓
AI改写
↓
自然语音播放


让任何文章都可以 **像播客一样被听到**。