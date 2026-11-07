# 用个人访问令牌（PAT）创建仓库并把本地提交推上去。
#
# 1) 建一个 PAT：GitHub → Settings → Developer settings → Personal access tokens
#    · Fine-grained token：给这个账号勾 "Administration: Read and write"（用于建库）
#      以及 "Contents: Read and write"（用于推代码）；或
#    · Classic token：勾 repo（含 public_repo）即可。
# 2) 在仓库目录执行：
#      .\scripts\push.ps1 -Token ghp_xxxxxxxxxxxx
#
# 令牌只出现在这一次命令的参数里：不写入 .git/config、不缓存、不落盘。

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Owner = 'desstg',
  [string]$Name = 'dsh-relay-usage',
  [string]$Branch = 'main',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
  if (-not (Test-Path .git)) { throw "这里不是 git 仓库：$root" }

  $headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
  }

  Write-Host "→ 检查仓库 $Owner/$Name ..." -ForegroundColor Cyan
  $exists = $false
  try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Name" -Headers $headers -Method Get
    $exists = $true
  } catch {
    $exists = $false
  }

  if (-not $exists) {
    Write-Host "→ 仓库不存在，创建中 ..." -ForegroundColor Cyan
    $body = @{
      name        = $Name
      description = 'DSH plugin: sidebar panel for relay station usage (new-api / one-api + DeepSeek official)'
      private     = [bool]$Private
      has_issues  = $true
    } | ConvertTo-Json
    try {
      $null = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Headers $headers -Method Post -Body $body -ContentType 'application/json'
      Write-Host "  已创建 https://github.com/$Owner/$Name" -ForegroundColor Green
    } catch {
      throw "创建仓库失败：$($_.Exception.Message)（确认令牌有 Administration: Read and write 或 repo 权限）"
    }
  } else {
    Write-Host "  已存在，直接推送" -ForegroundColor Green
  }

  $origin = "https://x-access-token:$Token@github.com/$Owner/$Name.git"

  Write-Host "→ 推送 $Branch ..." -ForegroundColor Cyan
  git -c credential.helper= push $origin $Branch
  if ($LASTEXITCODE -ne 0) { throw "推送 $Branch 失败" }

  Write-Host "→ 推送标签 ..." -ForegroundColor Cyan
  git -c credential.helper= push $origin --tags
  if ($LASTEXITCODE -ne 0) { throw "推送标签失败" }

  git remote remove origin 2>$null
  git remote add origin "https://github.com/$Owner/$Name.git"

  Write-Host ""
  Write-Host "完成：https://github.com/$Owner/$Name" -ForegroundColor Green
  Write-Host "Release 附件由 .github/workflows/release.yml 在标签推送后自动构建。" -ForegroundColor DarkGray
}
finally {
  Pop-Location
}
