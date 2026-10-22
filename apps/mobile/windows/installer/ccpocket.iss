; Inno Setup script for the CC Pocket Windows desktop app (fork dmitry575/ccpocket).
; Compiled by .github/workflows/windows-installer.yml:
;   ISCC.exe /DAppVersion=1.145.4 /DSourceDir=<flutter Release dir> /DVCRedist=<path to vc_redist.x64.exe> ccpocket.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\windows\x64\runner\Release"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\build\windows\installer"
#endif

#define AppName "CC Pocket"
#define AppExeName "ccpocket.exe"
#define AppPublisher "CC Pocket (fork dmitry575/ccpocket, upstream K9i-0/ccpocket, MIT)"
#define AppURL "https://github.com/dmitry575/ccpocket"

[Setup]
; Stable id so upgrades replace the previous install instead of creating a second one.
AppId={{7E1D0D1E-6B1A-4C2E-9D8B-3F5A2C9E7B10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
; Per-user install by default (no UAC prompt); the user can still choose "for all users".
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=CC-Pocket-Setup-x64-v{#AppVersion}
SetupIconFile=..\runner\resources\app_icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef VCRedist
Source: "{#VCRedist}"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: VCRedistNeedsInstall
#endif

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
#ifdef VCRedist
Filename: "{tmp}\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Microsoft Visual C++ runtime..."; Check: VCRedistNeedsInstall; Flags: waituntilterminated
#endif
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
// Flutter Windows apps need the Microsoft Visual C++ 2015-2022 x64 runtime.
// Skip the bundled redistributable when a current runtime is already installed.
function VCRedistNeedsInstall: Boolean;
var
  Installed: Cardinal;
begin
  Result := True;
  if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) then
    Result := (Installed <> 1);
end;
