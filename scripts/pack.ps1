# pack.ps1 - Package the extension into a zip file for GitHub Release
# Usage: .\scripts\pack.ps1
# Output zip is written to dist/ using the manifest version.

param()

$ErrorActionPreference = "Stop"

# Read version from manifest.json
$manifestPath = Join-Path $PSScriptRoot "..\manifest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifest = [System.IO.File]::ReadAllText(
    (Resolve-Path $manifestPath).Path, $utf8NoBom
) | ConvertFrom-Json
$version = $manifest.version

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
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

# File extensions that are text (need UTF-8 no-BOM handling)
$textExtensions = @(".js", ".html", ".css", ".json", ".md")

# Create temporary directory for staging
$tempDir = Join-Path $distDir "staging"
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

# Copy files to staging, ensuring text files are written as UTF-8 without BOM
foreach ($item in $includeItems) {
    $sourcePath = Join-Path $projectRoot $item
    if (-not (Test-Path $sourcePath)) { continue }

    if ((Get-Item $sourcePath).PSIsContainer) {
        # Copy directory, then rewrite text files without BOM
        $destDir = Join-Path $tempDir $item
        Copy-Item -Path $sourcePath -Destination $destDir -Recurse -Force

        Get-ChildItem -Path $destDir -Recurse -File | ForEach-Object {
            if ($textExtensions -contains $_.Extension.ToLower()) {
                $content = [System.IO.File]::ReadAllText($_.FullName, $utf8NoBom)
                [System.IO.File]::WriteAllText($_.FullName, $content, $utf8NoBom)
            }
        }
    } else {
        $destPath = Join-Path $tempDir $item
        if ($textExtensions -contains (Get-Item $sourcePath).Extension.ToLower()) {
            $content = [System.IO.File]::ReadAllText($sourcePath, $utf8NoBom)
            [System.IO.File]::WriteAllText($destPath, $content, $utf8NoBom)
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
