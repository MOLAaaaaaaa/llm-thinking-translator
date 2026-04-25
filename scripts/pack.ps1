# pack.ps1 - Package the extension into a zip file for GitHub Release
# Usage: .\scripts\pack.ps1
# Output zip is written to dist/ using the manifest version.

param()

$ErrorActionPreference = "Stop"

# Read version from manifest.json
$manifestPath = Join-Path $PSScriptRoot "..\manifest.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

$projectRoot = Join-Path $PSScriptRoot ".."
$distDir = Join-Path $projectRoot "dist"
$outputFile = Join-Path $distDir "llm-thinking-translator-v$version.zip"

# Create dist directory
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

# Remove existing zip if present
if (Test-Path $outputFile) {
    Remove-Item $outputFile -Force
}

# Files and directories to include
$includeItems = @(
    "manifest.json",
    "assets",
    "src"
)

# Files and directories to exclude
$excludePatterns = @(
    ".DS_Store",
    "Thumbs.db"
)

# Create temporary directory for staging
$tempDir = Join-Path $distDir "staging"
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

# Copy included items to staging
foreach ($item in $includeItems) {
    $sourcePath = Join-Path $projectRoot $item
    if (Test-Path $sourcePath) {
        $destPath = Join-Path $tempDir $item
        if ((Get-Item $sourcePath).PSIsContainer) {
            Copy-Item -Path $sourcePath -Destination $destPath -Recurse -Force
        } else {
            Copy-Item -Path $sourcePath -Destination $destPath -Force
        }
    }
}

# Remove excluded files from staging
foreach ($pattern in $excludePatterns) {
    Get-ChildItem -Path $tempDir -Recurse -Filter $pattern | Remove-Item -Force
}

# Create zip from staging directory
Compress-Archive -Path "$tempDir\*" -DestinationPath $outputFile -Force

# Clean up staging
Remove-Item $tempDir -Recurse -Force

Write-Host "Package created: $outputFile"
Write-Host "Version: $version"
