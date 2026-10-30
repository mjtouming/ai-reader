# 灵听 iOS 最小外壳

这是加载线上灵听的 Capacitor / WKWebView 外壳，不复制、不修改 `public/`、服务端、现有测试或网页资源版本号。Bundle ID 为 `top.solonova.sona`，桌面名称为「灵听」。网页更新仍在原来的服务器进行，外壳不需要因网页更新重新打包。

所有依赖安装、原生工程生成、Xcode 编译及 IPA 打包只在 GitHub Actions 的 macOS 云端机器执行。本地 Mac 不需要安装 Xcode，也不要在本地运行 `npm install` 或 `npx cap add ios`。仓库不保存 `node_modules/`、生成的 `ios/` 或签名材料。

## 实现与关键选择

- `package.json` 使用 Capacitor **8 稳定大版本**，三个包均为 `^8.0.0`，CI 安装该大版本内可用的新稳定版本，不跟随将来的大版本或预发布版本。此初始方案没有离线伪造 lockfile；每次实际解析的版本记录在 Actions 的 `npm ls` 日志中，同一提交以后重跑可能解析到更新的小版本。
- Capacitor 8 要求 **Node 22+、Xcode 26+、iOS 15+**。workflow 使用 Node 22 和 `macos-15`，从镜像已有的 Xcode 中选择最新正式版 26+；缺失时明确失败，不退回不兼容的版本。
- `capacitor.config.json` 中 `server.url` 固定为 `https://sona.solonova.top`；`webDir: "www"` 相对于 `ios-app/`，即仓库的 `ios-app/www/`。`server.errorPath: "index.html"` 在线上页面加载失败时显示本地网络提示并提供重试入口，不实现离线听书，也不覆盖正常加载的线上页面。服务不可用或证书错误也可能触发此提示。
- Capacitor 8 原生 WKWebView 已默认设置 `allowsInlineMediaPlayback = true` 和 `mediaTypesRequiringUserActionForPlayback = []`。这些不是其公开 JSON 配置开关，因此不添加无效配置，也不修改 Capacitor 依赖源码。
- 在最后一次 `cap sync ios` **之后**运行 `scripts/patch-ios.py`：用 `/usr/libexec/PlistBuddy` 设置 `UIBackgroundModes = [audio]` 和 `CFBundleDisplayName = 灵听`；仅在生成的 `AppDelegate.swift` 中插入 `AVFoundation` 导入，以及启动时的 `.playback` category / `setActive(true)`。保留模板原有的生命周期和 URL 处理；不添加插件，不替换整个 AppDelegate。补丁可重复执行，找不到唯一启动方法或检测到残缺补丁就停止构建，不会静默漏配。音频会话运行时失败会写入系统日志。
- 已找到 `public/icon-app.png`：512×512、无透明通道。CI 用系统自带 `sips` 放大为 1024×1024 PNG，并写入现代 Xcode 单图标 asset catalog；这不会增加原图细节。不改源图、不引入图标依赖。若此文件不存在，依次尝试 `apple-touch-icon.png`、`icon.png`，透明图先移除 alpha；全部缺失时保留默认图标，并在 CI 发出 warning。
- Capacitor 8 默认生成 SPM 工程，使用 `-project App.xcodeproj -scheme App`；workflow 若发现 `App.xcworkspace` 则优先使用 CocoaPods workspace。`cap add` / `cap sync` 负责对应依赖同步。
- `xcodebuild` 构建设备版 `Release`，明确禁用代码签名，不使用需要签名的导出流程。构建后检查 arm64、Bundle ID、后台模式、名称、设备平台及未签名状态，再把 `App.app` 置于 `Payload/` 中压成 `Sona-unsigned.ipa`。CI 不需要 Apple ID、证书、provisioning profile 或签名 secrets。

## 触发构建与下载

