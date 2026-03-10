# AI-Reader 项目 AI_CONTEXT v8（稳定开发版）

---

## 一、开发阶段说明（非常重要）

**当前项目阶段：优化阶段（不是架构开发阶段）**

### 禁止事项
- 禁止重写系统架构
- 禁止重写播放器核心 pipeline
- 禁止修改分段算法（splitTextIntoChunks）
- 禁止重写缓存机制（IndexedDB / rewrite_cache / tts_cache）
- 禁止进行大规模代码重构

### AI 修改代码时必须
- 一步一步修改
- 只修改必要代码
- 保持当前架构
- 提供"完整可替换代码"（不允许只给片段）
- 不允许提出多个方案（默认给一个最稳妥方案）
- 用户是初学者：必须给可直接复制替换的一体化代码

---

## 二、产品定位（最重要）

**AI-Reader 是：AI 有声书播放器**

不是：简单 TTS 朗读工具

**目标：** 把普通文章转换为接近有声书体验的连续播放

**核心价值：** Rewrite + Streaming Pipeline + 连续播放

---

## 三、朗读角色（Role-based Reading）

对外概念：**朗读角色（Role）**

### 1）播音员（Announcer）
- 忠于原文，不评论，不加戏，语气克制
- 更像专业播音员
- 默认声线：young_female

### 2）说书人（Storyteller）
- 忠于主线，允许适度点评，更像讲故事
- 有情绪和语气变化
- 默认声线：elder_male

### 内部实现说明
- 前端 modeSelect 支持：`original` / `story` / `translate`
- 服务端根据 mode 使用不同 prompt：`ANNOUNCER` / `STORYTELLER` / `TRANSLATE`
- 当前阶段对外统一叫 Role，内部继续使用 mode，避免大规模代码修改

---

## 四、翻译规则

如果输入文本为古文、英文、日文、其他外文，流程必须是：

```
外文 → 现代中文 → AI Rewrite → TTS
```

当前阶段不强制自动识别语言（产品规则先确定）。

---

## 五、YouTube 字幕提取功能（v8 新增）

### 功能说明
- 用户在文本框直接粘贴 YouTube 链接
- 点"生成并播放"时自动识别 YouTube URL
- 自动调用 `/fetch-youtube` 接口提取字幕
- 提取成功后自动切换到 `translate` 模式，`young_female` 声线
- 字幕文本填入文本框后继续正常播放流程

### 技术方案
- 工具：yt-dlp + cookies.txt 文件
- cookies.txt 放在项目根目录
- deno 用于 JS challenge solving

### YouTube URL 识别正则
```javascript
/youtube\.com\/watch|youtu\.be\//
```

### 服务端接口
```
POST /fetch-youtube
```
- 调用 yt-dlp 提取 `.en.vtt` 字幕
- 使用 `cleanVTT()` 清理时间戳/重复行，每5句合并一行
- timeout：60秒

### cookies.txt 维护
- 定期更新（几周到3个月）
- 失效信号：YouTube 链接失败 / 日志出现 `Sign in to confirm` / `HTTP Error 429`
- 更新方式：Mac 上用"Get cookies.txt LOCALLY"插件重新导出，scp 上传覆盖

---

## 六、Smart Cleaner（电子书结构清理）

**目的：** 自动忽略电子书开头无意义朗读内容，提升启动速度和可用性

**典型清理内容（只针对开头区域）：**
- 作者、编者、译者、出版社、出版信息、ISBN、CIP、定价、版权声明
- 目录块（第一章、Chapter 1、1. 等）

**实现位置：** `public/app.js` → `cleanBookTextForReading()`

**调用时机：** 生成并播放 → Smart Cleaner → splitTextIntoChunks

**原则：** 只扫描开头约200行，避免误删正文

---

## 七、系统架构（保持不变）

```
Browser
│
├─ public/app.js
│   ├─ Smart Cleaner
│   ├─ splitTextIntoChunks
│   ├─ YouTube URL 识别
│   ├─ 播放控制
│   ├─ pipeline 预生成
│   └─ audioEngine.js
│
├─ public/audioEngine.js
│   ├─ IndexedDB 音频缓存
│   └─ POST /tts
│
▼
Node Server
│
├─ server.js
│   ├─ OpenAI Rewrite
│   ├─ Translate
│   ├─ rewrite_cache.json
│   └─ POST /fetch-youtube (yt-dlp)
│
└─ Edge TTS
   └─ tts_edge.py
```

---

## 八、Pipeline 工作流程（核心）

```
chunk1 → 播放
同时生成 chunk2 / chunk3
播放 chunk2 时生成 chunk4
```

即 **Streaming Pipeline**，目标是播放器始终有音频缓冲区，避免播完等待生成。

---

## 九、Pipeline 核心规则

- 播放与生成必须**并行**，禁止播放结束再生成下一段
- 播放顺序必须严格按 chunkIndex，禁止按返回速度播放
- 最多并发 2 段（next + nextNext），控制 OpenAI 并发和 CPU

