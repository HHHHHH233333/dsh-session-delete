#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-session-delete 安装到本机 DeepSeek Harness（桌面版）的 profile。

.DESCRIPTION
  做四件事，全部可重复执行（幂等）：
    1. 备份目标 profile 的 package.json；
    2. 写入依赖 "dsh-session-delete": "link:<本目录>"；
    3. 把 "dsh-session-delete" 追加到 dsh.profile.bundles；
    4. 用 DSH 自带的 node + pnpm 执行 install，并校验包能解析。

  安装走 link:，所以安装后不要删除或改名本目录。

.PARAMETER Profile
  profile 名称，桌面应用默认是 desktop。

.PARAMETER DshHome
  DSH 主目录，默认取 $env:DSH_HOME，其次 ~/.dsh。

.PARAMETER DryRun
  只打印将要做的改动，不写文件、不执行 pnpm。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$bundleName = 'dsh-session-delete'
$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Warn([string]$message) { Write-Host "!!  $message" -ForegroundColor Yellow }

# --- 1. 校验插件目录 ---------------------------------------------------------
foreach ($required in @('package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'lib\service.js')) {
  $path = Join-Path $pluginDir $required
  if (-not (Test-Path -LiteralPath $path)) {
    throw "这不是完整的插件目录：缺少 $required（当前目录 $pluginDir）"
  }
}
$manifest = Get-Content -LiteralPath (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne $bundleName) { throw "package.json 的 name 应为 $bundleName，实际是 $($manifest.name)" }
Write-Step "插件 $bundleName $($manifest.version) @ $pluginDir"

# --- 2. 定位 profile ---------------------------------------------------------
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profilePkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profilePkg)) {
  throw "找不到 profile：$profilePkg（先用桌面应用启动一次，或用 -Profile 指定正确的名字）"
}
Write-Step "目标 profile：$profileDir"

# --- 3. 定位 node 与 pnpm ----------------------------------------------------
$node = $null
$pnpm = $null
$runtimeRoots = @(
  (Join-Path $DshHome 'dsh-runtimes'),
  (Join-Path $HOME '.dsh\dsh-runtimes')
) | Select-Object -Unique
foreach ($runtimeRoot in $runtimeRoots) {
  if ($node -and $pnpm) { break }
  if (-not (Test-Path -LiteralPath $runtimeRoot)) { continue }
  $candidate = Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'dependencies' } |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'node\bin\node.exe') } |
    Select-Object -First 1
  if ($candidate) {
    $node = Join-Path $candidate 'node\bin\node.exe'
    $pnpmCjs = Join-Path $candidate 'pnpm\bin\pnpm.cjs'
    $pnpmMjs = Join-Path $candidate 'pnpm\bin\pnpm.mjs'
    if (Test-Path -LiteralPath $pnpmCjs) { $pnpm = $pnpmCjs }
    elseif (Test-Path -LiteralPath $pnpmMjs) { $pnpm = $pnpmMjs }
  }
}
if (-not $node -or -not $pnpm) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($nodeCmd -and $pnpmCmd) {
    $node = $nodeCmd.Source
    $pnpm = $pnpmCmd.Source
  } else {
    throw "没有找到 DSH 自带的 node/pnpm，也没有全局 node/pnpm。请先启动一次桌面应用再运行本脚本。"
  }
}
Write-Step "node：$node"
Write-Step "pnpm：$pnpm"

# --- 4. 改写 manifest（先备份） ---------------------------------------------
$current = Get-Content -LiteralPath $profilePkg -Raw | ConvertFrom-Json
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$backup = "$profilePkg.bak-$stamp"
Write-Step "备份：$backup"
if (-not $DryRun) { Copy-Item -LiteralPath $profilePkg -Destination $backup -Force }

$dependencies = [ordered]@{}
if ($current.PSObject.Properties.Name -contains 'dependencies' -and $current.dependencies) {
  foreach ($property in $current.dependencies.PSObject.Properties) { $dependencies[$property.Name] = $property.Value }
}
$dependencies[$bundleName] = "link:$pluginDir"

$bundles = @()
if ($current.PSObject.Properties.Name -contains 'dsh' -and $current.dsh -and $current.dsh.profile -and $current.dsh.profile.bundles) {
  $bundles = @($current.dsh.profile.bundles)
}
if ($bundles -notcontains $bundleName) { $bundles += $bundleName }

$next = [ordered]@{}
foreach ($property in $current.PSObject.Properties) { $next[$property.Name] = $property.Value }
$next['dependencies'] = [pscustomobject]$dependencies

# 三处都可能缺失（别人的 profile 可能没有 dsh / profile 段），逐层补齐而不假设结构。
$dsh = $current.dsh
if (-not $dsh) { $dsh = New-Object psobject }
if (-not ($dsh.PSObject.Properties.Name -contains 'profile') -or -not $dsh.profile) {
  $dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) -Force
}
$dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
$next['dsh'] = $dsh

Write-Step ("bundles：" + ($bundles -join ' | '))
if ($DryRun) {
  Write-Warning "DryRun：不写入 $profilePkg、不执行 pnpm。"
  return
}
[IO.File]::WriteAllText($profilePkg, ($next | ConvertTo-Json -Depth 20), $utf8)

# --- 5. 安装依赖 -------------------------------------------------------------
Write-Step "执行 pnpm install（首次可能较慢）"
Push-Location $profileDir
try {
  & $node $pnpm install --prefer-offline --reporter=append-only
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（退出码 $LASTEXITCODE）" }
} finally {
  Pop-Location
}

# --- 6. 校验 -----------------------------------------------------------------
Write-Step "校验安装结果"
$probe = "const {createRequire}=require('node:module');const r=createRequire(process.argv[1]);console.log(r.resolve('$bundleName'))"
& $node -e $probe $profilePkg
if ($LASTEXITCODE -ne 0) { throw "安装后仍无法从 profile 解析 $bundleName" }

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "  1) 完全退出并重新启动 DeepSeek Harness（新 bundle 只在启动时组合）；"
Write-Host "  2) 重启后在侧栏会话右键菜单里应出现“彻底删除会话…”，排在“归档”和“复制会话 ID”之后；"
Write-Host "  3) 如需回滚：把 $backup 覆盖回 package.json，再执行一次 pnpm install 并重启。"