# GitHub 更新监测

一个跑在本机的小软件：把你在意的 GitHub 项目加进列表，它会记下「当前最新版本」作为基线，
之后每次检查都告诉你**有没有发新版本**。零外部依赖，不需要联网安装任何包。

## 快速开始

**双击 `start.cmd`** 就行。它会：

1. 启动本地服务（那个黑窗口就是服务，**关掉窗口 = 停止服务**）；
2. 等服务端口就绪；
3. 用 Chrome/Edge 的「应用模式」开一个没有地址栏的独立窗口（像个桌面小软件）。

也可以手动跑：

```powershell
node server.mjs          # 或 start.cmd 里那个 DSH 自带的 node
# 然后浏览器打开 http://127.0.0.1:7321/
```

首次运行会自动加入 3 个示例项目（deepseek-harness / vscode / react）方便你立刻看到效果，
在卡片上点删除即可移除。

环境变量（可选）：`set PORT=7400` 换端口；`set GUW_NO_BROWSER=1` 只起服务、不开窗口。

> ⚠️ `start.cmd` 里**不能写中文**：cmd.exe 按 OEM 码页（简中 Windows 是 GBK）解析批处理，
> UTF-8 的中文会被从中间截断，命令直接乱掉（实测踩过）。所以启动器是全英文的，
> 中文界面都在网页里。

## 三端：网页 / Windows 桌面 / 安卓 APK

三端**不是三份实现**，而是同一套代码的三种壳：

```
public/github-core.js   ← 版本比较、链接解析、GitHub 取数、基线状态机（两端共用这一份）
        ├── server.mjs        Node 侧：curl 代理退让链 + 文件存储
        │      ├── 网页/本机服务模式（浏览器走 /api/*）
        │      └── electron/main.mjs   桌面壳：起同一个 server，包进原生窗口
        └── public/app.js     直连模式：浏览器直接请求 api.github.com，数据存 localStorage
               └── android/    APK：WebView + WebViewAssetLoader 加载同一份 public/
```

| | 网页 | Windows 桌面 | 安卓 APK |
| --- | --- | --- | --- |
| 界面 | `public/` | 同一份 `public/` | 同一份 `public/` |
| 检测逻辑 | `github-core.js` | 同一份 | 同一份 |
| 数据存哪 | `<仓库>/data/repos.json` | `%APPDATA%/GitHub Update Watch/` | WebView 的 localStorage |
| 取数方式 | 本机服务（curl 退让链） | 同左（内嵌服务） | 浏览器直连 api.github.com |
| Token | 同上，存在本地文件 | 同左 | 存在 App 的 localStorage |

手机版没有服务端，所以用「直连模式」：GitHub 的 REST API 带 `Access-Control-Allow-Origin: *`，
WebView 可以直接请求（已在 CI 里实测通过）；列表与基线存 localStorage，卸载才丢。

**新版本系统通知**三端都有，但走的路不同：网页/桌面用浏览器 Notification API，
安卓 WebView **不支持** Web 通知，所以由 `MainActivity` 注入的 `AndroidNotify` 桥走原生通知
（含 Android 13+ 的运行时授权与通知渠道）。设置里可开关，偏好存在本机。

## 云编译（不占本机，全部在 GitHub Actions 跑）

仓库：**https://github.com/Animal2404/github-update-watch**（私有仓库；想省 CI 分钟数可改成公开）

| 流水线 | 干什么 | 产出 |
| --- | --- | --- |
| `verify-web` | 起本机服务 → 无头 Chrome 真点每个按钮（22 项）+ 直连模式（9 项，含系统通知断言） | 截图与报告 artifact |
| `build-android` | Gradle 编译 debug/release APK → **校验 APK 里确实打进了网页资源** → 起安卓模拟器装上、启动、截图、查崩溃 | `android-apk` artifact |
| `build-desktop` | Windows 上 electron-builder 打包；另起 Linux job 用 xvfb 真跑一遍 Electron 壳 | `desktop-windows` artifact（安装包 + 免安装版） |