---

## 十、播放器缓存结构（前端）

```
currentAudioUrl
nextAudioUrl
nextNextAudioUrl
```

播放结束：next → current，nextNext → next，生成新的 nextNext

---

## 十一、断点恢复机制

系统保存：`text` / `chunks` / `currentIndex` / `currentTime` / `mode` / `voice` / `speed`

存储位置：localStorage

恢复逻辑：刷新页面 → 恢复 chunkIndex → 恢复段内时间 currentTime

---

## 十二、启动速度优化

- 首段：约 400 字
- 后续：约 2200 字
- 目的：更快启动，整体效率更高

---

## 十三、缓存机制

### 音频缓存（前端）
- 使用：IndexedDB
- key：hash(text + mode + voice)
- 命中：直接播放；未命中：调用 /tts，生成后写入缓存

### 改写缓存（后端）
- 文件：rewrite_cache.json
- 作用：避免重复调用 OpenAI

### 缓存一致性规则
- 缓存命中必须 size > 100 bytes，否则删除并重新生成

---

## 十四、播放器状态机

```
Idle → Generating → Playing → Finished / Interrupted
```

任何错误不得导致卡死。

---

## 十五、任务隔离与中断机制

- 使用 `currentJobId`，新任务 +1，旧任务返回时 jobId 不匹配直接丢弃
- 使用 `AbortController` / `interruptPlayback()`
- 触发场景：重新生成、上传文件、抓取URL、YouTube 链接提交

---

## 十六、错误处理原则

任何一段失败不中断系统，最低保证：能停止、能重试、不卡死

---

## 十七、UI / 交互规则

### 默认声线
- original → young_female
- story → elder_male

### 播放按钮
- playPauseBtn 一个按钮控制播放/暂停

### 定时关闭选项
- 10分钟 / 30分钟 / 60分钟 / 播完当前段
- 实现：sleepTargetTime / sleepMode=end

---

## 十八、前端缓存规则（非常重要）

浏览器（尤其 iOS Safari）会强缓存 JS。

每次前端更新必须修改资源版本号：
```
app.js?v=20260310
style.css?v=20260310
```

---

## 十九、VPS 部署信息（v8 新增）

| 项目 | 内容 |
|------|------|
| IP | 207.148.105.250 |
| 系统 | Ubuntu 24.04.4 LTS |
| 用户 | linuxuser |
| SSH别名 | `ssh tokyo` |
| 项目路径 | `/home/linuxuser/ai-reader` |
| 进程管理 | PM2（服务名：ai-reader） |
| 端口 | 3000（UFW 已开放） |
| 访问地址 | http://207.148.105.250:3000 |

### 服务器环境
- Node.js 20
- Python 3.12 + edge-tts
- yt-dlp 2026.3.3
- deno 2.7.4
- PM2

### 常用运维命令
```bash
pm2 logs ai-reader --lines 50    # 查看日志
pm2 restart ai-reader            # 重启服务
pm2 status                       # 查看状态

# 更新代码
cd ~/ai-reader
git pull
pm2 restart ai-reader

# 更新 yt-dlp
sudo pip3 install yt-dlp --upgrade --break-system-packages

# 更新 cookies.txt（Mac 上执行）
scp /Users/majun/ai-program/ai-reader/cookies.txt tokyo:~/ai-reader/cookies.txt
```

### 安全注意事项
- OpenAI API Key 在服务器，所有用户共享费用
- cookies.txt 使用个人 Google 账号，分享范围建议仅限信任的朋友
- 没有登录验证，不要公开传播 IP

---

## 二十、主要代码文件

| 文件 | 说明 |
|------|------|
| public/app.js | 前端主逻辑 |
| public/audioEngine.js | 音频引擎（IndexedDB缓存） |
| server.js | Node.js 后端 |
| tts_edge.py | Edge TTS |
| rewrite_cache.json | 改写缓存 |
| tts_cache/ | TTS 音频缓存目录 |
| cookies.txt | YouTube 认证 cookies |
| .env | 环境变量（OPENAI_API_KEY） |

---

## 二十一、当前功能完成度

已实现：
- AI Rewrite
- Edge TTS
- 自动分段
- Streaming Pipeline
- 音频缓存（IndexedDB）
- Rewrite Cache
- PDF / Word 导入
- URL 抓取
- YouTube 字幕提取
- 任务中断
- 断点恢复
- 定时关闭
- Smart Cleaner
- VPS 部署

**完成度：约 95%**

---

## 二十二、当前最大瓶颈

启动时间受 LLM Rewrite latency 影响：20~40 秒

---

## 二十三、开发优先级

```
稳定性 → 播放连续性 → 启动速度 → 功能扩展
```

---

## 二十四、新对话开始时的背景说明模板

> 我有一个部署在 207.148.105.250:3000 的 Node.js 项目 ai-reader，用 PM2 管理，GitHub 仓库：https://github.com/mjtouming/ai-reader，我想问关于 xxx 的问题。