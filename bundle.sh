#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Get version from manifest.json
VERSION=$(jq -r .version manifest.json)
if [ -z "$VERSION" ]; then
  echo "Error: Could not read version from manifest.json"
  exit 1
fi

echo "Bundling YouLy+ version $VERSION"

# Create dist directory if it doesn't exist
mkdir -p dist

# Define common files/directories to bundle
COMMON_FILES="LICENSE icons src readme.md _locales"

# --- Bundle for Chromium (Chrome / Edge / Brave) ---
echo "Creating newsync-v${VERSION}-chromium.zip..."
TEMP_DIR="temp_chromium"
mkdir -p "$TEMP_DIR"

# Copy common files
cp -r $COMMON_FILES "$TEMP_DIR/"

# Modify manifest.json for Chromium
jq 'del(.browser_specific_settings) | .background = {"service_worker": "src/background/lyricsHandler.js", "type": "module"}' manifest.json > "$TEMP_DIR/manifest.json"

# Create zip archive
(cd "$TEMP_DIR" && zip -r "../dist/newsync-v${VERSION}-chromium.zip" .)

# Clean up temporary directory
rm -rf "$TEMP_DIR"
echo "Finished newsync-v${VERSION}-chromium.zip"

# --- Bundle for Gecko (Firefox / Zen Browser) ---
echo "Creating newsync-v${VERSION}-gecko.zip..."
TEMP_DIR="temp_gecko"
mkdir -p "$TEMP_DIR"

# Copy common files
cp -r $COMMON_FILES "$TEMP_DIR/"

# Modify manifest.json for Gecko
jq '.background = {"scripts": ["src/background/lyricsHandler.js"], "type": "module"}' manifest.json > "$TEMP_DIR/manifest.json"

# Create zip archive
(cd "$TEMP_DIR" && zip -r "../dist/newsync-v${VERSION}-gecko.zip" .)

# Clean up temporary directory
rm -rf "$TEMP_DIR"
echo "Finished newsync-v${VERSION}-gecko.zip"

echo "Bundling complete. Output files are in the 'dist' directory."
