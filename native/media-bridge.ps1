# Bridge between Windows' System Media Transport Controls (the media flyout)
# and the Electron app. Emits one JSON object per line on stdout and reads
# simple commands from stdin: next | prev | play | pause | toggle | seek <ms>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

$script:asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

function Await($op, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  if (-not $task.Wait(4000)) { throw 'WinRT call timed out' }
  $task.Result
}

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Get-Session {
  $sessions = @($manager.GetSessions())
  # Prefer Spotify, then whatever Windows considers current.
  $spotify = $sessions | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1
  if ($spotify) { return $spotify }
  return $manager.GetCurrentSession()
}

function Read-Thumbnail($ref) {
  if (-not $ref) { return $null }
  try {
    $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # The stream arrives as a bare COM object, so bind the overload explicitly.
    $net = $script:asStreamForRead.Invoke($null, @($stream))
    $ms = New-Object System.IO.MemoryStream
    $net.CopyTo($ms)
    $net.Dispose()
    $bytes = $ms.ToArray()
    if ($bytes.Length -lt 8) { return $null }
    $type = if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { 'image/jpeg' } elseif ($bytes[0] -eq 0x89) { 'image/png' } else { 'image/bmp' }
    return "data:$type;base64," + [Convert]::ToBase64String($bytes)
  } catch { return $null }
}

$lastKey = $null
$lastArt = $null
$artRetry = 0
# [Console]::In.ReadLineAsync() is synchronous in PS 5.1; a raw StreamReader is not.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$pending = $stdin.ReadLineAsync()

while ($true) {
  # ---- commands ----
  while ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { exit 0 } # parent closed stdin
    $pending = $stdin.ReadLineAsync()
    $parts = $line.Trim().Split(' ')
    $session = Get-Session
    if (-not $session) { continue }
    try {
      switch ($parts[0]) {
        'next'   { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
        'play'   { $null = Await ($session.TryPlayAsync()) ([bool]) }
        'pause'  { $null = Await ($session.TryPauseAsync()) ([bool]) }
        'toggle' { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
        'seek'   { $null = Await ($session.TryChangePlaybackPositionAsync([long]$parts[1] * 10000)) ([bool]) }
      }
    } catch { Emit @{ type = 'error'; message = "$($parts[0]) failed" } }
  }

  # ---- state ----
  try {
    $session = Get-Session
    if (-not $session) {
      if ($lastKey -ne '') { $lastKey = ''; }
      Emit @{ type = 'state'; active = $false }
    } else {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $info = $session.GetPlaybackInfo()
      $tl = $session.GetTimelineProperties()
      $playing = $info.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing

      $pos = $tl.Position.TotalMilliseconds
      if ($playing -and $tl.LastUpdatedTime.Year -gt 2000) {
        $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds
      }
      $end = $tl.EndTime.TotalMilliseconds
      if ($end -gt 0) { $pos = [Math]::Min($pos, $end) }

      $key ="$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
      if ($key -ne $lastKey) {
        $lastKey = $key
        $lastArt = Read-Thumbnail $props.Thumbnail
        # Spotify sometimes publishes the thumbnail a moment after the title.
        $artRetry = if ($lastArt) { 0 } else { 6 }
        if ($lastArt) { Emit @{ type = 'art'; key = $key; data = $lastArt } }
      } elseif ($artRetry -gt 0) {
        $artRetry--
        $lastArt = Read-Thumbnail $props.Thumbnail
        if ($lastArt) { $artRetry = 0; Emit @{ type = 'art'; key = $key; data = $lastArt } }
      }

      $controls = $info.Controls
      Emit @{
        type       = 'state'
        active     = $true
        app        = $session.SourceAppUserModelId
        key        = $key
        title      = $props.Title
        artist     = $props.Artist
        album      = $props.AlbumTitle
        playing    = $playing
        positionMs = [long]$pos
        durationMs = [long]$end
        canSeek    = [bool]$controls.IsPlaybackPositionEnabled
        canNext    = [bool]$controls.IsNextEnabled
        canPrev    = [bool]$controls.IsPreviousEnabled
      }
    }
  } catch {
    Emit @{ type = 'state'; active = $false; error = $_.Exception.Message }
  }

  Start-Sleep -Milliseconds 400
}
