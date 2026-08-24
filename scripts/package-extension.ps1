param(
  [ValidateSet("Store", "Development")]
  [string]$Mode = "Store",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot "highlighter"
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repositoryRoot "dist"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$stageRoot = Join-Path $OutputDirectory ("stage-" + $Mode.ToLowerInvariant())

$topLevelFiles = @(
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "settings.js",
  "settings-ui.js",
  "popup.js",
  "popup.html",
  "popup.css"
)
$runtimeDirectories = @("icons", "data\rules", "src\highlight", "src\logging")
$developmentKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5gYsvEBvl5KZHgGi7o7efwFPR+VxFJ1Y84Jmpj/kA4gXbTAeHpJ51aRM2vGl3c7yXMxNCWlYBi0ziXQs9WmAmtR7VvRz7i9913Ghic6euU7GoPujGRYivz7qwk1XPuv4O6g4Yq0JmH4yCRWPXxz+W2X2lED/gIpuvwRF42HhBpuKAEUr8eP1mLUbpyKIfCMQ1TuStScyC/P6sWUSTRWiMYUvoNhr+Kae89s0Ba5+1HPdVCCbXrvls80UsEC3h5pH2qpFsgddLFxkWnmos+p4PMKkSkHSNuOfuAjESE3sBtQtb2XH3m4lSlsYcilte5KXRkzYaqlUg+0ItvsevOtDNwIDAQAB"

function Assert-ReleaseEndpoint([string]$EndpointUrl) {
  try {
    $uri = [Uri]$EndpointUrl
  } catch {
    throw "KEYWORD_HIGHLIGHTER_ENDPOINT_URL must be a valid URL."
  }
  if ($uri.Scheme -ne "https" -or $uri.Host -ne "script.google.com" -or -not $uri.AbsolutePath.EndsWith("/exec")) {
    throw "KEYWORD_HIGHLIGHTER_ENDPOINT_URL must be an HTTPS script.google.com /exec URL."
  }
}

function Assert-PackagedFile([string]$RelativePath) {
  $candidate = Join-Path $stageRoot $RelativePath
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Manifest references missing packaged file: $RelativePath"
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Set-PackagedLoggingConfig([string]$EndpointUrl, [string]$ApiKey) {
  $configPath = Join-Path $stageRoot "src\logging\config.js"
  $configSource = Get-Content -LiteralPath $configPath -Raw
  $endpointLiteral = $EndpointUrl | ConvertTo-Json -Compress
  $apiKeyLiteral = $ApiKey | ConvertTo-Json -Compress
  $configSource = [regex]::Replace($configSource, '(?m)(endpointUrl:\s*)"[^"]*"', ('$1' + $endpointLiteral))
  $configSource = [regex]::Replace($configSource, '(?m)(apiKey:\s*)"[^"]*"', ('$1' + $apiKeyLiteral))
  Write-Utf8NoBom $configPath $configSource
}

function Write-DeterministicZip([string]$SourceDirectory, [string]$ZipPath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
  $fileStream = [IO.File]::Open($ZipPath, [IO.FileMode]::CreateNew)
  $archive = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    $files = Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File | Sort-Object FullName
    foreach ($file in $files) {
      $relativePath = $file.FullName.Substring($SourceDirectory.Length).TrimStart("\", "/").Replace("\", "/")
      $entry = $archive.CreateEntry($relativePath, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $inputStream = [IO.File]::OpenRead($file.FullName)
      $outputStream = $entry.Open()
      try {
        $inputStream.CopyTo($outputStream)
      } finally {
        $outputStream.Dispose()
        $inputStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
    $fileStream.Dispose()
  }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $stageRoot) {
  $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
  if (-not $resolvedStage.StartsWith($OutputDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace a staging directory outside the selected output directory."
  }
  Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null

try {
  foreach ($relativePath in $topLevelFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination (Join-Path $stageRoot $relativePath)
  }
  foreach ($relativePath in $runtimeDirectories) {
    $destination = Join-Path $stageRoot $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination $destination -Recurse
  }
  Remove-Item -LiteralPath (Join-Path $stageRoot "src\logging\config.example.js") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $stageRoot "src\logging\config.local.example.js") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $stageRoot "src\logging\config.local.js") -Force -ErrorAction SilentlyContinue

  $manifestPath = Join-Path $stageRoot "manifest.json"
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

  if ($Mode -eq "Store") {
    $endpointUrl = $env:KEYWORD_HIGHLIGHTER_ENDPOINT_URL
    $apiKey = $env:KEYWORD_HIGHLIGHTER_API_KEY
    $storePublicKey = $env:KEYWORD_HIGHLIGHTER_STORE_PUBLIC_KEY
    if (-not $endpointUrl) { throw "KEYWORD_HIGHLIGHTER_ENDPOINT_URL is required for Store packaging." }
    if (-not $apiKey -or $apiKey.Length -lt 24) { throw "KEYWORD_HIGHLIGHTER_API_KEY must contain at least 24 characters." }
    Assert-ReleaseEndpoint $endpointUrl
    if ($apiKey -match "REPLACE_WITH_|replace-with-") { throw "KEYWORD_HIGHLIGHTER_API_KEY still contains a placeholder." }

    if ($storePublicKey) {
      try { [Convert]::FromBase64String($storePublicKey) | Out-Null } catch { throw "KEYWORD_HIGHLIGHTER_STORE_PUBLIC_KEY must be base64." }
      $manifest | Add-Member -NotePropertyName "key" -NotePropertyValue $storePublicKey -Force
    } else {
      $manifest.PSObject.Properties.Remove("key")
    }

    Set-PackagedLoggingConfig $endpointUrl $apiKey
  } else {
    $manifest | Add-Member -NotePropertyName "key" -NotePropertyValue $developmentKey -Force
    $localMatches = @("http://localhost/*", "http://127.0.0.1/*")
    $manifest.host_permissions = @($manifest.host_permissions) + $localMatches
    $manifest.content_scripts[0].matches = @($manifest.content_scripts[0].matches) + $localMatches
    $manifest.web_accessible_resources[0].matches = @($manifest.web_accessible_resources[0].matches) + $localMatches
    $developmentEndpoint = $env:KEYWORD_HIGHLIGHTER_ENDPOINT_URL
    $developmentApiKey = $env:KEYWORD_HIGHLIGHTER_API_KEY
    if ($developmentEndpoint -and $developmentApiKey) {
      Assert-ReleaseEndpoint $developmentEndpoint
      Set-PackagedLoggingConfig $developmentEndpoint $developmentApiKey
    }
  }

  Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 20)
  $validatedManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-PackagedFile $validatedManifest.background.service_worker
  Assert-PackagedFile $validatedManifest.action.default_popup
  foreach ($icon in $validatedManifest.icons.PSObject.Properties.Value) { Assert-PackagedFile $icon }
  foreach ($contentScript in $validatedManifest.content_scripts) {
    foreach ($script in $contentScript.js) { Assert-PackagedFile $script }
    foreach ($stylesheet in $contentScript.css) { Assert-PackagedFile $stylesheet }
  }
  foreach ($resourceGroup in $validatedManifest.web_accessible_resources) {
    foreach ($resource in $resourceGroup.resources) { Assert-PackagedFile $resource }
  }

  if ($Mode -eq "Store") {
    $manifestText = Get-Content -LiteralPath $manifestPath -Raw
    if ($manifestText -match 'localhost|127\.0\.0\.1|"tabs"') { throw "Store manifest contains development access or the unused tabs permission." }
    $runtimeConfigText = Get-Content -LiteralPath (Join-Path $stageRoot "src\logging\config.js") -Raw
    if ($runtimeConfigText -match "REPLACE_WITH_|YOUR_DEPLOYMENT_ID|replace-with-") { throw "Store runtime configuration contains an unresolved placeholder." }
  }

  $version = $validatedManifest.version
  $zipPath = Join-Path $OutputDirectory ("offisght-operations-rule-highlighter-$version-" + $Mode.ToLowerInvariant() + ".zip")
  Write-DeterministicZip $stageRoot $zipPath
  Write-Output $zipPath
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}
