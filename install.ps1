# ============================================================
#  Prompt Lab - DSH Plugin Installer
#  Registers this plugin into one or more DeepSeek Harness profiles.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File install.ps1
#    powershell -ExecutionPolicy Bypass -File install.ps1 -Profiles web
#    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
#  NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 as
#  ANSI, so CJK literals would corrupt the token stream.
# ============================================================
[CmdletBinding()]
param(
    [string[]]$Profiles = @('default', 'desktop', 'web'),
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Ok   { param($m) Write-Host $m -ForegroundColor Green }
function Warn { param($m) Write-Host $m -ForegroundColor Yellow }
function Err  { param($m) Write-Host $m -ForegroundColor Red }
function Info { param($m) Write-Host $m }

$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgPath    = Join-Path $PluginRoot 'package.json'

if (-not (Test-Path $PkgPath)) {
    Err "[ERROR] package.json not found: $PkgPath"
    exit 1
}
$Pkg = Get-Content $PkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$PkgName = $Pkg.name
$Version = $Pkg.version
$DirName = Split-Path -Leaf $PluginRoot

$Mode = "Install"
if ($Uninstall) { $Mode = "Uninstall" }

Write-Host ""
Info ("=== Prompt Lab : Plugin " + $Mode + " ===")
Info ("Plugin  : " + $PkgName)
Info ("Version : " + $Version)
Info ("Path    : " + $PluginRoot)
Write-Host ""

$DSHRoot = Join-Path $env:USERPROFILE '.dsh'
if (-not (Test-Path $DSHRoot)) {
    Err "[ERROR] DSH directory not found: $DSHRoot"
    Err "        Install and launch DeepSeek Harness at least once first."
    exit 1
}
Info ("DSH root : " + $DSHRoot)
Write-Host ""

$done = @()
$skipped = @()

foreach ($pn in $Profiles) {
    $pdir = Join-Path $DSHRoot "profiles\$pn"
    if (-not (Test-Path $pdir)) { $skipped += $pn; continue }

    $ymlPath = Join-Path $pdir 'cordis.patch.yml'
    $pkgProfile = Join-Path $pdir 'package.json'

    if ($Uninstall) {
        if (Test-Path $ymlPath) { Remove-Item $ymlPath -Force }
        if (Test-Path $pkgProfile) {
            $obj = Get-Content $pkgProfile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($obj.dependencies -and $obj.dependencies.PSObject.Properties[$PkgName]) {
                $obj.dependencies.PSObject.Properties.Remove($PkgName)
                ($obj | ConvertTo-Json -Depth 10) | Set-Content $pkgProfile -Encoding UTF8
            }
        }
        $done += $pn
        Write-Host "      [x] $pn  (unregistered)"
        continue
    }

    # cordis.patch.yml
    $yml = "- insert:`r`n    - id: $PkgName`r`n      name: '$PkgName'`r`n"
    Set-Content -Path $ymlPath -Value $yml -Encoding UTF8

    # profile package.json -> dependencies
    if (Test-Path $pkgProfile) {
        $obj = Get-Content $pkgProfile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $obj.PSObject.Properties['dependencies']) {
            $obj | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([PSCustomObject]@{})
        }

        # 依赖路径解析：
        #   若插件位于 <DSH>\plugins\<DirName>，用标准相对路径；
        #   否则回退为绝对 file: 路径（任何位置都能解析）。
        $expected = Join-Path $DSHRoot ("plugins\" + $DirName)
        $pluginFull = (Resolve-Path $PluginRoot).Path
        $depValue = $null
        if ($pluginFull -eq (Join-Path $DSHRoot "plugins\$DirName")) {
            $depValue = "../../plugins/$DirName"
        } else {
            $normalized = $pluginFull -replace '\\', '/'
            $depValue = "file:///$normalized"
            Warn ("      plugin is outside <DSH>\plugins\, using absolute path for " + $pn)
        }

        $obj.dependencies | Add-Member -NotePropertyName $PkgName -NotePropertyValue $depValue -Force
        ($obj | ConvertTo-Json -Depth 10) | Set-Content $pkgProfile -Encoding UTF8
    }
    $done += $pn
    Write-Host "      [x] $pn"
}
foreach ($s in $skipped) { Write-Host "      [-] $s (not present, skipped)" -ForegroundColor DarkGray }

Write-Host ""
if ($done.Count -eq 0) {
    Err "[ERROR] No profile was configured."
    exit 1
}

Info "Verifying..."
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Push-Location $PluginRoot
    try {
        & node --check index.js  2>&1 | Out-Null; $a = $LASTEXITCODE
        & node --check client.js 2>&1 | Out-Null; $b = $LASTEXITCODE
        if ($a -eq 0 -and $b -eq 0) { Write-Host "      node --check passed" }
        else { Warn "      syntax check FAILED" }

        if (Test-Path 'scripts\verify-prompts.mjs') {
            $out = & node scripts/verify-prompts.mjs 2>&1 | Select-Object -Last 1
            Write-Host ("      " + $out)
        }
    } finally { Pop-Location }
} else {
    Warn "      [SKIP] node not found"
}

Write-Host ""
$DoneMsg = "[DONE] Installed"
if ($Uninstall) { $DoneMsg = "[DONE] Unregistered" }
Ok $DoneMsg
Write-Host ""
Write-Host "--------------------------------------------------"
Write-Host " Next steps:"
Write-Host "   1. Fully quit DSH (end the process, not the window)"
Write-Host "   2. Start DSH again"
if (-not $Uninstall) {
    Write-Host "   3. Confirm the badge shows: Prompt Lab v$Version"
}
Write-Host "--------------------------------------------------"
Write-Host ""
Write-Host (" Configured profiles: " + ($done -join ', ')) -ForegroundColor DarkGray
Write-Host ""
