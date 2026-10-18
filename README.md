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

仓库：**https://github.com/Animal2404/github-update-watch**（公开仓库，CI 分钟数不限）

**下载安装包**不用进 Actions，直接在 Releases 页面拿：
<https://github.com/Animal2404/github-update-watch/releases/latest>

| 流水线 | 干什么 | 产出 |
| --- | --- | --- |
| `verify-web` | 纯逻辑单测（18 组）→ 起本机服务 → 无头 Chrome 真点每个按钮（26 项）+ 直连模式（9 项，含系统通知断言） | 截图与报告 artifact |
| `build-android` | Gradle 编译 debug/release APK → **校验 APK 里确实打进了网页资源** → 起安卓模拟器装上、启动、截图、查崩溃 | `android-apk` artifact |
| `build-desktop` | Windows 上 electron-builder 打包；另起 Linux job 用 xvfb 真跑一遍 Electron 壳 | `desktop-windows` artifact（安装包 + 免安装版） |

下载产物：仓库页面 → Actions → 选一次成功的运行 → 页面底部 Artifacts；
或命令行 `gh run download -n android-apk`。

CI 里踩过并修掉的坑（都写在 workflow 注释里）：Node 需要 22+（全局 `WebSocket`）、
`android-actions/setup-android` 会去装已废弃的 `tools` 包（镜像自带 SDK，别用）、
Gradle 任务不能往 sourceSets 源码目录写（会触发任务依赖校验）、
`android-emulator-runner` 的 `script` 是逐行执行的（多行 `if/fi` 会被拆断，逻辑要放进脚本文件）、
CI 上 Electron 要加 `--no-sandbox`。

**打包后 EXE 一启动就死**（最贵的一个坑，值得单独说）：

```js
await import(path.join(DIR, '..', 'server.mjs'))   // ❌ Windows 上传入 "C:\...\server.mjs"
```

Node 的 ESM 加载器把这个字符串当成 URL，读到协议 `c:` 直接抛
`ERR_UNSUPPORTED_ESM_URL_SCHEME`；而打包后的 Electron 是 GUI 子系统程序，**没有 stderr**，
进程秒退、事件日志里也没有任何记录，表现就是"双击没反应"。Linux 上路径以 `/` 开头恰好能跑，
所以"云端跑 Linux 冒烟绿了、Windows 用户拿到的 exe 是坏的"。修法两条一起上：

1. `await import(pathToFileURL(绝对路径).href)`；
2. `electron-builder` 里 `"asar": false` —— Node 的 ESM 加载器同样不认 asar 归档里的模块。

现在发布流水线里有两道真跑验证：Linux job 跑**打包后的可执行文件**（xvfb），
Windows job 跑**免安装版 exe**；任一不过就 `needs` 拦住发布，Release 不会出现坏包。
CI 里 Windows 上没法直接跑 `win-unpacked` 之外的东西时，还可以用诊断 artifact 里的
`smoke-win.json` 看它到底走到哪一步。

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
| 卡片 | 标记已读 | **只在这一张卡真有新版本时出现**；把当前最新版本记为新基线（无更新时按钮根本不在 DOM 里，不占位置） |
| 卡片 | 版本号（最新版本） | 点它直接打开这一版的 Release 页；tag 兜底时打开 `/tree/<tag>` |
| 卡片 | ⋯ | 更多操作：打开最新 Release / 在浏览器打开仓库 / **重置基线** / 删除项目 |
| ⋯ 菜单 | 重置基线 | 清掉基线，下次检查重新记录（等价于"我换了个项目，重新开始盯"） |
| ⋯ 菜单 | 删除项目 | 弹确认框；取消不删，确认才移除 |

> 旧版卡片上并排 6 个按钮（检查/版本历史/标记已读/Release/↗/🗑），在 340px 的卡片里必然折行。
> 现在一行只放主操作，低频与危险操作收进 `⋯`，菜单支持方向键 / Home / End / Esc。

## 「有没有更新」是怎么判定的

- 添加项目时，把**当前最新版本**记为该项目的**基线**（baseline）。
- 每次检查重新拉最新版本，与基线做完整 semver 比较（含 `alpha`/`rc` 预发布排序：
  `0.2.0 > 0.2.0-rc.2 > 0.1.6`）。
- 最新 > 基线 → 徽章变「有新版本」，版本行显示 `基线 → 新版本`；否则显示「已是最新」。
- 你看过之后点「标记已读」，基线推进到最新版本，徽章回到「已是最新」。

- 数据来源优先 `releases`（含预发布，按 semver 取最大），取不到时退到 `tags`；
  tag 兜底说明这个仓库没有正式 Release，卡片上会标一个 `tag 兜底`，链接改指 `/tree/<tag>`（有内容，不会 404）。
- 取数默认只读第一页（30 条）；**只有**「第一页满载 + 已有基线 + 这一页最大值仍没超过基线」时才继续翻页，
  最多 3 页。因为分页按 `created_at` 排：仓库先发 3.0、之后连发 30 个 2.x 热修时，3.0 会掉出第一页，
  旧逻辑会误判"已是最新"。首次记录基线时永远只取一页（省额度）。
- 只保存版本相关的字段，不再把 release 正文（截断 4KB）塞进 `repos.json`——以前每次检查都在写没人读的文本。

## 数据 / 备份 / Token 加密

- 项目列表、基线、上次检查时间都写在 **`data/repos.json`**（原子写入，不会写一半坏掉）。
- **Token 落盘是密文**（AES-256-GCM，格式 `enc:v1:…`）：密钥在 `data/.token-key`（0600），
  与数据分文件存放。目的是「repos.json 被单独备份/同步/误上传时不泄露 Token」。
