AI-Reader Product Roadmap
一、产品愿景（Vision）

AI-Reader 的目标不是一个普通 TTS 工具。

目标是：

AI 有声书播放器

最终形态：

用户输入任何文本
↓
AI 自动理解内容
↓
AI 改写为适合朗读的版本
↓
AI 生成高质量语音
↓
连续播放

用户体验应接近：

听有声书

而不是：

听机器朗读

核心能力：

Rewrite + TTS + Pipeline

其中：

Rewrite 决定内容质量
TTS 决定声音质量
Pipeline 决定听书体验
二、产品发展阶段

AI-Reader 产品计划分为四个阶段：

v1  可用产品
v2  听书体验优化
v3  AI讲故事系统
v4  AI有声书平台

当前阶段：

v1 → v2 过渡阶段
三、v1 当前版本（已基本完成）

当前系统已经具备核心能力。

主要功能：

AI Rewrite
Edge TTS
自动文本分段
Audio Pipeline
音频缓存
Rewrite缓存
PDF导入
Word导入
URL抓取
任务中断
播放恢复
定时关闭
角色系统

当前系统结构：

Browser
↓
Rewrite API
↓
Edge TTS
↓
Audio Pipeline

当前完成度：

≈ 85%

当前最大问题：

Rewrite latency
≈ 20~40秒
四、v2 阶段（听书体验优化）

v2 的目标：

让 AI-Reader 更像真正的有声书播放器

重点优化三个方面：

Rewrite质量
启动速度
播放体验
v2.1 Rewrite 升级

Rewrite 从：

previous chunk

升级为：

previous chunks

目标：

提升故事连续性
减少重复开场
增强叙事流畅度

未来可能加入：

情绪识别
叙事节奏控制
人物语气
v2.2 Rewrite 角色升级

当前角色：

播音员
说书人

未来扩展：

历史讲述者
老师讲解
纪录片解说
脱口秀风格

目标：

用户可以选择不同：

叙事风格
v2.3 Rewrite 节奏控制

Rewrite 不仅改写文本，还控制：

节奏
停顿
氛围

例如：

短句
停顿句
拟声词

提升听感。

v2.4 启动速度优化

当前流程：

Rewrite
↓
TTS
↓
播放

未来优化方向：

Rewrite 与 TTS 并行

目标：

首段启动时间 < 10 秒
五、v3 阶段（AI讲故事系统）

v3 的目标：

AI 不只是朗读，而是讲故事

AI 会理解：

人物
情节
气氛

实现：

动态叙事

例如：

紧张情节：

语速加快
句子更短

平静情节：

语速放慢
句子更长

甚至可以：

不同人物不同语气
六、v4 阶段（AI有声书平台）

最终阶段：

AI-Reader 不只是播放器。

而是：

AI 有声书平台

用户可以：

上传文章
生成有声书
分享
订阅

AI-Reader 可以：

自动生成完整有声书

甚至支持：

多角色朗读
AI配音
情绪控制
七、技术演进路线

技术发展顺序：

Rewrite
↓
Pipeline
↓
情绪控制
↓
角色系统
↓
AI讲故事

核心技术始终是：

Rewrite

而不是：

TTS
八、功能开发优先级

开发顺序必须遵守：

稳定性
↓
播放连续性
↓
启动速度
↓
Rewrite质量
↓
UI优化
↓
新功能

禁止：

为了新功能破坏稳定性
九、产品原则

AI-Reader 设计原则：

简单
稳定
自然

最重要的是：

听起来像真人

而不是：

技术复杂
十、最重要的一句话

AI-Reader 的目标不是：

朗读文本

而是：

讲故事