param(
  [string]$ExtensionId = "",
  [string]$Profile = "Default",
  [int]$Tail = 220,
  [int]$SinceMinutes = 0,
  [switch]$ErrorsOnly
)

$ErrorActionPreference = "Stop"

function Read-TextShared {
  param([string]$Path)

  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
  } catch {
    return ""
  }

  try {
    if ($stream.Length -le 0) {
      return ""
    }
    $bytes = New-Object byte[] $stream.Length
    $null = $stream.Read($bytes, 0, $bytes.Length)
    return [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
  } finally {
    $stream.Dispose()
  }
}

function Get-LineTimestamp {
  param([string]$Line)
  if ($Line -match "^MWGLOG (?<at>20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[") {
    try {
      return [DateTime]::ParseExact(
        $Matches["at"],
        "yyyy-MM-ddTHH:mm:ss.fffZ",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal
      )
    } catch {
      return [DateTime]::MinValue
    }
  }
  return [DateTime]::MinValue
}

function Normalize-Line {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return ""
  }

  $clean = ($Line -replace "[^\u0020-\u007E]", " ")
  $clean = ($clean -replace "\s+", " ").Trim()
  if ($clean.Length -gt 1800) {
    $clean = $clean.Substring(0, 1800) + "..."
  }
  return $clean
}

function Convert-ToLogLine {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return ""
  }

  $raw = $Candidate.Trim('"')
  try {
    $text = [System.Text.RegularExpressions.Regex]::Unescape($raw)
  } catch {
    $text = $raw -replace '\\"', '"' -replace "\\\\", "\"
  }
  $line = Normalize-Line -Line $text
  if ([string]::IsNullOrWhiteSpace($line)) {
    return ""
  }

  if ($line -notmatch "^MWGLOG 20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(info|warn|error)\] ") {
    return ""
  }

  if ($line -match "\|\s*\{\\?$") {
    return ""
  }

  return $line
}

function Add-LogEntry {
  param(
    [string]$Line,
    [hashtable]$Entries,
    [hashtable]$Scores
  )

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return
  }

  $pipeIndex = $Line.IndexOf(" | ")
  $key = if ($pipeIndex -gt 0) { $Line.Substring(0, $pipeIndex) } else { $Line }

  $score = 0
  $score += ([regex]::Matches($Line, '":')).Count * 8
  if ($Line -match '\| \{') {
    $score += 20
  }
  if ($Line -match '\.\.\.$') {
    $score -= 10
  }
  $score += [Math]::Min($Line.Length, 1000)

  if (-not $Entries.ContainsKey($key) -or $score -gt [int]$Scores[$key]) {
    $Entries[$key] = $Line
    $Scores[$key] = $score
  }
}

function Resolve-ExtensionLogDir {
  param(
    [string]$Profile,
    [string]$ExtensionId
  )

  $baseDir = Join-Path $env:LOCALAPPDATA ("Google\Chrome\User Data\{0}\Local Extension Settings" -f $Profile)
  if (-not (Test-Path $baseDir)) {
    Write-Host "Chrome profile log folder not found: $baseDir"
    exit 1
  }

  if (-not [string]::IsNullOrWhiteSpace($ExtensionId)) {
    return Join-Path $baseDir $ExtensionId
  }

  $detectedDirs = @()
  $dirs = Get-ChildItem -Path $baseDir -Directory -ErrorAction SilentlyContinue
  foreach ($dir in $dirs) {
    $latestFile = Get-ChildItem -Path $dir.FullName -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^\d+\.(log|ldb)$" } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1

    if (-not $latestFile) {
      continue
    }

    $text = Read-TextShared -Path $latestFile.FullName
    if ($text -notmatch "MWGLOG\s+20\d{2}-\d{2}-\d{2}T") {
      continue
    }

    $detectedDirs += [PSCustomObject]@{
      ExtensionId  = $dir.Name
      FullName     = $dir.FullName
      LastWriteTime = $latestFile.LastWriteTime
    }
  }

  if (-not $detectedDirs) {
    Write-Host "Could not auto-detect extension log folder. Pass -ExtensionId explicitly."
    exit 1
  }

  $selected = $detectedDirs | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Write-Host ("Auto-detected ExtensionId: {0}" -f $selected.ExtensionId)
  return $selected.FullName
}

