$ErrorActionPreference = "Stop"

$manifest = Get-Content -Raw -Path manifest.json | ConvertFrom-Json
$VERSION = $manifest.version
Write-Host "Packaging version: $VERSION"

if (-not (Test-Path -Path "dist" -PathType Container)) {
    New-Item -Path "dist" -ItemType Directory | Out-Null
}

$COMMON_FILES = @("LICENSE", "icons", "src", "readme.md", "_locales")

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Create-ZipFromFolder($sourceFolder, $destinationZip) {
    if (Test-Path $destinationZip) { Remove-Item $destinationZip -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($sourceFolder, $destinationZip)
}

# 1. CHROMIUM BUILD
Write-Host "Creating Chromium build..."
$tChromium = "temp_chromium"
if (Test-Path $tChromium) { Remove-Item $tChromium -Recurse -Force }
New-Item -Path $tChromium -ItemType Directory | Out-Null

foreach ($f in $COMMON_FILES) {
    if (Test-Path $f) { Copy-Item -Path $f -Destination $tChromium -Recurse -Force }
}

$mC = Get-Content -Raw -Path manifest.json | ConvertFrom-Json
if ($mC.PSObject.Properties['browser_specific_settings']) { 
    $mC.PSObject.Properties.Remove('browser_specific_settings') 
}
$mC.background = [pscustomobject]@{
    service_worker = "src/background/lyricsHandler.js"
    type = "module"
}
$jsonC = $mC | ConvertTo-Json -Depth 100
Set-Content -Path "$tChromium/manifest.json" -Value $jsonC -Encoding UTF8

$zipC = Join-Path (Get-Location) "dist/newsync-v${VERSION}-chromium.zip"
Create-ZipFromFolder "$tChromium" "$zipC"
Remove-Item $tChromium -Recurse -Force
Write-Host "Chromium package created at: $zipC"

# 2. GECKO (FIREFOX / ZEN) BUILD
Write-Host "Creating Gecko (Firefox/Zen) build..."
$tGecko = "temp_gecko"
if (Test-Path $tGecko) { Remove-Item $tGecko -Recurse -Force }
New-Item -Path $tGecko -ItemType Directory | Out-Null

foreach ($f in $COMMON_FILES) {
    if (Test-Path $f) { Copy-Item -Path $f -Destination $tGecko -Recurse -Force }
}

$mG = Get-Content -Raw -Path manifest.json | ConvertFrom-Json
$mG.background = [pscustomobject]@{
    scripts = @("src/background/lyricsHandler.js")
    type = "module"
}
$jsonG = $mG | ConvertTo-Json -Depth 100
Set-Content -Path "$tGecko/manifest.json" -Value $jsonG -Encoding UTF8

$zipG = Join-Path (Get-Location) "dist/newsync-v${VERSION}-gecko.zip"
Create-ZipFromFolder "$tGecko" "$zipG"
Remove-Item $tGecko -Recurse -Force
Write-Host "Gecko package created at: $zipG"
