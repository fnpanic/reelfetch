# ReelFetch updater: Chrome/Edge/Brave native messaging host installed by the Windows setup.
# Protocol: 4-byte little-endian length + UTF-8 JSON, one request per launch.
#   {op:"ping"}   -> {ok:true, version}
#   {op:"update"} -> downloads <base>/latest.json + the zip it names, verifies signature and SHA-256, swaps the files.
#   {op:"ytdlp"}  -> downloads one video with yt-dlp, streaming progress (see Invoke-Ytdlp; needs connectNative).
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

# Public half of the release signing key (the private half never leaves the publisher's PC; scripts/sign.mjs).
# The update server only stores files: without this check, whoever controls it could ship any code.
$UpdateKey = '<RSAKeyValue><Modulus>yQspfAnUcPwFagXAY1ouHjXZuHUszTsbIDXL+F87bvSUOeE/fjmD7u26XAdBofXpOZldWlxj9M/f4nfA6w7TNBXBR87naumyd/41H3LSA4f/19RXtxxcfy1/QS5ykF4Ig5yhOfVnBjRZi6pkZrmZHj8c2cpdZ8oXNzN/SFvCPT1ZD+Xcm15wOXl46TnyB2DG9i6Cshe7v52C9dutX6xSiqOZHslsARXHYgbZ7Q2Q+p7CFjyqD0mqN789Grq6HLpLy0cZ+yTJxaXKSMNv/WO0tTXYeA/uMipRYwBDbh9TW+1BuUmTgI8RivXFHxvLmnJK8zHRIhokV/gx5UpRaZMcMM7Cbbu8LIh4InqwyDmMrVrW3Om8itFuRQ2Az1xHshpWp8jQGHEUStidHfDQFAL9v8XgVxoT3KSTKKsp6Nq3X7wYpyLJqldPICQuKHE+RvzmoXeOVemoFE6cPU/lHdioUNwU5l68S4xLoVqumON2g42nTc3f2XT6/sRW9+GA7o/5</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>'

