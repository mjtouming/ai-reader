AI-Reader 项目 AI_CONTEXT v7（稳定开发版）
一、开发阶段说明（非常重要）

当前项目阶段：

优化阶段（不是架构开发阶段）

因此 AI 协作必须遵守：

禁止事项

禁止重写系统架构

禁止重写播放器核心 pipeline

禁止修改分段算法（splitTextIntoChunks）

禁止重写缓存机制（IndexedDB / rewrite_cache / tts_cache）

禁止进行大规模代码重构

AI 修改代码时必须

一步一步修改

只修改必要代码

保持当前架构

提供“完整可替换代码”（不允许只给片段）

不允许提出多个方案（默认给一个最稳妥方案）

用户是初学者：必须给可直接复制替换的一体化代码

二、产品定位（最重要）

AI-Reader 是：

AI 有声书播放器

不是：

简单 TTS 朗读工具

目标：

把普通文章转换为：

接近有声书体验的连续播放

核心价值：

Rewrite + Streaming Pipeline + 连续播放
三、朗读角色（Role-based Reading）

对外概念：

朗读角色（Role）

当前支持两个角色：

1）播音员（Announcer）

特点：

忠于原文

不评论

不加戏

语气克制

更像专业播音员

默认声线：

young_female
2）说书人（Storyteller）

特点：

忠于主线

允许适度点评

更像讲故事

有情绪和语气变化

默认声线：

elder_male
内部实现说明

前端：

modeSelect

支持：

original
story
translate

服务端根据 mode 使用不同 prompt：

ANNOUNCER
STORYTELLER
TRANSLATE

当前阶段：

对外统一叫 Role

内部继续使用：

mode

避免大规模代码修改。

四、翻译规则

如果输入文本为：

古文
英文
日文
其他外文

流程必须是：

翻译 → 改写 → TTS

即：

外文
↓
现代中文
↓
AI Rewrite
↓
TTS

当前阶段：

不强制自动识别语言
（产品规则先确定）

五、Smart Cleaner（电子书结构清理）

目的：

自动忽略电子书开头：

无意义朗读内容

提升：

启动速度
可用性
典型清理内容

只针对开头区域：

作者

编者

译者

出版社

出版信息

ISBN

CIP

定价

版权声明

以及：

目录块

例如：

第一章
第二章
Chapter 1
1.
实现位置

前端：

public/app.js

函数：

cleanBookTextForReading()

调用时机：

生成并播放
↓
Smart Cleaner
↓
splitTextIntoChunks

原则：

只扫描开头 ~200 行

避免误删正文。

六、系统架构（保持不变）
Browser
│
├─ public/app.js
│   ├─ Smart Cleaner
│   ├─ splitTextIntoChunks
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
│   └─ rewrite_cache.json
│
└─ Edge TTS
   └─ tts_edge.py
七、Pipeline 工作流程（核心）

正确流程：

chunk1 → 播放
同时生成 chunk2 / chunk3
播放 chunk2 时生成 chunk4

即：

Streaming Pipeline

目标：

播放器始终有：

音频缓冲区

避免：

播完等待生成
八、Pipeline 并行规则（非常重要）

播放 与 生成：

必须并行

禁止：

播放结束
↓
再生成下一段

正确：

播放 chunk1
↓
生成 chunk2 / chunk3
九、Chunk 顺序规则

即使后台生成顺序不同：

播放顺序必须：

严格按 chunkIndex

禁止：

按返回速度播放
十、Pipeline 并发限制

最多：

2 段

即：

next
nextNext

目的：

控制 OpenAI 并发

控制 CPU

避免浪费生成

十一、播放器缓存结构（前端）

当前实现：

currentAudioUrl
nextAudioUrl
nextNextAudioUrl

播放结束：

next → current
nextNext → next
生成新的 nextNext
十二、断点恢复机制（v7新增）

系统会保存：

text
chunks
currentIndex
currentTime
mode
voice
speed

存储位置：

localStorage

恢复逻辑：

刷新页面
↓
恢复 chunkIndex
↓
恢复段内时间 currentTime

实现：

restoreTime
loadedmetadata → currentTime
十三、启动速度优化

首段：

≈ 400 字

后续：

≈ 2200 字

目的：

更快启动
整体效率更高
十四、音频缓存（前端）

使用：

IndexedDB

key：

hash(text + mode + voice)

命中：

直接播放

未命中：

调用 /tts
生成后写入缓存
十五、改写缓存（后端）

文件：

rewrite_cache.json

作用：

避免重复调用 OpenAI
十六、缓存一致性规则

缓存命中必须：

size > 100 bytes

否则：

删除并重新生成

避免：

空文件
损坏缓存
十七、播放器状态机
Idle
↓
Generating
↓
Playing
↓
Finished / Interrupted

任何错误：

不得导致卡死
十八、任务隔离机制

使用：

currentJobId

规则：

新任务 +1

旧任务返回：

jobId != currentJobId

直接丢弃。

十九、任务中断机制

使用：

AbortController
interruptPlayback()

作用：

停止播放
停止生成
停止预生成
清理 objectURL

触发场景：

重新生成
上传文件
抓取URL
二十、错误处理原则

任何一段失败：

不中断系统

最低保证：

能停止
能重试
不卡死
二十一、UI / 交互规则
默认声线
original → young_female
story → elder_male
播放按钮
playPauseBtn

一个按钮控制：

播放 / 暂停
定时关闭

选项：

10 分钟
30 分钟
60 分钟
播放完当前段

实现：

sleepTargetTime
sleepMode=end
二十二、进度条策略

当前：

chunk 进度

播放器仍有：

时间进度

后续再评估。

二十三、主要代码文件

前端：

public/app.js
public/audioEngine.js

后端：

server.js
tts_edge.py

缓存：

IndexedDB
rewrite_cache.json
tts_cache
二十四、当前功能完成度

已实现：

AI Rewrite

Edge TTS

自动分段

Streaming Pipeline

音频缓存

Rewrite Cache

PDF / Word 导入

URL 抓取

任务中断

断点恢复

定时关闭

Smart Cleaner

完成度：

≈ 90%
二十五、当前最大瓶颈

启动时间受：

LLM Rewrite latency

影响：

20~40 秒
二十六、开发优先级
稳定性
↓
播放连续性
↓
启动速度
↓
功能扩展
二十七、AI 修改代码规则（最终版）

1️⃣ 必须提供完整代码
2️⃣ 不允许代码片段
3️⃣ 不允许多个方案
4️⃣ 用户是初学者
5️⃣ 必须一步一步修改

二十八、前端缓存规则（非常重要）

浏览器（尤其：

iOS Safari

）会强缓存 JS。

因此：

每次前端更新必须：

修改资源版本号

示例：

app.js?v=20260305
style.css?v=20260305

部署更新：

20260305 → 20260306

目的：

防止用户加载旧 JS