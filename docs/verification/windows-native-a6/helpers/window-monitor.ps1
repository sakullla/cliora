Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class ClioraWindowMonitor {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct Rect{public int left,top,right,bottom;}
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr l);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights,bool inherit,uint pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int cls,ref PBI info,int size,out int len);
 [StructLayout(LayoutKind.Sequential)] struct PBI{public IntPtr r0,peb,r1,r2,pid,parent;}
 public class Event{public long handle; public uint pid; public string cls; public bool owned; public uint[] ancestry;public string at;}
 static HashSet<long> seen=new HashSet<long>();static List<Event> events=new List<Event>();static volatile bool active; static uint owner;static Thread thread;
 static uint Parent(uint id){IntPtr h=OpenProcess(0x1000,false,id);if(h==IntPtr.Zero)return 0;try{PBI i=new PBI();int len;return NtQueryInformationProcess(h,0,ref i,Marshal.SizeOf(typeof(PBI)),out len)==0?(uint)i.parent.ToInt64():0;}finally{CloseHandle(h);}}
 static void Sample(bool baseline){EnumWindows((h,l)=>{if(!IsWindowVisible(h))return true;StringBuilder s=new StringBuilder(256);GetClassName(h,s,256);string cls=s.ToString();if(cls!="ConsoleWindowClass"&&cls!="CASCADIA_HOSTING_WINDOW_CLASS")return true;long handle=h.ToInt64();if(!seen.Add(handle)||baseline)return true;uint id;GetWindowThreadProcessId(h,out id);List<uint> parents=new List<uint>();uint current=id;bool owned=false;for(int j=0;j<12&&current!=0;j++){parents.Add(current);if(current==owner){owned=true;break;}uint next=Parent(current);if(next==current)break;current=next;}lock(events){events.Add(new Event{handle=handle,pid=id,cls=cls,owned=owned,ancestry=parents.ToArray(),at=DateTime.UtcNow.ToString("o")});}return true;},IntPtr.Zero);}
 public static void Start(uint pid){owner=pid;seen.Clear();events.Clear();Sample(true);active=true;thread=new Thread(()=>{while(active){Sample(false);Thread.Sleep(10);}});thread.IsBackground=true;thread.Start();}
 public static Event[] Stop(){active=false;if(thread!=null)thread.Join();lock(events){return events.ToArray();}}
}
"@

