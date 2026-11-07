# 在没有 github.com:443 直连的环境里，用 GitHub REST API 把工作区当前内容推成一个 commit。
#
# 仅需要 api.github.com（通常可达），fine-grained PAT 勾 Contents: Read and write。
#
#   .\scripts\push-via-api.ps1 -Token <PAT> [-Description '中文简介'] [-Tag v1.5.1]
#
# 行为：读 `git ls-files` 的文件 → 建 blob/tree/commit → 建 refs/heads/main（和标签）。
# 令牌只在本次进程内存里，不写 .git/config。

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Owner = 'desstg',
  [string]$Name = 'dsh-relay-usage',
  [string]$Branch = 'main',
  [string]$Tag = '',
  [string]$Description = 'DSH 插件：左侧栏「中转站」面板，显示 new-api / one-api 中转站余额与用量，并支持 DeepSeek 官方余额。',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

$api = 'https://api.github.com'
$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

function Invoke-GitHub {
  param([string]$Method, [string]$Path, $Body, [int]$Attempts = 5)
  $params = @{ Uri = "$api$Path"; Headers = $headers; Method = $Method }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
    $params.ContentType = 'application/json; charset=utf-8'
  }

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      return Invoke-RestMethod @params
    } catch {
      $status = 0
      try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = 0 }
      $transient = ($status -eq 0) -or ($status -ge 500) -or ($status -eq 429)
      if (-not $transient -or $attempt -eq $Attempts) { throw }
      $wait = [Math]::Min(2 * $attempt, 10)
      Write-Host "   网络/服务端异常（HTTP $status），$wait 秒后重试 $attempt/$($Attempts - 1)" -ForegroundColor DarkYellow
      Start-Sleep -Seconds $wait
    }
  }
}

try {
  if (-not (Test-Path .git)) { throw "这里不是 git 仓库：$root" }

  Write-Host "1) 更新仓库简介（中文）" -ForegroundColor Cyan
  Invoke-GitHub -Method Patch -Path "/repos/$Owner/$Name" -Body @{
    description = $Description
    homepage    = "https://github.com/$Owner/$Name"
  } | Out-Null

  Write-Host "2) 上传文件 blob" -ForegroundColor Cyan
  $files = git ls-files
  if (-not $files) { throw '工作区没有已跟踪文件' }
  if (-not $Message) {
    $Message = (git log -1 --pretty=%B) -join "`n"
    if (-not $Message) { $Message = "chore: publish $Name" }
  }

  $tree = @()
  foreach ($file in $files) {
    $full = Join-Path $root ($file -replace '/', '\')
    if (-not (Test-Path $full)) { Write-Host "  跳过缺失文件 $file" -ForegroundColor DarkYellow; continue }
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($full))
    $blob = Invoke-GitHub -Method Post -Path "/repos/$Owner/$Name/git/blobs" -Body @{
      content  = $b64
      encoding = 'base64'
    }
    $tree += @{ path = $file; mode = '100644'; type = 'blob'; sha = $blob.sha }
    Write-Host "   $file" -ForegroundColor DarkGray
  }

  Write-Host "3) 建 tree" -ForegroundColor Cyan
  $treeObj = Invoke-GitHub -Method Post -Path "/repos/$Owner/$Name/git/trees" -Body @{ tree = $tree }

  Write-Host "4) 建 commit" -ForegroundColor Cyan
  $commitBody = @{
    message = $Message
    tree    = $treeObj.sha
    parents = @()
    author  = @{ name = 'desstg'; email = 'desstg@users.noreply.github.com' }
  }
  # 若分支已存在，则接在它后面
  try {
    $existing = Invoke-GitHub -Method Get -Path "/repos/$Owner/$Name/git/ref/heads/$Branch"
    $commitBody.parents = @($existing.object.sha)
    Write-Host "   基于已有分支 $($existing.object.sha.Substring(0,7))" -ForegroundColor DarkGray
  } catch {
    Write-Host "   首个提交" -ForegroundColor DarkGray
  }
  $commit = Invoke-GitHub -Method Post -Path "/repos/$Owner/$Name/git/commits" -Body $commitBody
  Write-Host "   commit = $($commit.sha)" -ForegroundColor Green

  Write-Host "5) 更新分支 ref" -ForegroundColor Cyan
  try {
    Invoke-GitHub -Method Patch -Path "/repos/$Owner/$Name/git/refs/heads/$Branch" -Body @{ sha = $commit.sha; force = $true } | Out-Null
    Write-Host "   已更新 refs/heads/$Branch" -ForegroundColor Green
  } catch {
    Invoke-GitHub -Method Post -Path "/repos/$Owner/$Name/git/refs" -Body @{ ref = "refs/heads/$Branch"; sha = $commit.sha } | Out-Null
    Write-Host "   已创建 refs/heads/$Branch" -ForegroundColor Green
  }

  if ($Tag) {
    Write-Host "6) 建标签 $Tag" -ForegroundColor Cyan
    try {
      Invoke-GitHub -Method Post -Path "/repos/$Owner/$Name/git/refs" -Body @{ ref = "refs/tags/$Tag"; sha = $commit.sha } | Out-Null
      Write-Host "   已创建 refs/tags/$Tag" -ForegroundColor Green
    } catch {
      Write-Host "   标签可能已存在：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
  }

  Write-Host ""
  Write-Host "完成：https://github.com/$Owner/$Name" -ForegroundColor Green
}
finally {
  Pop-Location
}
