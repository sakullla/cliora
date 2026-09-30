import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const result={kind:'harmless-terminal-color-fixture',recordedAt:new Date().toISOString(),cwd:process.cwd(),args:process.argv.slice(2),pid:process.pid,parentPid:process.ppid,shellPid:Number(process.env.CLIORA_VERIFICATION_SHELL_PID),marker:process.env.CLIORA_VERIFICATION_MARKER,
  stdoutIsTTY:process.stdout.isTTY??false,stdinIsTTY:process.stdin.isTTY??false,stderrIsTTY:process.stderr.isTTY??false,
  colorDepth:process.stdout.getColorDepth?.()??0,hasColors:process.stdout.hasColors?.()??false,
  environment:Object.fromEntries(['NO_COLOR','TERM','COLORTERM','FORCE_COLOR','WT_SESSION'].map(name=>[name,name==='WT_SESSION'?Boolean(process.env[name]):process.env[name]??null]))};
process.stdout.write('\u001b[38;2;216;118;86mCliora terminal color verification\u001b[0m\n');
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'color-launch-'+Date.now()+'.json'),JSON.stringify(result,null,2));
