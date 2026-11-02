# ReelFetch updater: Chrome/Edge/Brave native messaging host installed by the Windows setup.
# Protocol: 4-byte little-endian length + UTF-8 JSON, one request per launch.
#   {op:"ping"}   -> {ok:true, version}
#   {op:"update"} -> downloads <base>/latest.json + the zip it names, verifies SHA-256, swaps the files.
# The download source is fixed in config.json (written by the setup); the extension cannot redirect it.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Read-Message {
  $in = [Console]::OpenStandardInput()
  $len = New-Object byte[] 4
  if ($in.Read($len, 0, 4) -ne 4) { return $null }
  $n = [BitConverter]::ToInt32($len, 0)
  $buf = New-Object byte[] $n
  $got = 0
  while ($got -lt $n) { $r = $in.Read($buf, $got, $n - $got); if ($r -le 0) { break }; $got += $r }
  return [Text.Encoding]::UTF8.GetString($buf, 0, $got) | ConvertFrom-Json
}

function Write-Message($obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  $out = [Console]::OpenStandardOutput()
  $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Get-InstalledVersion($dir) {
  (Get-Content -Raw -Path (Join-Path $dir 'manifest.json') | ConvertFrom-Json).version
}

function Update-Extension($cfg) {
  $base = $cfg.base.TrimEnd('/')
  $rel = Invoke-RestMethod -UseBasicParsing -Uri "$base/latest.json" -Headers @{ 'Cache-Control' = 'no-cache' }
  if ($rel.zip -notmatch '^[\w.\-]+$' -or $rel.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid release data' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("reelfetch-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'ext.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$($rel.zip)" -OutFile $zip
    $hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
    if ($hash -ne $rel.sha256.ToUpper()) { throw 'Checksum mismatch: download corrupted or tampered' }
    $new = Join-Path $tmp 'ext'
    Expand-Archive -Path $zip -DestinationPath $new
    if ((Get-InstalledVersion $new) -ne $rel.version) { throw 'Version mismatch in package' }
    # Mirror into place (removes files the new version no longer has); exit codes < 8 mean success.
    & robocopy $new $cfg.extensionDir /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)" }
    return $rel.version
  } finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
  }
}

try {
  $cfg = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
  $msg = Read-Message
  switch ($msg.op) {
    'ping' { Write-Message @{ ok = $true; version = (Get-InstalledVersion $cfg.extensionDir) } }
    'update' { Write-Message @{ ok = $true; version = (Update-Extension $cfg) } }
    default { Write-Message @{ ok = $false; error = 'Unknown request' } }
  }
} catch {
  Write-Message @{ ok = $false; error = $_.Exception.Message }
}
