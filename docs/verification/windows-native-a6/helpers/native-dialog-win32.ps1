param([int]$WindowProcessId,[ValidateSet('Inspect','Save','OpenFile','ChooseDirectory','Cancel','Accept')][string]$Action='Inspect',[string]$TargetPath)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class ClioraNativeDialog {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p,EnumProc fn,IntPtr l);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string l);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static string Class(IntPtr h){StringBuilder s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString();}
 public static string Text(IntPtr h){StringBuilder s=new StringBuilder(256);GetWindowText(h,s,256);return s.ToString();}
 public static int Id(IntPtr h){return GetDlgCtrlID(h);}
 public static IntPtr[] Find(uint owner){List<IntPtr> r=new List<IntPtr>();EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==owner&&IsWindowVisible(h)&&Class(h)=="#32770")r.Add(h);return true;},IntPtr.Zero);return r.ToArray();}
 public static IntPtr[] Controls(IntPtr root){List<IntPtr> r=new List<IntPtr>();EnumChildWindows(root,(h,l)=>{string c=Class(h);if(IsWindowVisible(h)&&(c=="Edit"||c=="Button"))r.Add(h);return true;},IntPtr.Zero);return r.ToArray();}
}
"@
$ownedDialogProcess=Get-Process -Id $WindowProcessId -ErrorAction Stop
if($ownedDialogProcess.ProcessName -notlike 'cliora*'){throw 'Expected owned Cliora process'}
$dialogDeadline=[DateTime]::UtcNow.AddSeconds(15)
$handles=@()
while([DateTime]::UtcNow -lt $dialogDeadline){$handles=@([ClioraNativeDialog]::Find([uint32]$WindowProcessId));if($handles.Count -eq 1){break};Start-Sleep -Milliseconds 100}
if($handles.Count -ne 1){throw 'Expected exactly one owned visible dialog'}
$dialogHandle=$handles[0]
$dialogTitle=[ClioraNativeDialog]::Text($dialogHandle)
$controls=@([ClioraNativeDialog]::Controls($dialogHandle))
if($Action -eq 'Inspect'){
 [ordered]@{pid=$WindowProcessId;title=$dialogTitle;controls=@($controls|ForEach-Object{[ordered]@{handle=$_.ToInt64();class=[ClioraNativeDialog]::Class($_);id=[ClioraNativeDialog]::Id($_);label=if([ClioraNativeDialog]::Class($_) -eq 'Button'){[ClioraNativeDialog]::Text($_)}else{'[edit content omitted]'}}})}|ConvertTo-Json -Depth 5
 exit 0
}
$buttonId=if($Action -eq 'Cancel'){2}else{1}
$dialogButton=$controls|Where-Object{[ClioraNativeDialog]::Class($_) -eq 'Button' -and [ClioraNativeDialog]::Id($_) -eq $buttonId}|Select-Object -First 1
if(-not $dialogButton){throw 'Expected owned action button'}
if($Action -eq 'Accept' -and @($controls|Where-Object{[ClioraNativeDialog]::Class($_) -eq 'Edit'}).Count -gt 0){throw 'Accept is restricted to a confirmation without text inputs'}
if($Action -notin @('Cancel','Accept')){
 $verificationRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Temp\cliora-native-verification'))
 $resolvedTarget=[IO.Path]::GetFullPath($TargetPath)
 if(-not $resolvedTarget.StartsWith($verificationRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Target must stay within named verification directory'}
 $editId=if($Action -eq 'ChooseDirectory'){1152}elseif($Action -eq 'OpenFile'){1148}else{1001}
 $fileNameEdit=$controls|Where-Object{[ClioraNativeDialog]::Class($_) -eq 'Edit' -and [ClioraNativeDialog]::Id($_) -eq $editId}|Select-Object -First 1
 if(-not $fileNameEdit){throw 'Expected owned filename edit'}
 [void][ClioraNativeDialog]::SendMessage($fileNameEdit,12,[IntPtr]::Zero,$resolvedTarget)
}
[void][ClioraNativeDialog]::PostMessage($dialogButton,245,[IntPtr]::Zero,[IntPtr]::Zero)
[ordered]@{pid=$WindowProcessId;title=$dialogTitle;action=$Action;path=$TargetPath}|ConvertTo-Json -Compress

