# DSH 插件「中转站用量」一键安装脚本（Windows）
#
#   .\install.ps1                       # 自动探测 profile，装最新版
#   .\install.ps1 -Profile desktop      # 指定 profile
#   .\install.ps1 -Proxy http://192.168.31.9:7893   # 走代理下载
#   .\install.ps1 -Tgz D:\xxx.tgz       # 用本地包（离线）
#   .\install.ps1 -Uninstall            # 卸载
#
# 它做的事：下载 release 包 → 解到 %LOCALAPPDATA%\dsh-plugins →
# 在 profile 的 node_modules 建目录联接 → 往 profile 的 package.json
# 写入 dependencies 与 dsh.profile.bundles（改前自动备份）。

param(
  [string]$Profile = '',
  [string]$DshHome = '',
  [string]$Repo = 'desstg/dsh-relay-usage',
  [string]$PackageName = '@desstg/dsh-relay-usage',
  [string]$Ref = 'latest',
  [string]$Proxy = '',
  [string]$Tgz = '',
  [string]$InstallDir = '',
  [switch]$Uninstall,
  [switch]$NoRestartHint
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "→ $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  $text" -ForegroundColor Yellow }

# ---------- 1. 定位 DSH home 与 profile ----------
if (-not $DshHome) {
  $candidates = @("$env:USERPROFILE\.dsh", "$env:APPDATA\dsh", "$env:LOCALAPPDATA\dsh") | Where-Object { Test-Path $_ }
  if (-not $candidates) { throw '找不到 DSH 目录（试过 ~/.dsh、%APPDATA%\dsh、%LOCALAPPDATA%\dsh）。用 -DshHome 指定。' }
  $DshHome = $candidates[0]
}
$profilesRoot = Join-Path $DshHome 'profiles'
if (-not (Test-Path $profilesRoot)) { throw "找不到 profiles 目录：$profilesRoot" }

if (-not $Profile) {
  $dirs = Get-ChildItem $profilesRoot -Directory | Select-Object -ExpandProperty Name
  if ($dirs.Count -eq 1) { $Profile = $dirs[0] }
  elseif ($dirs -contains 'desktop') { $Profile = 'desktop' }
  else { throw "检测到多个 profile：$($dirs -join ', ')。用 -Profile 指定一个。" }
}
$profileDir = Join-Path $profilesRoot $Profile
if (-not (Test-Path $profileDir)) { throw "profile 不存在：$profileDir" }
Write-Step "profile: $profileDir"

# ---------- 2. 安装目录 ----------
if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'dsh-plugins\dsh-relay-usage'
}
$linkPath = Join-Path $profileDir "node_modules\$PackageName"
$pkgJsonPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgJsonPath)) { throw "profile 缺少 package.json：$pkgJsonPath" }

# ---------- 3. 卸载 ----------
if ($Uninstall) {
  Write-Step '卸载'
  if (Test-Path $linkPath) {
    cmd /c rmdir "`"$linkPath`"" 2>$null | Out-Null
    if (Test-Path $linkPath) { Remove-Item $linkPath -Recurse -Force }
    Write-Ok "已移除联接 $linkPath"
  }
  $backup = "$pkgJsonPath.bak-uninstall-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $pkgJsonPath $backup -Force
  $json = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
  if ($json.dependencies.PSObject.Properties.Name -contains $PackageName) {
    $json.dependencies.PSObject.Properties.Remove($PackageName)
  }
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
    $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $PackageName })
  }
  $json | ConvertTo-Json -Depth 12 | Set-Content $pkgJsonPath -Encoding utf8
  Write-Ok "已从 package.json 移除（备份：$backup）"
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Ok "已删除 $InstallDir" }
  if (-not $NoRestartHint) { Write-Host "`n重启 DSH 生效。" -ForegroundColor Green }
  return
}

# ---------- 4. 取得安装包 ----------
$work = Join-Path $env:TEMP "dsh-relay-usage-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $work | Out-Null

if ($Tgz -and (Test-Path $Tgz)) {
  Write-Step "使用本地包 $Tgz"
  $tgzPath = $Tgz
} else {
  $curlArgs = @('-sSL', '--retry', '3', '--max-time', '180')
  if ($Proxy) { $curlArgs += @('-x', $Proxy) }

  if ($Ref -eq 'latest') {
    Write-Step '查询最新 release'
    $apiArgs = @('-sS', '--max-time', '60', '-H', 'Accept: application/vnd.github+json',
      "https://api.github.com/repos/$Repo/releases/latest")
    if ($Proxy) { $apiArgs = @('-x', $Proxy) + $apiArgs }
    $release = & curl.exe @apiArgs | ConvertFrom-Json
    if (-not $release.tag_name) { throw '查询 latest release 失败，可用 -Ref v1.5.1 指定版本' }
    $Ref = $release.tag_name
    $asset = $release.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
    $url = if ($asset) { $asset.browser_download_url } else { '' }
  }
  if (-not $url) {
    $assetName = ($PackageName -replace '^@', '') -replace '/', '-'
    $url = "https://github.com/$Repo/releases/download/$Ref/$assetName-$($Ref.TrimStart('v')).tgz"
  }

  Write-Step "下载 $url"
  $tgzPath = Join-Path $work 'plugin.tgz'
  & curl.exe @curlArgs -o $tgzPath $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tgzPath) -or (Get-Item $tgzPath).Length -lt 1000) {
    throw "下载失败（$url）。若 github.com 不通，加 -Proxy http://你的代理:端口，或用 -Tgz 指定本地包。"
  }
  Write-Ok ("已下载 " + [Math]::Round((Get-Item $tgzPath).Length / 1KB) + " KB")
}

