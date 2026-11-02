; ReelFetch Windows setup (Inno Setup 6). Built by scripts/release.mjs:
;   ISCC /DAppVersion=1.2.0 /DExtensionId=... /DUpdateBase=https://... /DSrcDir=..\dist\chrome /DOutDir=..\release reelfetch.iss
; Per-user install, no admin rights: copies the unpacked extension, registers the updater
; (native messaging host) for Chrome, Edge, Brave and Chromium, then walks the user through
; the one-time "Load unpacked" step (browsers do not allow installing it silently).

#define AppName "ReelFetch"
#define HostName "app.reelfetch.updater"

[Setup]
AppId={{8F3C2A51-6D0E-4B7A-9A1F-3E5D2C7B9A40}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=ReelFetch
AppPublisherURL={#UpdateBase}
AppUpdatesURL={#UpdateBase}
DefaultDirName={localappdata}\ReelFetch
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=ReelFetch-Setup-{#AppVersion}
SetupIconFile=reelfetch.ico
UninstallDisplayIcon={app}\reelfetch.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardSizePercent=110
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Files]
; The browser keeps no lock on unpacked extension files, so an upgrade can simply overwrite them.
Source: "{#SrcDir}\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "updater.ps1"; DestDir: "{app}\updater"; Flags: ignoreversion
Source: "updater.cmd"; DestDir: "{app}\updater"; Flags: ignoreversion
Source: "reelfetch.ico"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\updater\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\updater\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\updater\{#HostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueData: "{app}\updater\{#HostName}.json"; Flags: uninsdeletekey

[UninstallDelete]
Type: files; Name: "{app}\updater\{#HostName}.json"
Type: files; Name: "{app}\updater\config.json"
Type: filesandordirs; Name: "{app}\extension"

[Run]
Filename: "{code:BrowserExe}"; Parameters: "{code:BrowserExtensionsUrl}"; Description: "{cm:OpenBrowser}"; Flags: postinstall nowait skipifsilent; Check: HasBrowser
Filename: "{win}\explorer.exe"; Parameters: """{app}\extension"""; Description: "{cm:OpenFolder}"; Flags: postinstall nowait skipifsilent unchecked

[CustomMessages]
en.OpenBrowser=Open the browser's extensions page now
de.OpenBrowser=Erweiterungsseite des Browsers jetzt öffnen
en.OpenFolder=Show the extension folder
de.OpenFolder=Erweiterungsordner anzeigen
en.StepsTitle=One last step in your browser
de.StepsTitle=Ein letzter Schritt im Browser
en.StepsSub=Browsers only accept extensions from outside their store after you confirm it once.
de.StepsSub=Browser akzeptieren Erweiterungen außerhalb ihres Stores erst nach einer einmaligen Bestätigung.
en.Steps=1.  On the extensions page that opens, switch on "Developer mode" (top right).%n%n2.  Click "Load unpacked".%n%n3.  Paste this folder into the address bar of the dialog (it is already on your clipboard) and click "Select folder":%n%n      %1%n%n4.  Pin ReelFetch with the puzzle icon in the toolbar.%n%nThat's it. Already installed? Nothing to do: the new version is in place. Future updates install themselves.
de.Steps=1.  Auf der Erweiterungsseite, die sich öffnet, oben rechts den „Entwicklermodus“ einschalten.%n%n2.  Auf „Entpackte Erweiterung laden“ klicken.%n%n3.  Diesen Ordner in die Adresszeile des Dialogs einfügen (er ist bereits in der Zwischenablage) und „Ordner auswählen“ klicken:%n%n      %1%n%n4.  ReelFetch über das Puzzle-Symbol in der Symbolleiste anheften.%n%nFertig. Schon installiert? Dann ist nichts zu tun: Die neue Version ist bereits da. Künftige Updates installieren sich selbst.

[Code]
var
  StepsPage: TOutputMsgWizardPage;

function JsonPath(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '\', '\\', True);
end;

function AppPath(const Exe: String): String;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + Exe, '', Result) then
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + Exe, '', Result);
  Result := RemoveQuotes(Result);
  if (Result <> '') and not FileExists(Result) then Result := '';
end;

{ Prefer Chrome, then Edge, then Brave. }
function BrowserExe(Param: String): String;
begin
  Result := AppPath('chrome.exe');
  if Result = '' then Result := AppPath('msedge.exe');
  if Result = '' then Result := AppPath('brave.exe');
end;

function HasBrowser: Boolean;
begin
  Result := BrowserExe('') <> '';
end;

function BrowserExtensionsUrl(Param: String): String;
begin
  if Pos('msedge.exe', Lowercase(BrowserExe(''))) > 0 then Result := 'edge://extensions'
  else Result := 'chrome://extensions';
end;

procedure InitializeWizard;
begin
  StepsPage := CreateOutputMsgPage(wpInstalling, ExpandConstant('{cm:StepsTitle}'), ExpandConstant('{cm:StepsSub}'),
    FmtMessage(ExpandConstant('{cm:Steps}'), [ExpandConstant('{localappdata}\ReelFetch\extension')]));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Dir, Host: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  Dir := ExpandConstant('{app}');
  Host := '{"name":"{#HostName}","description":"ReelFetch updater","path":"' + JsonPath(Dir + '\updater\updater.cmd') +
    '","type":"stdio","allowed_origins":["chrome-extension://{#ExtensionId}/"]}';
  SaveStringToFile(Dir + '\updater\{#HostName}.json', Host, False);
  SaveStringToFile(Dir + '\updater\config.json',
    '{"base":"{#UpdateBase}","extensionDir":"' + JsonPath(Dir + '\extension') + '"}', False);
  { The "Load unpacked" dialog accepts a pasted path. }
  Exec('powershell.exe', '-NoProfile -Command "Set-Clipboard -Value ''' + Dir + '\extension''"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
