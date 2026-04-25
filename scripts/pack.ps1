# pack.ps1 - Package the extension into a zip file for GitHub Release
# Usage: .\scripts\pack.ps1
# Output zip is written to dist/ using the manifest version.

param(
    [string]$OutputFileName
)

$ErrorActionPreference = "Stop"

# Read version from manifest.json
$manifestPath = Join-Path $PSScriptRoot "..\manifest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifest = [System.IO.File]::ReadAllText(
    (Resolve-Path $manifestPath).Path, $utf8NoBom
) | ConvertFrom-Json
$version = $manifest.version

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distDir = Join-Path $projectRoot "dist"
$defaultOutputName = "llm-thinking-translator-v$version.zip"
$outputName = if ([string]::IsNullOrWhiteSpace($OutputFileName)) {
    $defaultOutputName
} else {
    $OutputFileName
}
$outputFile = Join-Path $distDir $outputName

# Create dist directory
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

# Remove existing zip if present
if (Test-Path $outputFile) {
    try {
        Remove-Item $outputFile -Force -ErrorAction Stop
    }
    catch {
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($outputName)
        $extName = [System.IO.Path]::GetExtension($outputName)
        $outputName = "$baseName-$timestamp$extName"
        $outputFile = Join-Path $distDir $outputName
        Write-Host "Output file is locked, fallback to: $outputFile"
    }
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

# Create zip from staging directory.
# Use forward slashes in entry names so Chromium/Edge unpackers treat paths correctly.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open(
    $outputFile,
    [System.IO.Compression.ZipArchiveMode]::Create
)
try {
    Get-ChildItem -Path $tempDir -Recurse -File | ForEach-Object {
        $entryName = $_.FullName.Substring($tempDir.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $_.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $zip.Dispose()
}

# Clean up staging
Remove-Item $tempDir -Recurse -Force

Write-Host "Package created: $outputFile"
Write-Host "Version: $version"
