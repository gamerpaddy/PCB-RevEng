# Regenerates the bundled JavaScript data files from their source files.
#
# Run this after editing sampleproject.pcbrev.json (or footprints_kicad.txt) so the
# local file:// loader picks up your changes. The browser blocks fetch() on file://
# pages, so the app reads these .js files instead, which simply assign the file
# contents to a global variable.
#
#   sampleproject.pcbrev.json  ->  sampleproject.js   (window.SAMPLE_PROJECT_JSON)
#   footprints_kicad.txt       ->  footprints_kicad.js (window.KICAD_FOOTPRINTS_TEXT)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8NoBom = New-Object System.Text.UTF8Encoding $false   # no byte-order mark

function Convert-ToJsData {
    param([string]$Source, [string]$Dest, [string]$VarName)

    if (-not (Test-Path -LiteralPath $Source)) {
        Write-Warning "Source not found, skipped: $Source"
        return
    }
    # read the raw file text and encode it as a JavaScript string literal, exactly
    # like JSON.stringify of the text would. ConvertTo-Json on a string returns a
    # quoted, escaped JSON string, which is also a valid JS string literal.
    $text    = [System.IO.File]::ReadAllText($Source)
    $literal = $text | ConvertTo-Json
    $js      = "$VarName=$literal;"
    [System.IO.File]::WriteAllText($Dest, $js, $utf8NoBom)
    $kb = [math]::Round((Get-Item -LiteralPath $Dest).Length / 1KB)
    Write-Host ("Wrote {0}  ({1} KB)" -f (Split-Path -Leaf $Dest), $kb)
}

Convert-ToJsData `
    -Source (Join-Path $root "sampleproject.pcbrev.json") `
    -Dest   (Join-Path $root "sampleproject.js") `
    -VarName "window.SAMPLE_PROJECT_JSON"

Convert-ToJsData `
    -Source (Join-Path $root "footprints_kicad.txt") `
    -Dest   (Join-Path $root "footprints_kicad.js") `
    -VarName "window.KICAD_FOOTPRINTS_TEXT"

Write-Host "Done."
