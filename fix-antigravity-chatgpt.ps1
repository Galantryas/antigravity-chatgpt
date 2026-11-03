$ErrorActionPreference = 'Stop'

# Remove the local proxy URL and a UTF-8 BOM from Antigravity's user settings.
# Text edits only: comments and the rest of the JSONC file are preserved.
$settingsFiles = @(
  (Join-Path $env:APPDATA 'Antigravity IDE\User\settings.json'),
  (Join-Path $env:APPDATA 'Antigravity\User\settings.json')
)

foreach ($path in $settingsFiles) {
  if (-not (Test-Path -LiteralPath $path)) { continue }

  $text = [IO.File]::ReadAllText($path)
  $original = $text

  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) {
    $text = $text.Substring(1)
  }

  $text = [regex]::Replace(
    $text,
    '(?m)^[ \t]*"jetski\.cloudCodeUrl"[ \t]*:[ \t]*"[^"]*"[ \t]*,?[ \t]*\r?\n?',
    ''
  )
  $text = [regex]::Replace($text, ',(\s*})', '$1')

  if ($text -ne $original) {
    [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Fixed $path"
  } else {
    Write-Host "No change needed for $path"
  }
}
