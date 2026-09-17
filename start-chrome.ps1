#Requires -Version 5.1
<#
.SYNOPSIS
    启动带 CDP 调试端口的 Chrome（专用 profile，不触碰你的日常浏览器）。

.DESCRIPTION
    Chrome 136+ 出于安全考虑，在默认 user-data-dir 下会忽略 --remote-debugging-port。
    因此本脚本强制使用 case 目录内的独立 profile (.chrome-debug)。
    首次运行需要你在这个 Chrome 里手动扫码登录猎聘；登录态会持久化在该 profile 中。

.PARAMETER Port
    CDP 调试端口，默认 9222。

.PARAMETER ProfileDir
    专用 profile 目录，默认 <case>\.chrome-debug。

.PARAMETER StartUrl
    启动后打开的地址，默认 https://c.liepin.com/

.PARAMETER Headless
    无头模式（--headless=new）。不弹窗口，适合 agent / 定时任务。
    **这是默认模式**（不传任何模式参数就是无头）。
    注意：无头下无法交互式登录，登录态靠 profile 里已有的 cookie。
    首次登录必须用 -Headed 跑一次。

.PARAMETER Headed
    有头模式（正常弹窗，--start-maximized）。仅用于首次扫码/短信登录、
    或需要人工过验证码时。默认是无头，所以必须显式加本参数。

.PARAMETER Kill
    只做关闭：杀掉当前使用本 profile 的 Chrome 进程，不重启。

.PARAMETER Status
    只做探测：打印 CDP 端点是否可用，不启停。

.PARAMETER Background
    有头模式，但窗口挪到所有显示器之外（--window-position=-32000,-32000）。
    这是完全正常的有头 Chrome：UA / 指纹 / 渲染与正常 Chrome 一致，不触发
    「无头浏览器」判定。需要避开无头风控时用这个。

.EXAMPLE
    powershell -File start-chrome.ps1              # 默认：无头
    powershell -File start-chrome.ps1 -Headed      # 有头（首次登录/过验证码）
    powershell -File start-chrome.ps1 -Background
    powershell -File start-chrome.ps1 -Status
    powershell -File start-chrome.ps1 -Kill
#>
param(
    [int]    $Port = 9222,
    [string] $ProfileDir,
    [string] $StartUrl = 'https://c.liepin.com/',
    [string] $ChromePath,
    [switch] $Headless,
    [switch] $Background,
    [switch] $Headed,
    [switch] $Kill,
    [switch] $Status
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# 模式默认值：无头。显式给 -Background / -Headed 才切回有头。
# （-Background / -Headed 只有这两个都未指定且也未显式 -Headless 时才自动填 -Headless）
if (-not $Headless -and -not $Background -and -not $Headed) { $Headless = $true }
if ($Headed -and ($Headless -or $Background)) {
    Write-Host '[X] -Headed 不能和 -Headless / -Background 同时用' -ForegroundColor Red
    exit 1
}

$CaseRoot = $PSScriptRoot
if (-not $ProfileDir) {
    # 默认放进工作根：profile 含登录 cookie，属于私人数据，不该落在技能目录里。
    $home2 = if ($env:JOB_APPLY_HOME) { $env:JOB_APPLY_HOME } else { $CaseRoot }
    $ProfileDir = Join-Path $home2 '.chrome-debug'
}
$ProfileDir = [IO.Path]::GetFullPath($ProfileDir)

function Get-CdpVersion {
    param([int] $P)
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 3
    }
    catch {
        return $null
    }
}

function Get-OurChromeProcs {
    param([string] $Profile)
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Profile*" }
}

# ---------- Status ----------
if ($Status) {
    $v = Get-CdpVersion -P $Port
    if ($v) {
        Write-Host "[OK] CDP alive on 127.0.0.1:$Port" -ForegroundColor Green
        Write-Host ("     Browser : {0}" -f $v.Browser)
        Write-Host ("     WS      : {0}" -f $v.webSocketDebuggerUrl)
        $procs = Get-OurChromeProcs -Profile $ProfileDir
        Write-Host ("     profile : {0}  (matched processes: {1})" -f $ProfileDir, @($procs).Count)
        exit 0
    }
    Write-Host "[--] CDP NOT listening on 127.0.0.1:$Port" -ForegroundColor Yellow
    Write-Host ("     expected profile: {0}" -f $ProfileDir)
    exit 2
}

# ---------- Kill ----------
if ($Kill) {
    $procs = @(Get-OurChromeProcs -Profile $ProfileDir)
    if ($procs.Count -eq 0) {
        Write-Host "[--] no chrome process bound to this profile; nothing to kill"
        exit 0
    }
    Write-Host ("[*] killing {0} chrome process(es) for {1}" -f $procs.Count, $ProfileDir)
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Write-Host "[OK] killed"
    exit 0
}