1. 将本次新增文件和 `.gitignore` 变更提交并推送到 `feat/ios-shell` 或 `main`。只有 `ios-app/**` 或 `.github/workflows/ios-ipa.yml` 发生变化的 push 才触发构建；单改 `.gitignore` 不触发。
2. 也可以在 GitHub 仓库的 **Actions → Build Sona unsigned IPA → Run workflow** 手动选择分支并运行。GitHub 的手动入口通常要求 workflow 已存在于默认分支；首次只推特性分支时先依靠 push 触发。如果 Actions 被禁用，先在仓库设置中启用。
3. 等待所有步骤成功。打开该次运行底部的 **Artifacts → Sona-unsigned**，下载并解压 GitHub 的 artifact ZIP，取出其中的 **`Sona-unsigned.ipa`**。不要把外层 artifact ZIP 当作 IPA；也不要再解压 IPA 后拿文件夹安装。
4. artifact 保留 14 天，过期后重新触发构建。macOS runner 的用量受 GitHub 账号/仓库 Actions 额度与计费设置约束。

## 在 Mac 上用 Sideloadly 安装

1. 安装并打开 Sideloadly，用数据线连接 iPhone、解锁并信任这台 Mac，确认 Sideloadly 已选中目标 iPhone。按其提示完成必要的首次设置。
2. 将 **`Sona-unsigned.ipa`** 拖入 Sideloadly，输入自己的 Apple ID，点击 **Start**。由 Sideloadly 在本机完成签名与安装；按提示输入认证信息/双重认证，不要把 Apple ID 或密码配置进 GitHub Actions。
3. iPhone 如提示开发者模式未开启，进入 **设置 → 隐私与安全性 → 开发者模式** 开启，重启并确认。部分设备需首次侧载尝试后才出现此入口。
4. 在 **设置 → 通用 → VPN 与设备管理** 中找到对应开发者条目并信任证书，再打开「灵听」。系统版本不同，入口名称可能略有变化。
5. **免费 Apple ID 签名通常 7 天到期，需要重签并重新安装**。到期前用同一 Apple ID、同一 Bundle ID 重签，通常可以覆盖更新并保留数据，但不要先卸载；请自行备份重要内容，不能保证所有签名/系统变更下的数据保留。免费账号的应用数量限制仍然适用。

此 IPA 尚未签名，不能直接在 iPhone 上点开安装，也不能用于 App Store / TestFlight。Sideloadly 安装流程不要求本地 Xcode；免费账号有效期和设备授权由 Apple 控制。

## 后台播放的边界与验收

这里启用的是 iOS 后台音频能力和播放音频会话，**不是将现有网页播放器迁移到原生音频引擎**。网页仍使用现有音频、JavaScript、网络和预生成逻辑。WKWebView 在后台的 JavaScript 调度、网络请求、分段之间的空档、系统回收以及来电中断，都可能影响跨段连续播放；仅设置 plist 和 AVAudioSession 不能据此承诺所有锁屏场景稳定。

CI 能验证依赖安装、真实模板补丁、Swift 编译、设备构建和 IPA 结构；不能证明 iPhone 上的后台行为。首次自签安装后按顺序验收：

1. 在线启动能显示灵听，原有生成和播放正常；断网冷启动显示本地「请检查网络」，恢复网络后点「重新连接」可以回到线上页面。
2. 已开始播放后锁屏、切换其他 App，当前段不中断；持续听到至少两个分段边界，分别覆盖下一段已预生成、下一段仍需网络生成的情况。若后者失败，就不能把此外壳宣称为已解决持续后台听书。
3. 暂停/继续、锁屏控制、来电或其他音频中断后的恢复，以及再次回到前台都要实测。原有锁屏标题/封面继续依赖网页的 Media Session 行为。
4. 桌面名称、AppIcon 正确，免费签名到期前可用 Sideloadly 再次重签安装。

当前只做文件与静态验证；没有在本地构建原生工程，没有运行 Actions，也没有完成真机后台播放验收。

技术依据：Capacitor 官方的 [8.0 升级说明](https://capacitorjs.com/docs/updating/8-0)、[配置定义](https://github.com/ionic-team/capacitor/blob/8.0.0/cli/src/declarations.ts) 与 [WKWebView 默认设置](https://github.com/ionic-team/capacitor/blob/8.0.0/ios/Capacitor/Capacitor/CAPBridgeViewController.swift)。
