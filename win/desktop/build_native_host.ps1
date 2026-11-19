<#
    编译 PeriodIQ Windows 原生宿主（WebView2 壳，native_host.cs）。

    用法（PowerShell）：进入本目录后执行
        .\build_native_host.ps1

    产物：
        bin\native_host.exe
        bin\WebView2Loader.dll
        bin\Microsoft.Web.WebView2.Core.dll
        bin\Microsoft.Web.WebView2.WinForms.dll

    约定：脚本内不写死任何机器绝对路径——csc 由 %WINDIR% 推导，
    其余全部相对 $PSScriptRoot 定位。
#>

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
    Write-Host "[build_native_host] 失败：$message"
    exit 1
}

try {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

    $sdkDir = Join-Path $scriptDir "webview2_sdk"
    $binDir = Join-Path $scriptDir "bin"
    $sourceAbs = Join-Path $scriptDir "native_host.cs"
    $iconAbs = Join-Path $scriptDir "app.ico"
    $manifestAbs = Join-Path $scriptDir "dpi.manifest"
    $outAbs = Join-Path $binDir "native_host.exe"

    # --- 1. 源文件与资源存在性 ---
    foreach ($p in @($sourceAbs, $iconAbs, $manifestAbs)) {
        if (-not (Test-Path -LiteralPath $p)) { Fail "缺少文件：$p" }
    }

    # --- 2. 定位 csc：%WINDIR% 推导（64 位优先，32 位回退）---
    $windir = $env:WINDIR
    if (-not $windir) { $windir = $env:SystemRoot }
    if (-not $windir) { Fail "环境变量 WINDIR / SystemRoot 均为空，无法定位 csc.exe。" }

    $csc64 = Join-Path $windir "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    $csc32 = Join-Path $windir "Microsoft.NET\Framework\v4.0.30319\csc.exe"
    if (Test-Path -LiteralPath $csc64) {
        $cscPath = $csc64
    }
    elseif (Test-Path -LiteralPath $csc32) {
        $cscPath = $csc32
        Write-Host "[build_native_host] 提示：未找到 64 位 csc，回退到 32 位目录：$csc32"
    }
    else {
        Fail "在 %WINDIR% 下未找到 .NET Framework 4.x 的 csc.exe。"
    }
    $frameworkDir = Split-Path -Parent $cscPath
    Write-Host "[build_native_host] csc：$cscPath"

    # --- 3. 引用程序集：系统程序集（裸名）+ webview2_sdk 托管 DLL ---
    $frameworkRefArgs = @()
    foreach ($asm in @("System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll")) {
        $asmPath = Join-Path $frameworkDir $asm
        if (-not (Test-Path -LiteralPath $asmPath)) { Fail "缺少系统程序集：$asmPath" }
        # 裸名引用：csc 在自身所在框架目录内解析同名程序集，避免路径含空格时的引号问题。
        $frameworkRefArgs += "/reference:$asm"
    }

    $coreDll = Join-Path $sdkDir "Microsoft.Web.WebView2.Core.dll"
    $winformsDll = Join-Path $sdkDir "Microsoft.Web.WebView2.WinForms.dll"
    $loaderDll = Join-Path $sdkDir "WebView2Loader.dll"
    foreach ($p in @($coreDll, $winformsDll, $loaderDll)) {
        if (-not (Test-Path -LiteralPath $p)) { Fail "缺少 WebView2 SDK 文件：$p" }
    }

    # --- 4. 准备输出目录 ---
    if (-not (Test-Path -LiteralPath $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    # --- 5. 编译（csc 以本目录为工作目录，仓库内文件一律用相对路径）---
    $cscArgs = @(
        "/nologo",
        "/target:winexe",
        "/platform:x64",
        "/optimize+",
        "/debug-",
        "/out:bin\native_host.exe",
        "/win32icon:app.ico",
        "/win32manifest:dpi.manifest",
        "/resource:app.ico,app.ico",
        "/reference:webview2_sdk\Microsoft.Web.WebView2.Core.dll",
        "/reference:webview2_sdk\Microsoft.Web.WebView2.WinForms.dll"
    )
    $cscArgs += $frameworkRefArgs
    $cscArgs += "native_host.cs"

    Write-Host "[build_native_host] 编译 native_host.cs ..."
    Push-Location $scriptDir
    try {
        # 原生命令的 stderr 不能因 ErrorActionPreference=Stop 而中断脚本，退出码另行判定。
        $ErrorActionPreference = "Continue"
        $compilerLog = & $cscPath @cscArgs 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
    }
    finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        Write-Host "[build_native_host] 编译失败（csc 退出码 $exitCode）："
        foreach ($line in $compilerLog) { Write-Host ("  " + $line) }
        exit 1
    }
    foreach ($line in $compilerLog) {
        if ("$line" -match "warning") { Write-Host ("  " + $line) }
    }

    # --- 6. 复制运行库 DLL 到 bin\ ---
    foreach ($dll in @($loaderDll, $coreDll, $winformsDll)) {
        Copy-Item -LiteralPath $dll -Destination $binDir -Force
    }

    Write-Host "[build_native_host] 编译成功："
    Write-Host "  $outAbs"
    Write-Host "  $(Join-Path $binDir 'WebView2Loader.dll')"
    Write-Host "  $(Join-Path $binDir 'Microsoft.Web.WebView2.Core.dll')"
    Write-Host "  $(Join-Path $binDir 'Microsoft.Web.WebView2.WinForms.dll')"
    exit 0
}
catch {
    Write-Host "[build_native_host] 异常：$($_.Exception.Message)"
    exit 1
}
