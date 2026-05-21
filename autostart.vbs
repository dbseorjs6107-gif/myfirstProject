Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strFolder = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /c cd /d """ & strFolder & """ && node server.js", 0, False