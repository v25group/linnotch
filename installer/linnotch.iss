; linnotch installer (Inno Setup 6). Build with installer\build.ps1, which compiles the release
; binaries first and passes the version in. Installs per user (no admin), adds a Start menu entry,
; can start linnotch at sign-in, and installs WebView2 if it's missing.

#ifndef AppVersion
  #define AppVersion "0.1.0-beta.1"
#endif
#ifndef FileVersion
  #define FileVersion "0.1.0.101"
#endif
#define AppName "linnotch"
#define AppExe "linnotch.exe"
#define Publisher "V25Group"
#define PublisherFull "Venticinque Aeyon Groupe"
#define Website "https://www.v25group.com/"
#define Repo "https://github.com/v25group/linnotch"
#define Bin "..\src-tauri\target\release"

[Setup]
; Never change AppId: Windows uses it to recognise upgrades and the uninstaller.
AppId={{8C4F2E1A-6B7D-4E59-9A3C-25B6E0D1F7A4}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#Publisher} ({#PublisherFull})
AppPublisherURL={#Website}
AppSupportURL={#Repo}/issues
AppUpdatesURL={#Repo}/releases
AppCopyright=© 2026 {#PublisherFull} ({#Publisher})
VersionInfoVersion={#FileVersion}
VersionInfoCompany={#Publisher}
VersionInfoDescription={#AppName} setup
VersionInfoProductName={#AppName}
VersionInfoProductTextVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
LicenseFile=..\LICENSE
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardSizePercent=100
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=Output
OutputBaseFilename={#AppName}-{#AppVersion}-setup
; A running linnotch is stopped in PrepareToInstall below, before its files are replaced.
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startup"; Description: "Start linnotch when I sign in to Windows"; GroupDescription: "Options:"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "{#Bin}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
; The `notch` command for the Developer tab (its Set up button puts it on PATH).
Source: "{#Bin}\notch.exe"; DestDir: "{app}"; Flags: ignoreversion
; What Claude Code's hooks run: `notch hook` without a console window (no terminal flashing).
Source: "{#Bin}\notch-hook.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "A Dynamic Island for Windows"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; The same value the tray's "Start with Windows" switch reads and writes.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"""; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start linnotch now"; Flags: nowait postinstall skipifsilent
; The in-app updater (src-tauri/src/update.rs) installs silently with /UPDATE: start the new version.
Filename: "{app}\{#AppExe}"; Flags: nowait; Check: IsUpdate

[UninstallRun]
; Stop it, then undo what the Developer tab set up (PATH entry, shell profiles, Claude Code hooks)
; and the start-with-Windows value. Notes in Documents\linnotch are left alone.
Filename: "{sys}\taskkill.exe"; Parameters: "/im {#AppExe} /f"; Flags: runhidden; RunOnceId: "StopLinnotch"
Filename: "{app}\{#AppExe}"; Parameters: "--cleanup"; Flags: runhidden waituntilterminated; RunOnceId: "CleanupLinnotch"

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\linnotch"
Type: filesandordirs; Name: "{localappdata}\com.linnotch.app"
Type: dirifempty; Name: "{localappdata}\linnotch"

[Code]
const
  WebView2Guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  DownloadPage: TDownloadWizardPage;

function IsUpdate(): Boolean;
begin
  Result := Pos('/UPDATE', Uppercase(GetCmdTail)) > 0;
end;

function HasWebView2(): Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2Guid, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2Guid, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), 'Getting Microsoft Edge WebView2, which linnotch needs…', nil);
end;

// Upgrading while linnotch runs: stop it first, or its exe can't be replaced. The new one starts
// again from the last page.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/im linnotch.exe /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// WebView2 ships with Windows 11; older Windows 10 PCs may need it. Download Microsoft's small
// bootstrapper and let it install the runtime.
function NextButtonClick(CurPageID: Integer): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  if (CurPageID = wpReady) and not HasWebView2() then
  begin
    DownloadPage.Clear;
    DownloadPage.Add(WebView2Url, 'MicrosoftEdgeWebview2Setup.exe', '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
        if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or not HasWebView2() then
          MsgBox('WebView2 couldn''t be installed. linnotch needs it to run: get it from https://developer.microsoft.com/microsoft-edge/webview2/', mbError, MB_OK);
      except
        MsgBox('WebView2 couldn''t be downloaded (' + GetExceptionMessage + '). linnotch needs it to run: get it from https://developer.microsoft.com/microsoft-edge/webview2/', mbError, MB_OK);
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;