# ---------- Start ----------
# 浏览器可执行文件解析顺序：
#   1) -ChromePath 参数
#   2) 环境变量 CHROME_PATH（写在 .env 里即可，cli 会自动继承过来）
#   3) 技能自带的 browser/（分发时跟着 job-auto-apply 一起走）
#   4) D:\tools\cloakbrowser\... （本机固定安装位置）
#   5) 系统 Google Chrome
$chromeCandidates = @()
if ($ChromePath) { $chromeCandidates += $ChromePath }
if ($env:CHROME_PATH) { $chromeCandidates += $env:CHROME_PATH }
$chromeCandidates += @(
    (Join-Path $PSScriptRoot 'browser\chrome.exe'),
    'D:\tools\cloakbrowser\148.0.7778.215\browser\chrome.exe',
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chrome) {
    Write-Host 'ERROR: chrome.exe not found. Set -ChromePath or the CHROME_PATH env var.' -ForegroundColor Red
    exit 1
}

$chromeVer = (Get-Item -LiteralPath $chrome).VersionInfo.ProductVersion
$majorVer = [int]($chromeVer -split '\.')[0]

$existing = Get-CdpVersion -P $Port
if ($existing) {
    Write-Host "[--] port $Port already serving CDP ({0}); not starting a second instance" -f $existing.Browser -ForegroundColor Yellow
    Write-Host "     use -Kill first if you want a clean restart"
    exit 0
}

$portOwner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portOwner) {
    Write-Host "[X] port $Port is occupied by PID $($portOwner.OwningProcess -join ','), not Chrome CDP" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ElasticOverscroll'
)
if ($Headless -and -not $Background) {
    $args += '--headless=new'
    $args += '--disable-gpu'
    $args += '--window-size=1440,900'
}
elseif ($Background) {
    # 有头，但把窗口挪到所有显示器之外。这是完全正常的 Chrome：
    # UA / 指纹 / 渲染 / navigator.webdriver 都不做任何伪装，因此不会触发
    # 招聘平台对「无头浏览器」的判定；只是窗口不出现在桌面上。
    $args += '--window-position=-32000,-32000'
    $args += '--window-size=1280,900'
}
else {
    $args += '--start-maximized'
}
if ($StartUrl) { $args += $StartUrl }

Write-Host "[*] chrome      : $chrome (v$chromeVer, major $majorVer)"
Write-Host "[*] mode        : $(if ($Background) { 'headed + background (window off-screen)' } elseif ($Headless) { 'headless (--headless=new)' } else { 'headed' })"
Write-Host "[*] profile dir : $ProfileDir"
Write-Host "[*] cdp port    : $Port"
if ($majorVer -ge 136) {
    Write-Host "[i] Chrome >= 136: dedicated --user-data-dir is REQUIRED for remote debugging (handled)" -ForegroundColor DarkGray
}

$p = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
Write-Host "[*] launched pid $($p.Id), waiting for CDP endpoint..."

$deadline = (Get-Date).AddSeconds(45)
$v = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    $v = Get-CdpVersion -P $Port
    if ($v) { break }
}

if (-not $v) {
    Write-Host "[X] CDP endpoint did not come up within 45s" -ForegroundColor Red
    Write-Host "    check chrome://version and re-run with -Kill -Status"
    exit 1
}

Write-Host "[OK] CDP ready" -ForegroundColor Green
Write-Host ("     Browser : {0}" -f $v.Browser)
Write-Host ''
if ($Background) {
    Write-Host 'BACKGROUND >>> 窗口已挪到屏幕外，桌面上看不到它，但它是完全正常的有头 Chrome。' -ForegroundColor Cyan
    Write-Host '               无人值守推荐用这个，而不是 -Headless（无头会被猎聘判定为异常）。' -ForegroundColor Cyan
    Write-Host '               登录态复用 profile 里已有的 cookie；若未登录，' -ForegroundColor Cyan
    Write-Host '               先 -Kill，再不加本参数启动一次，手动登录后再切回来。' -ForegroundColor Cyan
}
elseif ($Headless) {
    Write-Host 'HEADLESS >>> 默认无头模式。猎聘可能因 HeadlessChrome UA 判定「账号行为异常」并拦详情页。' -ForegroundColor Cyan
    Write-Host '             若遇到验证码/风控：先 -Kill，再用 -Background（有头窗口挪到屏幕外）重启。' -ForegroundColor Cyan
    Write-Host '             首次登录：先 -Kill，再用 -Headed 启动，人工登录后切回默认。' -ForegroundColor Cyan
    Write-Host '             登录态直接复用 profile 里已有的 cookie。' -ForegroundColor Cyan
}
else {
    Write-Host 'NEXT >>> 在这个 Chrome 窗口里手动登录猎聘（扫码/短信），登录完成后回来告诉我。' -ForegroundColor Cyan
    Write-Host '       登录态会存进上面这个 profile，之后脚本零登录附着。' -ForegroundColor Cyan
}
exit 0