下载产物：仓库页面 → Actions → 选一次成功的运行 → 页面底部 Artifacts；
或命令行 `gh run download -n android-apk`。

CI 里踩过并修掉的坑（都写在 workflow 注释里）：Node 需要 22+（全局 `WebSocket`）、
`android-actions/setup-android` 会去装已废弃的 `tools` 包（镜像自带 SDK，别用）、
Gradle 任务不能往 sourceSets 源码目录写（会触发任务依赖校验）、
`android-emulator-runner` 的 `script` 是逐行执行的（多行 `if/fi` 会被拆断，逻辑要放进脚本文件）、
CI 上 Electron 要加 `--no-sandbox`。

## 界面上的每个按钮

| 位置 | 控件 | 行为 |
| --- | --- | --- |
| 顶栏 | 搜索框 | 按 owner/repo 或简介实时过滤 |
| 顶栏 | ☾/☀ 主题 | 深色 ⇄ 浅色，选择记在 localStorage；图标带 morph 变形 |
| 顶栏 | ⚙ 设置 | 打开设置对话框（GitHub Token + **通知开关**），Esc / 点遮罩 / 关闭按钮都能退 |
| 添加项目 | 输入框 + 添加 | 支持完整链接、`owner/repo`、`git@github.com:owner/repo.git`；空输入会内联报错；重复添加会提示「已经在列表里」 |
| 监测列表 | 全部检查 | 逐个项目真去问 GitHub（带进度、并发 3、按钮进入忙碌态），完成后汇总 |
| 监测列表 | 全部/有更新/无更新/有问题 | 按状态过滤，带实时计数 |
| 卡片 | 检查 | 单独检查该项目（强制绕过缓存，真的去问 GitHub） |
| 卡片 | 版本历史 | 展开最近 10 个 Release（懒加载，再点收起） |
| 卡片 | 标记已读 | 把当前最新版本记为新基线（**只在你确认过之后才点**；无更新时按钮自动禁用） |
| 卡片 | Release | 直接打开最新版本的 Release 页 |
| 卡片 | ↗ | 在浏览器打开仓库主页 |
| 卡片 | 🗑 删除 | 弹确认框；取消不删，确认才移除 |

## 「有没有更新」是怎么判定的

- 添加项目时，把**当前最新版本**记为该项目的**基线**（baseline）。
- 每次检查重新拉最新版本，与基线做完整 semver 比较（含 `alpha`/`rc` 预发布排序：
  `0.2.0 > 0.2.0-rc.2 > 0.1.6`）。
- 最新 > 基线 → 徽章变「有新版本」，版本行显示 `基线 → 新版本`；否则显示「已是最新」。
- 你看过之后点「标记已读」，基线推进到最新版本，徽章回到「已是最新」。

数据来源优先 `releases`（含预发布，按 semver 取最大），取不到时退到 `tags`。

## 数据 / 备份

- 项目列表、基线、Token、上次检查时间都写在 **`data/repos.json`**（原子写入，不会写一半坏掉）。
- 想备份：复制这个文件。想重置：删掉它，下次启动会重新播示例项目。
- Token 只存在这个本地文件里，只用于请求 `api.github.com`。

## 限流（会真的遇到）

GitHub 未认证的 API 额度是 **60 次/小时/IP**，界面右上角有实时余量。

- 平常一个项目的检查约消耗 1 次（仓库元数据 24 小时内复用，不再重复拉）；
- 添加上限、频繁点「全部检查」会快速吃掉额度；撞到限流时卡片会显示
  「GitHub 未认证限流（60 次/小时）已用尽」，此时填入 Token 即可（5000 次/小时）。
- 设置里填 Token → 保存，会立刻清空本地缓存并按新额度重新计算。

## 设计说明（三个 UI 技能各自的落点）