$logDir = Resolve-ExtensionLogDir -Profile $Profile -ExtensionId $ExtensionId
if (-not (Test-Path $logDir)) {
  Write-Host "Log folder not found: $logDir"
  exit 1
}

$files = Get-ChildItem -Path $logDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match "^\d+\.(log|ldb)$" } |
  Sort-Object LastWriteTime, Name

if (-not $files) {
  Write-Host "No LevelDB files found in: $logDir"
  exit 1
}

$flatPattern = [regex]'MWGLOG\s+20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+\[(?:info|warn|error)\]\s+[^\x00"\r\n]+'
$flatQuotedPattern = [regex]'"(?<line>MWGLOG\s+20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+\[(?:info|warn|error)\]\s+(?:(?:\\.)|[^"])*)"'
$legacyPattern = [regex]"\""at\"":\""(?<at>20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\""(?:(?!\""at\"":).){0,2000}?\""level\"":\""(?<level>[^\""]+)\""(?:(?!\""at\"":).){0,900}?\""message\"":\""(?<message>(?:\\.|[^\""\\])+)\"""

$entries = @{}
$scores = @{}
$fileTexts = @()

foreach ($file in $files) {
  $text = Read-TextShared -Path $file.FullName
  if ([string]::IsNullOrEmpty($text)) {
    continue
  }
  $fileTexts += $text
}

foreach ($text in $fileTexts) {
  foreach ($match in $flatQuotedPattern.Matches($text)) {
    $line = Convert-ToLogLine -Candidate $match.Groups["line"].Value
    Add-LogEntry -Line $line -Entries $entries -Scores $scores
  }
}

foreach ($text in $fileTexts) {
  foreach ($match in $flatPattern.Matches($text)) {
    $line = Convert-ToLogLine -Candidate $match.Value
    Add-LogEntry -Line $line -Entries $entries -Scores $scores
  }
}

foreach ($text in $fileTexts) {
  foreach ($match in $legacyPattern.Matches($text)) {
    $at = $match.Groups["at"].Value
    $level = $match.Groups["level"].Value
    $message = $match.Groups["message"].Value
    if ([string]::IsNullOrWhiteSpace($at) -or [string]::IsNullOrWhiteSpace($message)) {
      continue
    }
    $decodedMessage = [System.Text.RegularExpressions.Regex]::Unescape($message)
    $decodedMessage = Normalize-Line -Line $decodedMessage
    if ([string]::IsNullOrWhiteSpace($decodedMessage)) {
      continue
    }
    $line = ("MWGLOG {0} [{1}] {2}" -f $at, $level, $decodedMessage)
    Add-LogEntry -Line $line -Entries $entries -Scores $scores
  }
}

$outputLines = @($entries.Values)
if ($ErrorsOnly) {
  $outputLines = @(
    $outputLines | Where-Object {
      $_ -match "\[(error|warn)\]" -or
      $_ -match "(?i)failed|first fail|forbidden|csrf|signin|403|404|500"
    }
  )
}

if ($outputLines.Count -eq 0) {
  Write-Host "No matching logs found."
  exit 0
}

$outputLines = @($outputLines | Sort-Object { Get-LineTimestamp -Line $_ }, { $_ })

if ($SinceMinutes -gt 0) {
  $thresholdUtc = (Get-Date).ToUniversalTime().AddMinutes(-$SinceMinutes)
  $outputLines = @(
    $outputLines | Where-Object {
      (Get-LineTimestamp -Line $_) -ge $thresholdUtc
    }
  )
}

if ($Tail -gt 0 -and $outputLines.Count -gt $Tail) {
  $outputLines = $outputLines | Select-Object -Last $Tail
}

Write-Host ("Source: {0}" -f $logDir)
Write-Host ("Logs: {0}" -f $outputLines.Count)
$outputLines | ForEach-Object { Write-Output $_ }
