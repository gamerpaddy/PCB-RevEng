@echo off
REM Regenerates sampleproject.js and footprints_kicad.js from their source files.
REM Double-click this, or run it after editing sampleproject.pcbrev.json.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-sample-data.ps1"
pause