# The signature (RSA PKCS#1 v1.5, SHA-256) covers "<version>`n<sha256 in lower case>".
function Test-Signature($rel) {
  if ([string]$rel.sig -notmatch '^[A-Za-z0-9+/]+=*$') { return $false }
  $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
  $rsa.FromXmlString($UpdateKey)
  $data = [Text.Encoding]::UTF8.GetBytes("$($rel.version)`n$($rel.sha256.ToLower())")
  return $rsa.VerifyData($data, [Convert]::FromBase64String($rel.sig), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
}

function Update-Extension($cfg) {
  $base = $cfg.base.TrimEnd('/')
  $rel = Invoke-RestMethod -UseBasicParsing -Uri "$base/latest.json" -Headers @{ 'Cache-Control' = 'no-cache' }
  if ($rel.version -notmatch '^\d+(\.\d+){0,3}$' -or $rel.zip -notmatch '^[\w.\-]+$' -or $rel.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid release data' }
  if (-not (Test-Signature $rel)) { throw 'Update rejected: it is not signed by the ReelFetch publisher' }
  $installed = Get-InstalledVersion $cfg.extensionDir
  if ([version]$rel.version -lt [version]$installed) { throw 'Update rejected: it is older than the installed version' }
  # Files already current (the setup ran, or the browser loads another copy): nothing to swap, the extension just reloads.
  if ([version]$rel.version -eq [version]$installed) { return $installed }
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

# ---- yt-dlp: tools live in <app>\tools, fetched from GitHub on first use and checked against the release's SHA-256.
$Tools = Join-Path (Split-Path $PSScriptRoot) 'tools'

function Get-Checked($url, $sumsUrl, $name, $out) {
  $sums = (New-Object Net.WebClient).DownloadString($sumsUrl)
  $line = ($sums -split "`n" | Where-Object { $_ -match "\s\*?$([regex]::Escape($name))\s*$" } | Select-Object -First 1)
  if (-not $line) { $line = $sums } # deno: one file per hash
  if ($line -notmatch '([0-9a-fA-F]{64})') { throw "No checksum for $name" }
  $want = $Matches[1].ToUpper()
  # Download beside the target and move it there once checked: a dropped connection or a second job starting
  # at the same time must never leave a partial or unchecked file at the final path.
  $tmp = "$out.$PID.tmp"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tmp
  if ((Get-FileHash -Algorithm SHA256 -Path $tmp).Hash -ne $want) { Remove-Item -Force $tmp; throw "Checksum mismatch: $name" }
  Move-Item -Force -Path $tmp -Destination $out
}

function Get-Zipped($url, $sumsUrl, $name, [string[]]$exes) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("reelfetch-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Get-Checked $url $sumsUrl $name (Join-Path $tmp $name)
    Expand-Archive -Path (Join-Path $tmp $name) -DestinationPath (Join-Path $tmp 'x')
    foreach ($e in $exes) { Get-ChildItem -Recurse -Path (Join-Path $tmp 'x') -Filter $e | Select-Object -First 1 | Move-Item -Force -Destination $Tools }
  } finally { Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue }
}

# yt-dlp.exe + deno (YouTube's JS challenges; found next to yt-dlp.exe) + ffmpeg (merging) unless already on PATH.
function Install-Tools {
  New-Item -ItemType Directory -Force -Path $Tools | Out-Null
  $exe = Join-Path $Tools 'yt-dlp.exe'
  $gh = 'https://github.com'
  if (-not (Test-Path $exe)) {
    Write-Message @{ type = 'setup' }
    Get-Checked "$gh/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" "$gh/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" 'yt-dlp.exe' $exe
  } elseif ((Get-Item $exe).LastWriteTime -lt (Get-Date).AddDays(-1)) {
    # YouTube changes often; yt-dlp verifies its own update.
    # With 'Stop', a line on stderr (GitHub unreachable, ...) would end the whole download: a failed self-update is fine.
    & { $ErrorActionPreference = 'Continue'; & $exe -U 2>&1 | Out-Null }
    (Get-Item $exe).LastWriteTime = Get-Date
  }
  if (-not (Test-Path (Join-Path $Tools 'deno.exe')) -and -not (Get-Command deno -ErrorAction SilentlyContinue)) {
    Write-Message @{ type = 'setup' }
    $z = 'deno-x86_64-pc-windows-msvc.zip'
    Get-Zipped "$gh/denoland/deno/releases/latest/download/$z" "$gh/denoland/deno/releases/latest/download/$z.sha256sum" $z @('deno.exe')
  }
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ff) { return (Split-Path $ff.Source) }
  if (-not (Test-Path (Join-Path $Tools 'ffmpeg.exe'))) {
    Write-Message @{ type = 'setup' }
    $z = 'ffmpeg-master-latest-win64-gpl.zip'
    Get-Zipped "$gh/yt-dlp/FFmpeg-Builds/releases/download/latest/$z" "$gh/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256" $z @('ffmpeg.exe', 'ffprobe.exe')
  }
  return $Tools
}

function Get-DownloadsDir {
  $p = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').'{374DE290-123F-4565-9164-39C4925E467B}'
  if ($p) { return [Environment]::ExpandEnvironmentVariables($p) }
  return Join-Path $env:USERPROFILE 'Downloads'
}

function Quote($s) { '"' + ($s -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }

# {op:"ytdlp", url, referer?, height?, audioOnly?, name} over connectNative. Replies: {type:"setup"},
# {type:"progress", bytes, total}, then {type:"done", file, size} or {ok:false, error}. Closing the port cancels.
function Invoke-Ytdlp($msg) {
  # Arguments are built here from checked fields only, so the extension cannot pass yt-dlp options.
  if ($msg.url -notmatch '^https?://') { throw 'Invalid URL' }
  $name = [string]$msg.name
  if (-not $name -or $name -match '(^|[\\/])\.\.([\\/]|$)' -or $name -match '^[\\/]|:') { throw 'Invalid file name' }
  $ffdir = Install-Tools
  $out = Join-Path (Get-DownloadsDir) (($name -replace '/', '\' -replace '%', '%%') + '.%(ext)s')
  $a = @('--newline', '--progress', '--no-simulate', '--no-playlist', '--quiet', '--no-warnings', '--windows-filenames',
    '--ffmpeg-location', $ffdir, '-o', $out,
    '--progress-template', 'download:RF %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
    '--print', 'after_move:RFFILE %(filepath)s')
  if ($msg.referer -match '^https?://') { $a += @('--referer', $msg.referer) }
  if ($msg.audioOnly) { $a += @('-f', 'ba/b', '-x') }
  else {
    $h = [int]$msg.height
    # Highest resolution (up to the chosen variant), then H.264 over AV1/VP9 so the file plays everywhere.
    $a += @('-S', "res$(if ($h -gt 0) { ":$h" }),vcodec:h264,ext:mp4:m4a", '--merge-output-format', 'mp4')
  }
  $a += @('--', $msg.url)

  $psi = New-Object Diagnostics.ProcessStartInfo (Join-Path $Tools 'yt-dlp.exe')
  $psi.Arguments = ($a | ForEach-Object { Quote $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true # its own stdin: sharing ours (pending read) blocks its startup
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  # Any input (or EOF when the extension closes the port) means cancel.
  $stdin = [Console]::OpenStandardInput().ReadAsync((New-Object byte[] 4), 0, 4)
  $file = $null
  $lastErr = $null
  # Progress and --print go to stdout, errors to stderr: read both line by line.
  $streams = @($p.StandardOutput, $p.StandardError)
  $reads = @($streams[0].ReadLineAsync(), $streams[1].ReadLineAsync())
  $open = 2
  while ($open -gt 0) {
    $i = [Threading.Tasks.Task]::WaitAny(@($reads[0], $reads[1], $stdin), 1000)
    if ($stdin.IsCompleted) {
      & { $ErrorActionPreference = 'Continue'; & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } # "not found" on stderr must not skip the cleanup
      $p.WaitForExit(5000) | Out-Null
      # Partial files of this job: <name>.part, <name>.f399.mp4.part, .ytdl state files.
      Get-ChildItem -LiteralPath (Split-Path $out) -Filter ((Split-Path -Leaf $out) -replace '%\(ext\)s$', '*') -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\.(part|ytdl)$|\.part-Frag\d+' } | Remove-Item -Force -ErrorAction SilentlyContinue
      exit 0
    }
    if ($i -lt 0 -or $i -gt 1) { continue }
    $l = $reads[$i].Result
    if ($null -eq $l) { $open--; $reads[$i] = New-Object 'Threading.Tasks.TaskCompletionSource[string]' | ForEach-Object { $_.Task }; continue }
    if ($l -match '^RF (\d+) (\S+) (\S+)') {
      $m = $Matches.Clone() # the -match below would overwrite $Matches
      $total = if ($m[2] -match '^\d+$') { [long]$m[2] } elseif ($m[3] -match '^[\d.]+$') { [long][double]$m[3] } else { $null }
      Write-Message @{ type = 'progress'; bytes = [long]$m[1]; total = $total }
    } elseif ($l -match '^RFFILE (.+)$') { $file = $Matches[1] }
    elseif ($l -match '^ERROR:\s*(.+)$') { $lastErr = $Matches[1] }
    $reads[$i] = $streams[$i].ReadLineAsync()
  }
  $p.WaitForExit()
  if ($p.ExitCode -ne 0 -or -not $file) {
    throw $(if ($lastErr) { $lastErr } else { "yt-dlp failed (exit $($p.ExitCode))" })
  }
  Write-Message @{ type = 'done'; file = $file; size = (Get-Item -LiteralPath $file).Length }
}

try {
  $cfg = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json
  $msg = Read-Message
  switch ($msg.op) {
    'ping' { Write-Message @{ ok = $true; version = (Get-InstalledVersion $cfg.extensionDir); ytdlp = $true } }
    'update' { Write-Message @{ ok = $true; version = (Update-Extension $cfg) } }
    'ytdlp' { Invoke-Ytdlp $msg }
    default { Write-Message @{ ok = $false; error = 'Unknown request' } }
  }
} catch {
  Write-Message @{ ok = $false; error = $_.Exception.Message }
}
