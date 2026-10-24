# Builds the release binaries and the installer: installer\Output\linnotch-<version>-setup.exe
# Run from anywhere: powershell -File installer\build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version          # 0.1.0-alpha.1
$cargo = Select-String -Path src-tauri\Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1
if ($cargo.Matches[0].Groups[1].Value -ne $version) { throw "package.json ($version) and Cargo.toml ($($cargo.Matches[0].Groups[1].Value)) versions differ" }
# Windows file versions are four numbers: 0.1.0-alpha.1 -> 0.1.0.1
$parts = $version -split '[.-]' | Where-Object { $_ -match '^\d+$' }
$fileVersion = (($parts + @(0, 0, 0, 0))[0..3]) -join '.'

Write-Host "Building linnotch $version ($fileVersion)" -ForegroundColor Cyan
npm run tauri build -- --no-bundle
if ($LASTEXITCODE) { throw "tauri build failed" }
cargo build --release --manifest-path src-tauri\Cargo.toml --bin notch
if ($LASTEXITCODE) { throw "building notch failed" }

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found: winget install JRSoftware.InnoSetup" }
& $iscc "/DAppVersion=$version" "/DFileVersion=$fileVersion" installer\linnotch.iss
if ($LASTEXITCODE) { throw "Inno Setup failed" }

$setup = Get-Item "installer\Output\linnotch-$version-setup.exe"
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash
"$hash  $($setup.Name)" | Out-File "installer\Output\linnotch-$version-setup.exe.sha256" -Encoding ascii
Write-Host "Done: $($setup.FullName) ($([math]::Round($setup.Length / 1MB, 1)) MB)" -ForegroundColor Green
Write-Host "SHA-256: $hash"
