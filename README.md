# AI-Reader · AI 有声书播放器

> 把任意文章、PDF、Word、YouTube 视频，变成接近有声书体验的连续播放。

---

## 项目介绍

AI-Reader 不是一个简单的 TTS 朗读工具，它的核心是 **AI Rewrite + Streaming Pipeline**：

1. 将输入文本按段切分
2. 用 GPT-4o-mini 对每段进行朗读化改写（去 AI 味、短句化、口语化）
3. 用 Microsoft Edge TTS 生成高质量中文语音
4. 通过流式预生成 Pipeline，实现"播放 chunk1 时后台已在生成 chunk2、chunk3"的连续体验

**核心理念：** Rewrite 决定内容好不好听，Pipeline 决定听书体验是否流畅。

---

## 技术栈

### 后端

| 技术 | 用途 |
|------|------|
| Node.js 20 + Express 5 | HTTP 服务器、API 路由 |
| OpenAI GPT-4o-mini | 文本朗读化改写（AI Rewrite） |
| Python 3 + edge-tts | Microsoft Edge TTS 语音合成 |
| yt-dlp | YouTube 字幕提取 |
| mammoth | Word (.docx) 文本解析 |
| pdf-parse | PDF 文本解析 |
| multer | 文件上传处理 |
| dotenv | 环境变量管理 |
| PM2 | VPS 进程管理 |

### 前端

| 技术 | 用途 |
|------|------|
| 原生 HTML / CSS / JavaScript | 无框架，轻量 |
| Web Audio API | 音频播放控制 |
| IndexedDB | 前端音频缓存 |
| localStorage | 断点恢复状态存储 |

### 基础设施

| 技术 | 用途 |
|------|------|
| Docker | 容器化部署支持 |
| Ubuntu 24.04 VPS | 生产服务器 |

---

## 安装步骤

### 本地开发

**前置要求：** Node.js 18+、Python 3.10+、pip

```bash
# 1. 克隆项目
git clone https://github.com/mjtouming/ai-reader.git
cd ai-reader

# 2. 安装 Node.js 依赖
npm install

# 3. 安装 Python 依赖（推荐使用虚拟环境）
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 4. 配置环境变量
# 创建 .env 文件并填入 OpenAI API Key
echo "OPENAI_API_KEY=sk-xxxx" > .env

# 5. 启动服务
npm start
# 访问 http://localhost:3000
```

### Docker 部署

```bash
# 构建镜像
docker build -t ai-reader .

# 运行容器
docker run -d \
  -p 8080:8080 \
  --env-file .env \
  --name ai-reader \
  ai-reader
```

### VPS 部署（Ubuntu + PM2）

```bash
# 1. 安装系统依赖
sudo apt update
sudo apt install -y nodejs npm python3 python3-pip
sudo pip3 install edge-tts yt-dlp --break-system-packages
npm install -g pm2

# 2. 克隆并安装
git clone https://github.com/mjtouming/ai-reader.git ~/ai-reader
cd ~/ai-reader && npm install

# 3. 配置环境变量
echo "OPENAI_API_KEY=sk-xxxx" > .env

# 4. 启动并守护进程
pm2 start server.js --name ai-reader
pm2 save && pm2 startup
# 访问 http://你的服务器IP:3000
```

### 运维常用命令

```bash
pm2 logs ai-reader --lines 50        # 查看实时日志
pm2 restart ai-reader                # 重启服务
pm2 status                           # 查看运行状态

# 更新代码
cd ~/ai-reader && git pull && pm2 restart ai-reader

# 更新 yt-dlp（YouTube 字幕功能依赖，建议定期更新）
sudo pip3 install yt-dlp --upgrade --break-system-packages

# 刷新 YouTube cookies（每隔数周需更新一次）
scp /本地路径/cookies.txt 服务器:~/ai-reader/cookies.txt
```

---

## 功能列表

### 输入源支持

- **纯文本** — 直接粘贴任意文章到文本框
- **PDF 导入** — 上传 PDF 文件，自动提取正文
- **Word 导入** — 上传 .docx 文件，自动提取正文
- **URL 抓取** — 粘贴网页链接，自动抓取正文内容
- **YouTube 字幕** — 粘贴 YouTube 链接，自动提取英文字幕并翻译朗读

