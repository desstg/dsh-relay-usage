# 中转站用量（DSH 插件）

Dsh 插件：在左侧栏增加一个「中转站」入口，主面板显示你自己中转站账号的余额与用量。

- 包名：`@desstg/dsh-relay-usage`
- 仓库：https://github.com/desstg/dsh-relay-usage
- 面板入口：`sidebar.panellist`，id `relay`，顺序 `-10`（排在「插件」之前）
- 面板本体：`main` 键控槽位，key `relay`
- 配色：只使用 `--dsw-alias-*` 主题令牌，深色 / 浅色自动跟随
- 兼容：new-api / one-api 系（本机验证站点为 `v1.0.0-rc.48`）

## 一键安装（给使用者）

**Windows**：下载仓库后双击 `install.cmd`，或者：

```powershell
.\install.ps1                      # 自动探测 profile，装最新版
.\install.ps1 -Proxy http://192.168.31.9:7893   # github.com 不通时走代理
.\install.ps1 -Tgz .\desstg-dsh-relay-usage-1.6.0.tgz  # 离线包
.\install.ps1 -Uninstall           # 卸载
```

**macOS / Linux**：

```bash
./install.sh
./install.sh --proxy http://127.0.0.1:7890
./install.sh --uninstall
```

脚本会自动：找到 DSH profile → 下载对应 release → 解到
`%LOCALAPPDATA%\dsh-plugins`（Windows）或 `~/.local/share/dsh-plugins`（Unix）→
在 profile 的 `node_modules` 建目录联接/符号链接 → 往 profile 的 `package.json`
写入 `dependencies` 与 `dsh.profile.bundles`（改前备份）。**不需要 pnpm**。

装完重启 DSH（或让插件管理器把 `relay-usage` 这行关掉再打开），左侧栏出现「中转站」。

## 安装（DSH 内）

**从 GitHub 装：**

```
plugin_manager install_bundle  target = "github:desstg/dsh-relay-usage"
```

或从 Release 里下载 `desstg-dsh-relay-usage-<version>.tgz`：

```
plugin_manager install_bundle  target = "D:\\path\\to\\desstg-dsh-relay-usage-1.6.0.tgz"
```

`install_bundle` 报 `Cannot find module ...pnpm.mjs` 时（部分安装不带随附 pnpm），
用上面的「一键安装」脚本，或按 [docs/INSTALL.md](docs/INSTALL.md) 手工建联接。


## 功能

| 能力 | 说明 |
| --- | --- |
| 用户自己登入 | 面板内输入站点地址、用户名、密码；不内置任何账号 |
| 多人使用 | 每个浏览器各自保存自己的站点列表与会话，互不干扰 |
| 多个中转站 | 可添加任意多个站点，胶囊标签切换，逐个独立登录 |
| 令牌登录 | 站点关闭密码登录时，可用访问令牌（新版 `nap_…` / 旧版 `sk-…`） |
| 数据 | 余额、累计已用、今日消耗、今日请求、今日 Token、近 7 日趋势（金额/Token 切换）、模型用量、最近消费 |
| 官方站 | DeepSeek 官方平台：余额、本月消费、本月 Token、本月请求、按天/按模型汇总 |
| 刷新 | 手动刷新 + 面板打开时每 60 秒自动刷新 |

## 开发

```bash
node .test/run.mjs      # Host 半：mock new-api + 官方平台，30 条断言
node .test/render.mjs   # 组件渲染（stub hooks），3 条
node .test/locale.mjs   # 语言判定与槽位注册，6 条
node .test/migrate.mjs  # localStorage 迁移，4 条
node .test/outline.mjs  # 打印三种界面状态的结构树，人工核对版面
npm pack                # 产出 tgz
```

推 `v*` 标签会触发 `.github/workflows/release.yml`：语法检查 → 四个自测 → 打包 → 上传 Release 附件。


## 结构

```
package.json        插件清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml    loader patch：插入 relay-usage 行
index.js            Host 半：/relay-usage/api 同源代理（绕开中转站 CORS）
client.js           Client 半：侧栏入口 + 主面板 React 视图
locale/zh.json      插件标题与描述（中文）
locale/en.json      插件标题与描述（英文）
icon.svg            插件图标
```

