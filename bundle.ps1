# Exit immediately if a command exits with a non-zero status.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest # Add this for stricter error checking

# Get version from manifest.json
try {
    $manifest = Get-Content -Raw -Path manifest.json | ConvertFrom-Json
    $VERSION = $manifest.version
    if ([string]::IsNullOrEmpty($VERSION)) {
        Write-Error "Error: Could not read version from manifest.json"
        exit 1
    }
} catch {
    Write-Error "Error reading or parsing manifest.json: $($_.Exception.Message)"
    exit 1
}

Write-Host "Bundling YouLy+ version $VERSION"

# Create dist directory if it doesn't exist
if (-not (Test-Path -Path "dist" -PathType Container)) {
    New-Item -Path "dist" -ItemType Directory | Out-Null
}

# Define common files/directories to bundle
$COMMON_FILES = @("LICENSE", "icons", "src", "readme.md", "_locales")

# Function to create zip archive using 7z.exe or zip.exe
function Create-ZipArchive {
    param (
        [string]$SourceDir,
        [string]$DestinationZipRelative # This is the path relative to the original script location
    )
    Write-Host "Zipping contents of $SourceDir to $DestinationZipRelative"
    
    # Construct the absolute path for the destination zip
    $absoluteDestinationZip = Join-Path (Get-Location) $DestinationZipRelative

    if (Test-Path -Path $absoluteDestinationZip) { Remove-Item -Path $absoluteDestinationZip -Force | Out-Null }
    
    $zipToolFound = $false
    $sevenZipPath = "$env:ProgramFiles\7-Zip\7z.exe" # Default 7-Zip install path

    # Try using 7z.exe first (check PATH, then default install path)
    $sevenZipCmd = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if (-not $sevenZipCmd -and (Test-Path $sevenZipPath)) {
        $sevenZipCmd = $sevenZipPath
    }

    if ($sevenZipCmd) {
        try {
            Push-Location $SourceDir
            # Use the absolute path for the destination zip
            & $sevenZipCmd a -tzip "$absoluteDestinationZip" . 
            Pop-Location
            $zipToolFound = $true
        } catch {
            Write-Warning "Error using 7z.exe: $($_.Exception.Message). Trying zip.exe..."
        }
    }

    # If 7z.exe failed or not found, try zip.exe
    if (-not $zipToolFound -and (Get-Command zip.exe -ErrorAction SilentlyContinue)) {
        try {
            Push-Location $SourceDir
            # Use the absolute path for the destination zip
            & zip.exe -r "$absoluteDestinationZip" . 
            Pop-Location
            $zipToolFound = $true
        } catch {
            Write-Warning "Error using zip.exe: $($_.Exception.Message)."
        }
    }

    if (-not $zipToolFound) {
        Write-Error "Error: Neither '7z.exe' (in PATH or default install location) nor 'zip.exe' found or failed to execute. Please install one of them and ensure it's in your PATH, or 7-Zip is in its default location."
        exit 1
    }
}

# --- Bundle for Chromium (Chrome / Edge / Brave) ---
Write-Host "Creating newsync-v${VERSION}-chromium.zip..."
$TEMP_DIR = "temp_chromium"
if (Test-Path -Path $TEMP_DIR -PathType Container) {
    Remove-Item -Path $TEMP_DIR -Recurse -Force | Out-Null
}
New-Item -Path $TEMP_DIR -ItemType Directory | Out-Null

foreach ($file in $COMMON_FILES) {
    if (Test-Path -Path $file) {
        Copy-Item -Path $file -Destination $TEMP_DIR -Recurse -Force | Out-Null
    }
}

$manifestChromium = $manifest | ConvertTo-Json -Depth 100 | ConvertFrom-Json
if ($manifestChromium.PSObject.Properties['browser_specific_settings']) {
    $manifestChromium.PSObject.Properties.Remove("browser_specific_settings")
}
$manifestChromium.background = [pscustomobject]@{
    service_worker = "src/background/lyricsHandler.js"
    type = "module"
}
$manifestChromium | ConvertTo-Json -Depth 100 | Set-Content -Path "$TEMP_DIR/manifest.json" -Force

Create-ZipArchive -SourceDir $TEMP_DIR -DestinationZip "dist/newsync-v${VERSION}-chromium.zip"
Remove-Item -Path $TEMP_DIR -Recurse -Force | Out-Null
Write-Host "Finished newsync-v${VERSION}-chromium.zip"

# --- Bundle for Gecko (Firefox / Zen Browser) ---
Write-Host "Creating newsync-v${VERSION}-gecko.zip..."
$TEMP_DIR = "temp_gecko"
if (Test-Path -Path $TEMP_DIR -PathType Container) {
    Remove-Item -Path $TEMP_DIR -Recurse -Force | Out-Null
}
New-Item -Path $TEMP_DIR -ItemType Directory | Out-Null

foreach ($file in $COMMON_FILES) {
    if (Test-Path -Path $file) {
        Copy-Item -Path $file -Destination $TEMP_DIR -Recurse -Force | Out-Null
    }
}

$manifestGecko = $manifest | ConvertTo-Json -Depth 100 | ConvertFrom-Json
$manifestGecko.background = [pscustomobject]@{
    scripts = @("src/background/lyricsHandler.js")
    type = "module"
}
$manifestGecko | ConvertTo-Json -Depth 100 | Set-Content -Path "$TEMP_DIR/manifest.json" -Force

Create-ZipArchive -SourceDir $TEMP_DIR -DestinationZip "dist/newsync-v${VERSION}-gecko.zip"
Remove-Item -Path $TEMP_DIR -Recurse -Force | Out-Null
Write-Host "Finished newsync-v${VERSION}-gecko.zip"

Write-Host "Bundling complete. Output files are in the 'dist' directory."