### 朗读角色（AI Rewrite 模式）

| 角色 | 风格特点 | 默认声线 |
|------|---------|---------|
| 播音员（Announcer） | 忠于原文，专业克制，适合新闻 / 纪录片 | 年轻女声 |
| 说书人（Storyteller） | 口语演绎，有情绪节奏，适合故事 / 小说 | 老年男声 |
| 翻译（Translate） | 古文 / 外文翻译为现代中文后朗读 | 年轻女声 |

### 声线选择

4 种 Microsoft Edge TTS 中文声线：

- 年轻女声（zh-CN-XiaoxiaoNeural）
- 少女声（zh-CN-XiaoyiNeural）
- 年轻男声（zh-CN-YunxiNeural）
- 老年男声（zh-CN-YunjianNeural）

### 播放体验

- **Streaming Pipeline** — 边播边预生成，最多并发缓冲前方 2 段，播放不卡顿
- **断点恢复** — 刷新页面自动从上次位置继续（保存段落序号和段内时间）
- **播放速度** — 支持自定义倍速播放
- **定时关闭** — 支持 10 / 30 / 60 分钟或播完当前段自动停止

### 缓存机制

- **前端音频缓存（IndexedDB）** — 相同文本 + 角色 + 声线组合的音频不重复生成
- **后端改写缓存（rewrite_cache.json）** — 相同文本 + 角色的 AI Rewrite 结果不重复调用 OpenAI

### 智能文本处理

- **Smart Cleaner** — 自动跳过电子书开头的版权声明、ISBN、目录等无意义内容（仅扫描开头约 200 行）
- **启动加速分段** — 首段约 400 字（快速启动），后续每段约 2200 字（效率优先）
- **VTT 字幕清理** — 自动去除时间戳、重复行，每 5 句合并为一段

### 工程特性

- **任务隔离** — 新任务产生时，旧任务的返回结果通过 jobId 机制自动丢弃，避免串流
- **中断机制** — 切换内容或重新生成时，使用 AbortController 立即终止进行中的请求
- **错误容错** — 单段失败不中断整体播放，保证能停止、能重试、不卡死

---

## 项目结构

```
ai-reader/
├── server.js              # Node.js 后端主文件（API + AI Rewrite + TTS 调度）
├── tts_edge.py            # Python Edge TTS 脚本（语音合成）
├── requirements.txt       # Python 依赖（edge-tts）
├── package.json           # Node.js 依赖配置
├── Dockerfile             # Docker 容器化配置
├── nodemon.json           # 开发热重载配置
├── .env                   # 环境变量（不提交 git）
├── cookies.txt            # YouTube 认证 cookies（不提交 git）
├── rewrite_cache.json     # AI Rewrite 结果缓存
├── tts_cache/             # TTS 音频文件缓存目录
├── uploads/               # 临时文件上传目录
└── public/
    ├── index.html         # 前端页面
    ├── style.css          # 样式
    ├── app.js             # 前端主逻辑（分段、Pipeline、播放控制）
    ├── audioEngine.js     # 音频引擎（IndexedDB 缓存 + TTS 请求）
    └── storage.js         # 本地状态存储（断点恢复）
```

---

## 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `OPENAI_API_KEY` | ✅ | OpenAI API Key，用于 AI Rewrite |
| `PORT` | ❌ | 服务端口，默认 `3000` |
| `PYTHON_PATH` | ❌ | Python 路径，默认自动检测 `.venv/bin/python` 或 `python3` |
| `YTDLP_PATH` | ❌ | yt-dlp 可执行文件路径，默认 `yt-dlp` |

---

## 安全注意事项

- **OpenAI API Key** 存储在服务器端，所有访问者共享费用，请勿公开传播服务地址
- **cookies.txt** 使用个人 Google 账号进行 YouTube 认证，每隔数周需刷新一次；建议仅分享给信任的用户
- 服务目前没有登录验证，生产环境建议配置 IP 白名单或基础鉴权
- 每次更新前端 JS / CSS 后，需同步修改 HTML 中的资源版本号（如 `app.js?v=20260310`），避免浏览器强缓存旧版本

---

## License

ISC