# ---------- 5. 解包 ----------
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Step "解包到 $InstallDir"
& tar -xzf $tgzPath -C $InstallDir
if ($LASTEXITCODE -ne 0) { throw '解包失败（需要 Windows 自带的 tar.exe）' }
$inner = Join-Path $InstallDir 'package'
if (Test-Path $inner) {
  Get-ChildItem $inner -Force | Move-Item -Destination $InstallDir -Force
  Remove-Item $inner -Recurse -Force
}
if (-not (Test-Path (Join-Path $InstallDir 'package.json'))) { throw "解包后没有 package.json：$InstallDir" }
Write-Ok '解包完成'

# ---------- 6. 建立目录联接 ----------
$nmParent = Split-Path -Parent $linkPath
New-Item -ItemType Directory -Force -Path $nmParent | Out-Null
if (Test-Path $linkPath) {
  cmd /c rmdir "`"$linkPath`"" 2>$null | Out-Null
  if (Test-Path $linkPath) { Remove-Item $linkPath -Recurse -Force }
}
Write-Step '建立联接'
cmd /c mklink /J "`"$linkPath`"" "`"$InstallDir`"" | Out-Null
if (-not (Test-Path (Join-Path $linkPath 'package.json'))) {
  throw "联接建立失败：$linkPath（Windows 需要 NTFS；也可手动 mklink /J）"
}
Write-Ok $linkPath

# ---------- 7. 写 profile 的 package.json ----------
Write-Step '更新 profile 配置'
$backup = "$pkgJsonPath.bak-relay-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $pkgJsonPath $backup -Force
$json = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
$linkSpec = 'link:' + $InstallDir

if (-not $json.PSObject.Properties['dependencies']) {
  $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$json.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $linkSpec -Force

if (-not $json.PSObject.Properties['dsh']) {
  $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $json.dsh.PSObject.Properties['profile']) {
  $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $json.dsh.profile.PSObject.Properties['bundles']) {
  $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}
$bundles = @(@($json.dsh.profile.bundles) | Where-Object { $_ })
if ($bundles -notcontains $PackageName) { $bundles += $PackageName }
$json.dsh.profile.bundles = @($bundles)

$json | ConvertTo-Json -Depth 12 | Set-Content $pkgJsonPath -Encoding utf8
Write-Ok "已登记（备份：$(Split-Path -Leaf $backup)）"

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 8. 收尾提示 ----------
Write-Host ''
Write-Host "安装完成：$PackageName" -ForegroundColor Green
if (-not $NoRestartHint) {
  Write-Host '  1) 重启 DSH（或让插件管理器把 relay-usage 这一行关掉再打开）' -ForegroundColor Gray
  Write-Host '  2) 左侧栏会出现「中转站」，点开登录你自己的站点账号' -ForegroundColor Gray
  Write-Host '  3) 若页面已开，按 Ctrl+F5 刷新' -ForegroundColor Gray
}