## 支持两类站点

| 类型 | 识别方式 | 能拿到什么 |
| --- | --- | --- |
| new-api / one-api 中转站 | 其它域名 | 余额、累计已用、今日消耗、近 7 日趋势、模型用量、最近消费 |
| DeepSeek 官方（platform.deepseek.com / api.deepseek.com） | 域名属于 `deepseek.com` | 余额、本月消费、本月 Token。平台账号密码可直接登录；也可粘贴平台令牌或 `sk-` API Key |

官方站用法：站点地址填 `https://platform.deepseek.com`，直接填平台账号（邮箱/手机号）+ 密码即可，和网站上登录一样。若不想存密码，可切「使用访问令牌登录」粘贴平台令牌。

官方接口（平台私有，`Authorization: Bearer <token>`）：

```
POST /auth-api/v0/users/login            账号密码换令牌
GET  /auth-api/v0/users/current          当前用户（邮箱、币种）
GET  /api/v0/users/get_user_summary      余额 / 累计消费
GET  /api/v0/usage/amount?month=&year=   本月 Token
GET  /api/v0/usage/cost?month=&year=     本月消费
```

## 鉴权（三种，按站点版本自动选择）| 模式 | 适用 | 凭证 |
| --- | --- | --- |
| `jwt` | new-api ≥ v1.0.0-rc.x（如 `v1.0.0-rc.48`） | 登录返回 `data.access_token`（15 分钟 JWT），用 `Authorization: Bearer` 发送；到期前用 HttpOnly 的 `new_api_refresh` Cookie 调 `POST /api/user/auth/refresh` 静默续期 |
| `cookie` | 老 new-api / one-api | `session` Cookie + `New-Api-User` 头 |
| `pat` | 任意版本，用户自己粘贴令牌 | `Authorization: Bearer <nap_… / sk-…>` |

注意：新版站点**不再使用** `session` Cookie，**不再识别** `New-Api-User` 头。
用旧方式登录会出现“登录成功但读不到账户”。

## 为什么需要 Host 代理

中转站不返回 `Access-Control-Allow-Origin`，浏览器直连会被 CORS 拒绝。因此
Host 半注册 `POST /relay-usage/api`，在同进程内用 `node:http(s)` 请求站点，
浏览器只与本机同源通信。

凭证只存在于 Host 进程内存（会话 id → cookie / token），不落盘；
浏览器端只有勾选「记住凭据」时才写入 `localStorage`。

接口动作：

```
{"action":"connect", "baseUrl":"https://api.example.com", "username":"u", "password":"p"}
{"action":"connect", "baseUrl":"https://api.example.com", "token":"sk-...", "userId":"1"}
{"action":"overview","sessionId":"..."}
{"action":"logout",  "sessionId":"..."}
```

## 安装状态

本机这套 DSH 安装缺少随包 pnpm（`resources\runtime\primary-runtime` 不存在），
`plugin_manager install_bundle` 会直接失败。因此采用等价的手工落盘 + 管理器启用：

1. `node_modules\@local\dsh-relay-usage` → 目录联接（junction）到本包
2. `package.json`：`dependencies` 增加 `"@desstg/dsh-relay-usage": "link:E:\\DeepSeek\\relay-usage-plugin"`
3. `package.json`：`dsh.profile.bundles` 增加 `"@desstg/dsh-relay-usage"`
4. 改动前的 `package.json` / `cordis.patch.yml` 已备份为 `*.bak-relay-*`

## 卸载

1. 从 `dsh.profile.bundles` 与 `dependencies` 移除 `@desstg/dsh-relay-usage`
2. 删除 `node_modules\@local\dsh-relay-usage` 联接
3. 重启 DSH

## 已知限制

- Host 半热重载：改完 `index.js` 后，用 Plugin Manager 把该行关掉再打开即可生效；
  重启 DSH 同样有效
- `client.js` 修改后刷新页面即可
- 今日 / 近 7 日数据由 `/api/log/self` 分页汇总（最多 8 页 × 100 条），
  消耗极多的账号可能统计偏小
- `.test/run.mjs` 是离线自测脚本（mock 站点，覆盖 jwt / cookie / pat 与刷新路径），
  运行：`node .test/run.mjs`
