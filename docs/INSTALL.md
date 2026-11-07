# 安装（接收方看这里）

这是一个 DSH **bundle 插件**：装上后左侧栏会多一个「中转站」入口，主面板显示你自己中转站账号的余额与用量。

- 不内置任何账号：每个人用自己的站点账号登录；
- 凭据只存在各自的浏览器里（勾「记住凭据」时）和 DSH 进程内存里；
- 支持 new-api / one-api 中转站，以及 DeepSeek 官方平台（余额/本月消费/本月 Token）。

## 前提

- 已安装 DSH（桌面版或 `dsh web`），并且能打开一个 profile（例如 `desktop`）；
- 有 Node.js（桌面版自带，命令行安装才需要）。

## 方式 A：`install_bundle`（推荐，管理器装）

拿到 `local-dsh-relay-usage-1.5.1.tgz` 后，在 DSH 里让它执行：

```
plugin_manager install_bundle  target = "D:\\path\\to\\local-dsh-relay-usage-1.5.1.tgz"
```

安装器会把它放进当前 profile 的 `node_modules`，并把 bundle 加进 `dsh.profile.bundles`。
返回 `application: applied` 即生效；返回 `restart-required` 就重启一次 DSH。

也可以解压成目录后指向目录：

```
plugin_manager install_bundle  target = "D:\\path\\to\\dsh-relay-usage"
```

## 方式 B：手工落盘（`install_bundle` 报 pnpm 缺失时）

某些安装包不带随附的 pnpm，`install_bundle` 会报
`Cannot find module ...pnpm.mjs`。这时用等价的三步（Windows 示例）：

```powershell
# 1. 把解压后的目录放到任意位置，例如 D:\dsh-relay-usage
# 2. 在 profile 的 node_modules 下建目录联接
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force "$profile\node_modules\@local" | Out-Null
cmd /c mklink /J "$profile\node_modules\@local\dsh-relay-usage" "D:\dsh-relay-usage"

# 3. 编辑 $profile\package.json：
#    dependencies 增加  "@desstg/dsh-relay-usage": "link:D:\\dsh-relay-usage"
#    dsh.profile.bundles 增加 "@desstg/dsh-relay-usage"
```

改完重启 DSH；或让插件管理器把这一行关掉再打开（`plugin_manager set_plugin`），可热加载。

## 验收

1. 左侧栏出现「中转站」，点开应看到登录卡；
2. 填站点地址 + 账号密码（new-api）→ 看到余额/今日消耗/近 7 日趋势/模型用量；
3. DSH 重启后仍自动登录（勾了「记住凭据」的前提下）；
4. 设置里语言切到 English，面板文案应跟着变。

## 卸载

1. 从 `dsh.profile.bundles` 与 `dependencies` 移除 `@desstg/dsh-relay-usage`；
2. 删除 `node_modules\@local\dsh-relay-usage` 联接；
3. 重启 DSH。

浏览器里残留的站点与凭据：DevTools → Application → Local Storage 删除 `dsh.relay-usage.*` 开头的键。

## 两个站的差异

| 站点类型 | 登录方式 | 能拿到什么 |
| --- | --- | --- |
| new-api / one-api（如 api.hohai.eu.org） | 账号 + 密码 | 余额、累计已用、今日消耗/请求/Token、近 7 日趋势、模型用量、最近消费 |
| DeepSeek 官方（platform.deepseek.com） | 平台令牌（手机号+验证码登录后从浏览器复制），或账号密码（若设过） | 余额、本月消费、本月 Token、本月请求、按天/按模型汇总 |

官方站取令牌：登录 platform.deepseek.com → F12 → Network → 任一 `/api/v0` 请求 → 复制请求头 `Authorization: Bearer` 后面那串。
