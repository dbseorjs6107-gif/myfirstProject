Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strFolder = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /c cd /d """ & strFolder & """ && node server.js", 0, False
WScript.Sleep 3000
WshShell.Run "chrome http://localhost:3000"