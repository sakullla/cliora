import fs from 'node:fs';
import path from 'node:path';
const fixtureRoot=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const result={kind:'harmless-terminal-fixture',recordedAt:new Date().toISOString(),cwd:process.cwd(),args:process.argv.slice(2),pid:process.pid,parentPid:process.ppid,shellPid:Number(process.env.CLIORA_VERIFICATION_SHELL_PID),marker:process.env.CLIORA_VERIFICATION_MARKER};
fs.writeFileSync(path.join(fixtureRoot,'launch-'+Date.now()+'.json'),JSON.stringify(result,null,2));
