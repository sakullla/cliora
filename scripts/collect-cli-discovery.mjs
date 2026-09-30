import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
if(process.platform !== 'win32') throw new Error('Run this discovery script on the Windows host.');
const root=fileURLToPath(new URL('../',import.meta.url));
const observed=[];
const host=spawnSync('powershell',['-NoProfile','-Command','Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture | ConvertTo-Json -Compress'],{encoding:'utf8'});
const architecture=spawnSync('powershell',['-NoProfile','-Command','[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()'],{encoding:'utf8'});
const now=new Date().toISOString();
for(const [tool,command] of [['codex','codex'],['claude_code','claude'],['grok','grok'],['pi','pi'],['open_code','opencode']]){
 const result=spawnSync('powershell',['-NoProfile','-Command',`${command} --version`],{encoding:'utf8',timeout:20000});
 if(result.status!==0)throw new Error(`${command}: ${result.stderr}`);
 const text=result.stdout.trim();const version=text.match(/\d+\.\d+\.\d+/)?.[0];if(!version)throw new Error(`No version: ${text}`);
 observed.push({tool,version,command:`${command} --version`,exitCode:result.status,stdout:text});
}
const discovery={kind:'cli-version-discovery',recordedAt:now,host:JSON.parse(host.stdout),architecture:architecture.stdout.trim(),observations:observed,limits:'Version output only. Native apply, launch/resume, tray, resources, history and portable restore on actual platforms have not been observed by this script.'};
fs.writeFileSync(root+'docs/verification/platform/windows-discovery.json',JSON.stringify(discovery,null,2)+'\n');
console.log(JSON.stringify(discovery,null,2));
