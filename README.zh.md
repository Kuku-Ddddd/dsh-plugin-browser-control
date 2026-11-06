# dsh-plugin-browser-control

[English](README.md) | 中文

让 [DSH (DeepSeek-Harness)](https://github.com/deepseek-ai/deepseek-harness) 的 agent 操控**应用自带的内置浏览器**——右侧 Sidebar 的 `Browser` tab——而不是另起一个无头 Chromium。

DSH 随附的 `@deepseek-ai/dsh-client-ui-sidebar-browser` 只做呈现：它的 README 写明该 tab *不注册工具、不注册 prompt section、不注册 session event*。本插件补上缺的那一半：一个 `browser_control` agent 工具 + 页面侧执行器。

## 为什么不是 Playwright / 无头浏览器

| | 本插件 | 无头 Chromium |
|---|---|---|
| 用户看到什么 | 他本来就在看的那个 tab | 什么都看不到 |
| 登录态 | 复用真实浏览器会话 | 全新 profile，得重新登录 |
| 额外下载 | 无 | ~150 MB 浏览器 |
| 走用户的代理 | 会 | 通常不会 |

它是**可监督**的浏览器：每一步都发生在用户眼皮底下。

## 支持的 action

| action | 说明 |
|---|---|
| `open` | 打开 URL；有可见 tab 就复用，没有就新建 |
| `navigate` | 在当前 tab 导航 |
| `back` / `forward` / `reload` | 原生导航历史 |
| `read` | 标题 + 可见正文 + 链接（可限制截断长度） |
| `evaluate` | 在页内跑一段 async 函数体，返回 JSON |
| `click` | CSS 选择器 → 滚入视野 + 完整 pointer/mouse 事件链；跳转后回报新页面 |
| `fill` | 写入 `input`/`textarea`/`select`；走 native setter，React/Vue 受控组件也会更新 |
| `hover` | 触发 hover 事件链（展开悬浮菜单） |
| `press` | 派发 `KeyboardEvent`（默认 `Enter`）到指定选择器或当前焦点元素 |
| `screenshot` | `capturePage()` → PNG，经 attachment 通道落盘，模型直接可见 |
| `status` | 当前 tab 在显示什么 |
| `list` | 所有浏览器 tab 及其索引 |

多数 action 支持 `tab` 参数按索引指定 tab（先用 `list` 查），这在"下一页会打开新窗口"的站点上很关键。

## 工作原理

```
agent 工具调用
      │
      ▼
Host 插件（index.js）── 注册 ctx.tools + 两条 webServer 路由
      │  GET  /browser-control/next    页面 long-poll 领命令
      │  POST /browser-control/result  页面回传结果
      ▼
Client 插件（client.js）── 跑在应用渲染进程里
      │  按 [data-sidebar-browser-frame] 找到载体
      │  Desktop 是 <webview>，Web 是 <iframe>
      ▼
页面干活，返回纯 JSON
```

两条路由都由 `ctx.connection.requestRejection()` 把关，与官方 `dsh-host-open-in-app` 用的是同一道信任栅栏：只有应用自己的已认证 origin 能轮询或上报。

截图经 `attachments.saveImages()` 落盘，所以图片字节不会进入 transcript 的文本块。

## 安装

DSH Desktop 独占管理它的 profile，CLI 会拒绝（`profile "desktop" is managed exclusively by the Electron application`）。因此用 GUI 安装：

1. 侧边栏 → **插件**
2. **添加插件** → **安装第三方插件**
3. 填 npm 包名 `dsh-plugin-browser-control`，或本地 checkout 的绝对路径
4. 确认 `browser-control` 这一行处于存活状态（Host 行 + Client 行都在），然后重启应用

## 要求与边界

- **只有 Desktop 有完整能力。** Desktop 驱动 Electron `<webview>`，guest API 完整。Web profile 用的是跨域 sandbox `<iframe>`，正文读不回来，也没有 `capturePage()`。
- **需要活着的应用窗口。** 命令靠页面 long-poll 领取；没有页面连接就超时并说明原因。
- **截图要求 tab 可见。** 隐藏 guest 调 `capturePage()` 会拿到应用窗口或直接报错，所以插件会先把 tab 带到前台。请让 Browser tab 留在屏幕上。
- **站点可以拒绝嵌入。** `X-Frame-Options` / CSP 会挡住部分来源。下载、原生文件选择框、`alert()` 都被 Desktop 主进程拒绝。
- **不越权。** guest 以 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 运行。本插件只用渲染进程里的公开 `<webview>` API，不向主进程注入任何东西。
- **截图是视口截图。** webview 无法拼接整页滚动。
- **单窗口。** 每个 Host 进程一条 FIFO 队列，先轮询到的连接领走命令。
- **改 `client.js` 需要重启应用**——已安装的 bundle 没有文件监听。

## 开发

```
index.js        Host 半：工具定义、命令总线、HTTP 路由
client.js       Client 半：轮询路由、驱动载体
define-tool.js  vendor 版 defineTool（插件是 link 在宿主 node_modules 之外的，
                裸导入 @deepseek-ai/dsh-tools 解析不到；原因见该文件头注释）
cordis.patch.yml  插入 loader 行
```

无构建步骤、运行时零依赖——纯 ESM。

## 许可证

MIT