- **ui-ux-pro-max**：先用 `search.py --design-system` 生成设计系统（Dark Mode / OLED、
  CTA run-green `#22C55E`、JetBrains Mono + IBM Plex Sans、Stagger List 动效），
  再补检索了「loading skeleton / error retry」「card list responsive grid」两组规则，
  落到实现里就是：骨架屏、错误可就地恢复、`role=alert` 的报错、统一 gap 的卡片网格。
- **ui-styling**：组件令牌沿用 shadcn/ui 的语义变量命名（`--background / --card / --primary /
  --muted / --border / --ring / --radius`），暗亮两套值；按钮/输入/徽章/对话框/chip 都按
  shadcn 的变体体系写，键盘焦点用 `:focus-visible` 环，图标按钮都带 `aria-label`。
- **ui-morphicons**：图标不是 crossfade，而是**真的形状变形**——主题 `sun↔moon`、
  检查 `refresh-cw↔loader-circle↔circle-check`、版本历史 `chevron-down↔chevron-up`、
  添加 `plus↔check`。图标用 `lucide-static` 在构建期转成 IconNode 数据
  （`tools/build-icons.mjs`），并用 morphicons 自己的解析器逐个自检，解析不了就构建失败。

## 目录结构

```
github-watch/
├── start.cmd                  双击启动（服务 + 独立窗口）
├── server.mjs                 零依赖后端：静态托管 + GitHub API + 持久化
├── public/
│   ├── index.html             语义化结构 + 无障碍属性
│   ├── styles.css             设计令牌与组件样式（暗/亮）
│   ├── app.js                 全部交互逻辑
│   └── vendor/
│       ├── icons.js           构建期生成的图标数据（35 个，已自检）
│       └── morphicons/        morphicons 运行时（本地化，不依赖 CDN）
├── tools/
│   ├── build-icons.mjs        图标构建 + 自检
│   ├── verify-ui.mjs          逐按钮自动化验证（无头 Chrome + CDP）
│   └── shots.mjs              只截图不跑断言（省额度，看状态用）
└── data/
    ├── repos.json             你的项目列表与基线（自动生成）
    └── shots/                 验证时产生的截图
```

## 为什么网络层要写三层退让

本机实测过一个坑：系统设了 `HTTP(S)_PROXY=127.0.0.1:7890` 但代理没开时，Node 的 `fetch`
直接 `ECONNREFUSED`，而 `curl` 走直连却是通的。所以服务的取数按
`fetch → curl --noproxy *（强制直连）→ curl（走系统代理）` 依次退让，
当前用的是哪条会显示在设置对话框里。

## 已知限制

- 只认 GitHub（不支持 GitLab/自建 Gitea）。
- 版本比较按 semver；对不用 semver 的 tag（如纯日期 `2026.10.05`）只能做同类比较，可能漏判。
- 需要 DSH 的 Node 或系统 Node ≥ 18（服务端用了内置 `fetch`；验证脚本要 22+，因为用了全局 `WebSocket`）。
- 服务只监听 `127.0.0.1`，不对外网开放。
- 手机版与电脑版**功能一致但数据不互通**：APK 的数据在本机 localStorage 里，
  没有做跨设备同步（要做的话得加个后端或走 GitHub Gist 之类）。
- APK 用的是 debug 签名（方便直接装来体验）；要正式发布请换成自己的 keystore。

## 重新生成图标（一般不需要）

`public/vendor/` 里的 morphicons 与 `public/vendor/icons.js` 都已经提交在项目里，日常不用重建。
真要重建：

```bash
npm pack lucide-static@1.52.0 && tar -xzf lucide-static-1.52.0.tgz -C <某个临时目录>
node tools/build-icons.mjs <临时目录>/package/icons public/vendor/icons.js public/vendor/morphicons
```

构建脚本会用 morphicons 自己的解析器逐个校验图标，解析不了直接失败——避免上线才发现图标飞出去。
