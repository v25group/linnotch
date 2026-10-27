# Builds the release binaries and the installer: installer\Output\linnotch-<version>-setup.exe
# plus its .sha256 and the updater signature .sig (upload all three to the GitHub release).
# Run from anywhere: powershell -File installer\build.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version          # 0.1.0-alpha.1
$cargo = Select-String -Path src-tauri\Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1
if ($cargo.Matches[0].Groups[1].Value -ne $version) { throw "package.json ($version) and Cargo.toml ($($cargo.Matches[0].Groups[1].Value)) versions differ" }
# Windows file versions are four numbers, and must keep rising from stage to stage:
# 0.1.0-alpha.4 -> 0.1.0.4, 0.1.0-beta.1 -> 0.1.0.101, 0.1.0-rc.2 -> 0.1.0.202, 0.1.0 -> 0.1.0.999
$core = ($version -split '-')[0]
$build = if ($version -match '-(alpha|beta|rc)\.(\d+)$') { @{ alpha = 0; beta = 100; rc = 200 }[$Matches[1]] + [int]$Matches[2] }
  elseif ($version -match '-') { throw "Unknown pre-release in $version (use alpha.N, beta.N or rc.N)" }
  else { 999 }
$fileVersion = "$core.$build"

Write-Host "Building linnotch $version ($fileVersion)" -ForegroundColor Cyan
npm run tauri build -- --no-bundle
if ($LASTEXITCODE) { throw "tauri build failed" }
cargo build --release --manifest-path src-tauri\Cargo.toml --bin notch --bin notch-hook
if ($LASTEXITCODE) { throw "building notch failed" }

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 not found: winget install JRSoftware.InnoSetup" }
& $iscc "/DAppVersion=$version" "/DFileVersion=$fileVersion" installer\linnotch.iss
if ($LASTEXITCODE) { throw "Inno Setup failed" }

$setup = Get-Item "installer\Output\linnotch-$version-setup.exe"
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash
"$hash  $($setup.Name)" | Out-File "installer\Output\linnotch-$version-setup.exe.sha256" -Encoding ascii

# The in-app updater installs only setups signed with this key (public half in src-tauri/src/update.rs).
# Upload the .sig next to the setup on the GitHub release. Override the key path with LINNOTCH_SIGNING_KEY.
$key = if ($env:LINNOTCH_SIGNING_KEY) { $env:LINNOTCH_SIGNING_KEY } else { "$env:USERPROFILE\.tauri\linnotch.key" }
if (-not (Test-Path $key)) { throw "Signing key not found at $key; updates can't be published without it" }
npx tauri signer sign -f $key "--password=$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD" $setup.FullName
if ($LASTEXITCODE) { throw "signing the setup failed" }
Write-Host "Done: $($setup.FullName) ($([math]::Round($setup.Length / 1MB, 1)) MB)" -ForegroundColor Green
Write-Host "SHA-256: $hash"