- 想备份：复制整个 `data/` 目录（含 `.token-key` 才能解回 Token）；只拷 `repos.json` 到新机器上，
  Token 会解不开并按「未设置」处理（列表与基线不受影响）。想重置：删掉目录，下次启动重新播示例项目。
- 旧版本（1.0.x）写在 `repos.json` 里的明文 Token，会在**启动时自动迁移**成密文。
- **这不是系统钥匙串**：密钥与密文同目录，同用户权限下的进程仍能同时读到。要抗"同账号恶意软件"
  得用 DPAPI/Keychain，那会引入平台依赖，与本项目"零外部依赖"冲突。
- 安卓 APK 没有服务端，Token 在 WebView 的 localStorage 里（浏览器侧没有等价的可信密钥），
  只受系统沙箱保护。

## 限流（会真的遇到）

GitHub 未认证的 API 额度是 **60 次/小时/IP**，界面右上角有实时余量。

- 平常一个项目的检查约消耗 1 次（仓库元数据 24 小时内复用，不再重复拉）；
- 添加上限、频繁点「全部检查」会快速吃掉额度；撞到限流时卡片会按**有没有 Token** 给不同文案：
  未认证是「60 次/小时已用尽，填 Token 可到 5000」，已填 Token 则是「Token 额度已用尽，检查 Token 是否失效」，
  不会把带 Token 的用户误报成未认证。
- 设置里填 Token → 保存，会立刻清空本地缓存并按新额度重新计算。

## 设计说明（三个 UI 技能各自的落点）

### 2026-10 这一轮（1.1.0）改了什么

- **卡片只留给项目本身**：添加区和工具栏原来是两张 `card.panel`，现在是同一条连续控制区，
  用留白和一条分隔线分组——不再"卡片套卡片"。
- **动作收成一行**：`检查 / 版本历史 / 标记已读（仅在有更新时）` 在左，`⋯` 在右；
  打开 Release、打开仓库、重置基线、删除都进菜单。菜单支持方向键、Home/End、Esc 关闭并还焦。
- **版本号即入口**：最新版本号本身就是链接（点开就是那一版），不再额外占一个 Release 按钮的位置。
- **动效分三档**：`120ms` hover/press、`200ms` 状态切换、`320ms` 浮层，统一 `ease-out`，
  并保留 `prefers-reduced-motion` 降级。
- **文字色单独建令牌**：`--accent-text` / `--destructive-text`。原因是 `#22C55E` 当文字放在浅色底上只有
  2.0:1、`#EF4444` 当小字放在深色卡片上只有 4.16:1——填充色好看不等于文字可读。亮色改用
  `#166534`（绿底上 6.26:1）与 `#B91C1C`（红底上 5.37:1），两套主题全部过 WCAG AA。
- **所有来自网络的字符串先过 `esc()`** 再拼进 `innerHTML`（Release 标题、tag、错误信息），
  因为 tag 与 Release 标题是第三方可控内容。


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
├── test/
│   └── core.test.mjs          纯逻辑单测（node --test，不需要浏览器/网络）
├── tools/
│   ├── build-icons.mjs        图标构建 + 自检
│   ├── verify-ui.mjs          逐按钮自动化验证（无头 Chrome + CDP）
│   ├── verify-direct.mjs      直连模式验证（APK 走的那条路）
│   └── shots.mjs              只截图不跑断言（省额度，看状态用）
└── data/
    ├── repos.json             你的项目列表与基线（自动生成）
    └── shots/                 验证时产生的截图
```

## 自测

```bash
npm test                                  # 纯逻辑：semver / 链接解析 / 转义 / 翻页 / 加密 / 基线状态机（18 组）
node server.mjs                           # 另开一个窗口
node tools/verify-ui.mjs http://127.0.0.1:7321/   # 26 项真点按钮
node tools/verify-direct.mjs              # 直连模式 9 项（含系统通知断言）
```

单测是这一轮补的：`cmpVer` / `parseRepoInput` / `esc` / `fetchLatest` 的降级决策 / 基线状态机
全是不需要浏览器的纯函数，以前只有 E2E，回归一次只能靠人肉发现。

## 为什么网络层要写三层退让

本机实测过一个坑：系统设了 `HTTP(S)_PROXY=127.0.0.1:7890` 但代理没开时，Node 的 `fetch`
直接 `ECONNREFUSED`，而 `curl` 走直连却是通的。所以服务的取数按
`fetch → curl --noproxy *（强制直连）→ curl（走系统代理）` 依次退让，
当前用的是哪条会显示在设置对话框里。curl 走的是异步 `spawn`：以前用 `spawnSync` 会按住 Node 单线程，
离线时最长 35 秒内所有 `/api/*` 都停摆，界面上看起来就是"整个应用卡死"。

## 安全上的三个落点

| 面 | 措施 | 覆盖不到的 |
| --- | --- | --- |
| 第三方内容进 DOM | 所有 tag / Release 标题 / 错误信息先过 `esc()` | — |
| 本机服务被网页跨站调用 | 校验 `Host` 头（只放行 127.0.0.1 / localhost / ::1），挡 DNS rebinding | 同用户下的本地进程 |
| Token 静止数据 | AES-256-GCM 加密落盘，密钥 0600 分文件 | 同账号恶意进程、APK 的 localStorage |

## 已知限制

- 只认 GitHub（不支持 GitLab/自建 Gitea）。
- 版本比较按 semver；对不用 semver 的 tag（如纯日期 `2026.10.05`）只能做同类比较，可能漏判。
- 需要 DSH 的 Node 或系统 Node ≥ 18（服务端用了内置 `fetch`；验证脚本要 22+，因为用了全局 `WebSocket`）。
- 服务只监听 `127.0.0.1`，不对外网开放。
- Token 加密只保护"文件被单独带走"这一种场景，不是系统钥匙串。
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
