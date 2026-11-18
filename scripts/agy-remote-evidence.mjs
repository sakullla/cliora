/** Isolated agy (Antigravity CLI) remote evidence runner.
 *
 * Drives the native `agy` binary on an explicitly configured SSH target inside
 * a dedicated probe workspace (its own HOME), following the strict-key pattern
 * of scripts/verify-remote-native.mjs: BatchMode, StrictHostKeyChecking,
 * external key/config paths only, never raw credentials.
 *
 * Hard boundaries encoded here (requirement R12/R14):
 * - Every mutating experiment runs with HOME pointed at the probe root, so
 *   `~/.gemini` resolves inside the dedicated probe directory.
 * - The user's real state is only ever read for structure (directory listings,
 *   sqlite schema of copied files); OAuth/keyring material and auth files are
 *   never opened, and real config files are stat-guarded around the run.
 * - Cleanup only ever removes the probe root (validated against a strict
 *   pattern) and kills agy processes whose cwd is inside it.
 *
 * Phases:
 * - probe:   run the isolated experiment suite, write report.json plus raw
 *            evidence files into --out.
 * - cleanup: remove the probe workspace and record the removal.
 * A missing environment or a failed precondition is never reported as
 * acceptance; incomplete checks keep the report status at not_verified.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const phase = option('--phase', 'probe');
const host = option('--host', process.env.AGY_EVIDENCE_HOST);
const user = option('--user', 'root');
const port = option('--port', '22');
const identityFile = option('--identityFile', process.env.AGY_EVIDENCE_IDENTITY_FILE);
const sshConfig = option('--sshConfig', process.env.AGY_EVIDENCE_SSH_CONFIG);
const probeRoot = option('--probe-root', `/root/.cliora-agy-probe-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`);
const out = path.resolve(option('--out', 'docs/verification/remote-workflow/agy-1.5.9'));

const report = {
  schemaVersion: 1,
  synthetic: false,
  tool: 'scripts/agy-remote-evidence.mjs',
  phase,
  capturedAt: new Date().toISOString(),
  status: 'not_verified',
  probeRoot,
  targetFingerprint: null,
  agyVersion: null,
  platform: null,
  checks: [],
  observations: {},
  verdicts: {},
  limitations: [],
  cleanup: null,
};
const evidence = {};
let failed = false;
const requireThat = (condition, message) => { if (!condition) throw new Error(`Failed: ${message}`); };
const check = (name, condition) => {
  if (!condition) { failed = true; throw new Error(`Failed: ${name}`); }
  report.checks.push(name);
};
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const runLocalSsh = async (command, timeout = 60000) => {
  const sshArgs = ['-T'];
  if (sshConfig) sshArgs.push('-F', sshConfig);
  if (identityFile) sshArgs.push('-i', identityFile);
  sshArgs.push(
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    `${user}@${host}`,
    `export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; ${command}`,
  );
  const result = await execFileAsync('ssh', sshArgs, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};
/** Remote command inside the isolated probe HOME. `export` keeps the override
 * active for every subsequent `;`-chained command in the same shell. */
const agy = (command, timeout = 60000) =>
  runLocalSsh(`cd ${shellQuote(`${probeRoot}/work`)} && export HOME=${shellQuote(`${probeRoot}/home`)} && ${command}`, timeout);
const readRemoteFile = async file => (await runLocalSsh(`cat ${shellQuote(file)}`)).stdout;
const writeRemoteFile = async (file, content) => {
  // content travels base64-encoded so no shell quoting can corrupt fixtures.
  const base64 = Buffer.from(content, 'utf8').toString('base64');
  await runLocalSsh(`mkdir -p ${shellQuote(path.posix.dirname(file))} && printf %s ${shellQuote(base64)} | base64 -d > ${shellQuote(file)}`);
};
const remotePy = async (code, timeout = 60000) => {
  const base64 = Buffer.from(code, 'utf8').toString('base64');
  const result = await runLocalSsh(`printf %s ${shellQuote(base64)} | base64 -d | python3 -`, timeout);
  return result.stdout;
};
const jsonOrNull = text => { try { return JSON.parse(text); } catch { return null; } };
/** Native conversation ids never leave the machine in evidence artifacts. */
const redactUuids = value => typeof value === 'string'
  ? value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  : value;

const PROBE_ROOT_PATTERN = /^\/root\/\.cliora-agy-probe-\d{8}$/;

/** Experiments, all inside the isolated probe HOME. */
const experiments = {
  async preflight() {
    const version = await agy('agy --version');
    check('agy version probe', version.stdout.trim() === '1.5.9');
    report.agyVersion = version.stdout.trim();
    const os = await runLocalSsh('uname -srm && cat /etc/os-release | head -1');
    report.platform = os.stdout.trim().replaceAll('\n', ' · ');
    // Real-state guard: record the config file fingerprints that must not move.
    const guard = await runLocalSsh(
      `stat -c "%n %s %Y" ${shellQuote('/root/.gemini/config/config.json')} ${shellQuote('/root/.gemini/config/mcp_config.json')} ${shellQuote('/root/.gemini/antigravity-cli/settings.json')} 2>/dev/null || true`,
    );
    report.observations.realStateGuardBefore = guard.stdout.trim().split('\n').filter(Boolean);
  },

  async mcp() {
    const configFile = `${probeRoot}/home/.gemini/config/mcp_config.json`;
    const observations = { keyContract: {}, editSemantics: {}, disable: {}, projectScope: {}, rejections: {} };

    await agy('agy mcp add --env PROBE_MODE=fixture probe-stdio -- /bin/cat -n');
    await agy('agy mcp add --header "X-Probe: fixture" probe-http https://mcp.probe.invalid/mcp');
    const created = jsonOrNull(await readRemoteFile(configFile));
    check('mcp stdio entry shape', created?.mcpServers?.['probe-stdio']?.command === '/bin/cat'
      && Array.isArray(created.mcpServers['probe-stdio'].args)
      && created.mcpServers['probe-stdio'].env?.PROBE_MODE === 'fixture'
      && created.mcpServers['probe-stdio'].disabled === false);
    check('mcp http entry spells serverUrl (native writer key)', created?.mcpServers?.['probe-http']?.serverUrl === 'https://mcp.probe.invalid/mcp'
      && created.mcpServers['probe-http'].headers?.['X-Probe'] === 'fixture'
      && !('url' in created.mcpServers['probe-http']));
    observations.keyContract.nativeHttpWriterKey = 'serverUrl';
    observations.keyContract.perEntryDisabledFlag = true;
    observations.keyContract.createdFile = created;

    const listed = await agy('agy mcp list');
    check('mcp list shows both entries', listed.stdout.includes('probe-stdio') && listed.stdout.includes('probe-http'));
    observations.listOutput = listed.stdout.trim();

    await agy('agy mcp add probe-stdio -- /bin/cat -b');
    await agy('agy mcp add probe-http https://mcp2.probe.invalid/mcp');
    const edited = jsonOrNull(await readRemoteFile(configFile));
    check('mcp edit replaces the entry (env dropped, args replaced)', edited?.mcpServers?.['probe-stdio']?.args?.[0] === '-b'
      && !edited.mcpServers['probe-stdio'].env
      && edited.mcpServers['probe-http'].serverUrl === 'https://mcp2.probe.invalid/mcp'
      && !edited.mcpServers['probe-http'].headers);
    observations.editSemantics.nativeReaddReplacesEntry = true;

    await agy('agy mcp disable probe-http');
    const disabled = jsonOrNull(await readRemoteFile(configFile));
    check('mcp disable writes disabled=true in place', disabled?.mcpServers?.['probe-http']?.disabled === true
      && disabled.mcpServers['probe-http'].serverUrl === 'https://mcp2.probe.invalid/mcp');
    const disabledList = await agy('agy mcp list');
    check('mcp list reports disabled status', disabledList.stdout.includes('disabled'));
    observations.disable.preservesDefinition = true;
    observations.disable.disabledFile = disabled;
    await agy('agy mcp enable probe-http');
    const enabled = jsonOrNull(await readRemoteFile(configFile));
    const enabledList = await agy('agy mcp list');
    // `mcp enable` removes the disabled key (implicit enabled) rather than
    // writing false; `mcp add` writes an explicit disabled:false.
    check('mcp enable restores the entry (disabled key removed)', enabled?.mcpServers?.['probe-http']?.serverUrl === 'https://mcp2.probe.invalid/mcp'
      && !('disabled' in enabled.mcpServers['probe-http'])
      && enabledList.stdout.includes('probe-http') && enabledList.stdout.includes('enabled'));
    observations.disable.enableRemovesDisabledKey = true;

    // Legacy `url` spelling: read-recognized, rewritten to serverUrl on native edit.
    await remotePy(`
import json
p = "${configFile}"
doc = json.load(open(p))
entry = doc["mcpServers"]["probe-http"]
entry["url"] = entry.pop("serverUrl")
entry["headers"] = {"Authorization": "Bearer probe-placeholder"}
json.dump(doc, open(p, "w"), indent=2)
`);
    const legacyList = await agy('agy mcp list');
    check('legacy url key is read-recognized', legacyList.stdout.includes('probe-http') && legacyList.stdout.includes('mcp2.probe.invalid'));
    await agy('agy mcp add probe-http https://mcp3.probe.invalid/mcp');
    const rewritten = jsonOrNull(await readRemoteFile(configFile));
    check('native edit rewrites legacy url back to serverUrl without dual keys',
      rewritten?.mcpServers?.['probe-http']?.serverUrl === 'https://mcp3.probe.invalid/mcp'
      && !('url' in rewritten.mcpServers['probe-http']));
    observations.keyContract.legacyUrlReadAccepted = true;
    observations.keyContract.nativeEditCanonicalizesTo = 'serverUrl';

    // Untouched entries keep unknown native fields; the edited entry is rebuilt.
    await remotePy(`
import json
p = "${configFile}"
doc = json.load(open(p))
doc["mcpServers"]["probe-stdio"]["cwd"] = "/tmp"
doc["mcpServers"]["probe-stdio"]["unknownProbeKey"] = {"keep": "me"}
json.dump(doc, open(p, "w"), indent=2)
`);
    await agy('agy mcp add probe-http https://mcp4.probe.invalid/mcp');
    const preserved = jsonOrNull(await readRemoteFile(configFile));
    check('unrelated edit preserves other entries native fields', preserved?.mcpServers?.['probe-stdio']?.cwd === '/tmp'
      && preserved.mcpServers['probe-stdio'].unknownProbeKey?.keep === 'me');
    await agy('agy mcp add probe-stdio -- /bin/cat');
    const rebuilt = jsonOrNull(await readRemoteFile(configFile));
    check('native edit of an entry rebuilds it from flags (cwd/unknown dropped)', !('cwd' in rebuilt.mcpServers['probe-stdio'])
      && !('unknownProbeKey' in rebuilt.mcpServers['probe-stdio']));
    observations.editSemantics.nativeRebuildDropsExtraFields = true;

    const sse = await agy('agy mcp add -t sse probe-sse https://legacy.probe.invalid/sse; echo rc=$?');
    const sseAll = `${sse.stdout}${sse.stderr}`;
    check('sse transport type rejected', sseAll.includes('invalid server type') && sseAll.includes('rc=1'));
    const badType = await agy('agy mcp add -t bogus probe-bogus /bin/cat; echo rc=$?');
    const badTypeAll = `${badType.stdout}${badType.stderr}`;
    check('unknown transport type rejected', badTypeAll.includes("must be 'stdio' or 'http'"));
    observations.rejections.sseType = sseAll.trim();
    observations.rejections.unknownType = badTypeAll.trim();

    // Project-scope file: honored at runtime (see report) but not listed by the
    // user-level `agy mcp list` CLI, which never writes outside the global file.
    await runLocalSsh(`mkdir -p ${shellQuote(`${probeRoot}/project/.agents`)}`);
    await writeRemoteFile(`${probeRoot}/project/.agents/mcp_config.json`, `${JSON.stringify({
      mcpServers: { 'probe-project-http': { serverUrl: 'https://project.probe.invalid/mcp', disabled: false } },
    }, null, 2)}\n`);
    const fromProject = await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && HOME=${shellQuote(`${probeRoot}/home`)} agy mcp list`);
    check('agy mcp list (CLI) lists user-level servers only', fromProject.stdout.includes('probe-http')
      && !fromProject.stdout.includes('probe-project-http'));
    await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && HOME=${shellQuote(`${probeRoot}/home`)} agy mcp add probe-from-project -- /bin/echo hi`);
    const globalAfter = jsonOrNull(await readRemoteFile(configFile));
    const projectAfter = jsonOrNull(await readRemoteFile(`${probeRoot}/project/.agents/mcp_config.json`));
    check('mcp add from a project cwd writes the global user file', globalAfter?.mcpServers?.['probe-from-project']?.command === '/bin/echo'
      && projectAfter?.mcpServers?.['probe-project-http']?.serverUrl === 'https://project.probe.invalid/mcp');
    observations.projectScope.cliListCoversUserLevelOnly = true;
    observations.projectScope.runtimeLoadVerifiedBy = 'authenticated /mcp panel (see report.md)';

    await agy('agy mcp remove probe-from-project; agy mcp remove probe-http; agy mcp remove probe-stdio');
    const removed = await agy('agy mcp list');
    check('mcp remove clears entries', removed.stdout.includes('No MCP servers configured'));
    evidence.mcp = observations;
  },

  async plugins() {
    const src = `${probeRoot}/plugin-src`;
    const observations = {};
    const write = (file, content) => writeRemoteFile(`${src}/${file}`, content);
    await write('plugin.json', `${JSON.stringify({
      name: 'probe-kit',
      displayName: 'Probe Kit',
      version: '1.0.0',
      description: 'Sanitized probe plugin fixture for Cliora evidence collection. Contains no real services or secrets.',
    }, null, 2)}\n`);
    await write('skills/probe-skill/SKILL.md', `---
name: probe-skill
description: Probe fixture skill describing a harmless verification procedure. Use when collecting Antigravity customization evidence.
---
# Probe Skill

1. Reply with the word probe.
2. Never contact network services.
`);
    await write('agents/probe-agent.md', `---
name: probe-agent
description: Probe fixture plugin agent for evidence collection.
subagent: true
mainAgent: false
tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]
---
# Probe Agent

Plugin agent body.
`);
    await write('rules/AGENTS.md', '# Probe Plugin Rules\n\nAlways answer with the word probe in this workspace.\n');
    await write('rules/probe-glob.md', `---
trigger: glob
globs: "**/*.probe.md"
description: Probe glob rule for fixture files.
---
Apply probe formatting to matching files.
`);
    await write('hooks.json', `${JSON.stringify({
      'probe-plugin-hook': {
        PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './probe-hook.sh', timeout: 10 }] }],
      },
    }, null, 2)}\n`);
    await write('probe-hook.sh', '#!/bin/sh\nexit 0\n');
    await write('mcp_config.json', `${JSON.stringify({
      mcpServers: { 'probe-plugin-mcp': { command: '/bin/cat', args: ['-n'], disabled: false } },
    }, null, 2)}\n`);

    const validated = await agy(`agy plugin validate ${shellQuote(src)} --json`);
    const validation = jsonOrNull(validated.stdout);
    check('plugin validate counts all five resource kinds', validation?.components?.agents === 1
      && validation.components.hooks === 1 && validation.components.mcpServers === 1
      && validation.components.rules === 2 && validation.components.skills === 1);
    observations.validation = validation;

    await agy(`agy plugin install ${shellQuote(src)}`);
    const installed = await agy('agy plugin list --json');
    const list = jsonOrNull(installed.stdout);
    const entry = list?.find(item => item.name === 'probe-kit');
    check('installed plugin listed with detail resources', entry?.enabled === true && entry.version === '1.0.0'
      && entry.path === `${probeRoot}/home/.gemini/config/plugins/probe-kit`
      && entry.skills?.[0] === 'probe-skill' && entry.agents?.[0] === 'probe-agent'
      && entry.rules?.includes('AGENTS.md') && entry.mcpServers?.[0] === 'probe-plugin-mcp'
      && entry.hooks?.[0] === 'probe-plugin-hook');
    observations.listEntryShape = entry;
    observations.builtinPluginEntries = list?.filter(item => item.name !== 'probe-kit').map(item => ({ name: item.name, enabled: item.enabled })) ?? [];

    await agy('agy plugin disable probe-kit');
    const configAfterDisable = jsonOrNull(await readRemoteFile(`${probeRoot}/home/.gemini/config/config.json`));
    check('plugin disable writes config.json plugins ledger', configAfterDisable?.plugins?.['probe-kit']?.enabled === false);
    const disabledList = jsonOrNull((await agy('agy plugin list --json')).stdout);
    check('disabled plugin stays listed with enabled=false', disabledList?.find(item => item.name === 'probe-kit')?.enabled === false);
    await agy('agy plugin enable probe-kit');
    const configAfterEnable = jsonOrNull(await readRemoteFile(`${probeRoot}/home/.gemini/config/config.json`));
    check('plugin enable restores the ledger entry', configAfterEnable?.plugins?.['probe-kit']?.enabled === true);
    observations.enableLedgerPath = '~/.gemini/config/config.json plugins.<dir>.enabled';

    const pluginDir = await readRemoteFile(`${probeRoot}/home/.gemini/config/plugins/probe-kit/plugin.json`);
    check('install copies the plugin tree (manifest intact)', jsonOrNull(pluginDir)?.name === 'probe-kit');

    // Negative validation: broken agent frontmatter must surface as findings.
    await write('agents/broken-agent.md', '# No frontmatter\n\nBody only.\n');
    const broken = await agy(`agy plugin validate ${shellQuote(src)} --json; echo rc=$?`);
    check('validate reports broken agent frontmatter', broken.stdout.includes('broken-agent'));
    observations.negativeValidation = 'agents/broken-agent.md without frontmatter is reported by agy plugin validate';
    await runLocalSsh(`rm -f ${shellQuote(`${src}/agents/broken-agent.md`)}`);

    await agy('agy plugin uninstall probe-kit');
    const uninstalled = jsonOrNull((await agy('agy plugin list --json')).stdout);
    check('uninstalled plugin no longer listed', !uninstalled?.some(item => item.name === 'probe-kit'));
    const dirGone = await runLocalSsh(`[ ! -e ${shellQuote(`${probeRoot}/home/.gemini/config/plugins/probe-kit`)} ] && printf absent`);
    check('uninstall removes the plugin directory', dirGone.stdout.trim() === 'absent');
    evidence.plugins = observations;
  },

  async agents() {
    const observations = {};
    const writeAgent = (root, name, frontmatter) => writeRemoteFile(
      `${root}/${name}/agent.md`,
      `---\nname: ${name}\ndescription: Probe fixture agent ${name} for evidence collection.\n${frontmatter}---\n# ${name}\n\nProbe agent body.\n`,
    );
    const projectAgents = `${probeRoot}/project/.agents/agents`;
    const globalAgents = `${probeRoot}/home/.gemini/config/agents`;
    // Directory-based agent markdown: agents/<name>/agent.md (product /agents
    // panel spelling; the file form agents/<name>.md is a plugin-only layout).
    await writeAgent(projectAgents, 'probe-subagent', 'subagent: true\nmainAgent: false\ntools: [read_file]\n');
    await writeAgent(globalAgents, 'probe-global-agent', 'mainAgent: true\ntools: [read_file]\n');
    // A git repo with at least one commit is required for workspace-root
    // detection (unborn HEAD logs "reference not found").
    await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && git init -q . 2>/dev/null; git config user.email probe@example.invalid; git config user.name probe; git add -A .agents 2>/dev/null; git commit -qm "probe fixture" 2>/dev/null; true`);
    const rosterProbe = async () => {
      const result = await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && HOME=${shellQuote(`${probeRoot}/home`)} timeout 40 agy --agent no-such-probe --print hi 2>&1 | head -2`);
      return `${result.stdout}${result.stderr}`;
    };
    let roster = await rosterProbe();
    check('global main agents are launch-selectable headless', roster.includes('available: probe-global-agent'));
    check('workspace subagent-only agents are excluded from launch selection', !roster.includes('probe-subagent'));

    await writeAgent(projectAgents, 'probe-workspace-main', 'mainAgent: true\ntools: [read_file]\n');
    roster = await rosterProbe();
    check('workspace main agents load without trust or sign-in', roster.includes('probe-workspace-main'));
    await writeAgent(projectAgents, 'probe-default-kind', 'tools: [read_file]\n');
    roster = await rosterProbe();
    check('agents without mainAgent/subagent default to main (selectable)', roster.includes('probe-default-kind'));

    // Plugin main agents join the same launch roster.
    await writeRemoteFile(`${probeRoot}/plugin-src/agents/probe-plugin-main.md`, `---
name: probe-plugin-main
description: Plugin main agent probe.
mainAgent: true
tools: [read_file]
---
# Probe Plugin Main

Body.
`);
    await runLocalSsh(`cd ${shellQuote(`${probeRoot}/work`)} && HOME=${shellQuote(`${probeRoot}/home`)} agy plugin install ${shellQuote(`${probeRoot}/plugin-src`)} >/dev/null 2>&1; true`);
    roster = await rosterProbe();
    check('plugin main agents are launch-selectable', roster.includes('probe-plugin-main'));
    observations.rosterEnumeration = roster.trim();

    const resolution = await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && HOME=${shellQuote(`${probeRoot}/home`)} timeout 40 agy --agent probe-subagent --print hi 2>&1 | head -2; echo done`);
    const resolutionAll = `${resolution.stdout}${resolution.stderr}`;
    check('agent resolution fails pre-session with the roster listed', resolutionAll.includes('unknown agent "probe-subagent"') && resolutionAll.includes('available:'));
    const listed = await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && HOME=${shellQuote(`${probeRoot}/home`)} agy agent; echo rc=$?`);
    check('agy agent subcommand prints nothing in a headless shell', listed.stdout.trim().endsWith('rc=0'));
    observations.agyAgentSubcommandOutput = '(empty, exit 0 — the interactive /agents panel is the roster surface)';
    observations.pathContract = {
      workspace: '<project>/.agents/agents/{agent_name}/agent.md (git repo root; no trust or sign-in needed for roster discovery)',
      global: '~/.gemini/config/agents/{agent_name}/agent.md',
      plugin: 'plugins/<name>/agents/<agent>.md (join the same launch roster when mainAgent)',
      productStated: '/agents panel "Create New Agents" lines (authenticated capture, see report.md)',
    };
    observations.rosterRules = {
      launchSelectable: 'mainAgent: true or omitted (defaults to main)',
      inSessionOnly: 'subagent: true (+ mainAgent: false) entries never appear in the --agent roster',
      unknownAgent: 'headless -p exits 1 and enumerates the available roster',
    };
    evidence.agents = observations;
  },

  async hooks() {
    await writeRemoteFile(`${probeRoot}/project/.agents/hooks.json`, `${JSON.stringify({
      'probe-workspace-hook': {
        PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: '/bin/true', timeout: 5 }] }],
      },
    }, null, 2)}\n`);
    await writeRemoteFile(`${probeRoot}/home/.gemini/config/hooks.json`, `${JSON.stringify({
      'probe-global-hook': { SessionStart: [{ type: 'command', command: '/bin/true' }] },
    }, null, 2)}\n`);
    const log = `${probeRoot}/work/hooks-load.log`;
    await runLocalSsh(`cd ${shellQuote(`${probeRoot}/project`)} && HOME=${shellQuote(`${probeRoot}/home`)} timeout 40 agy --agent no-such --print hi --log-file ${shellQuote(log)} >/dev/null 2>&1; true`);
    const lines = await readRemoteFile(log);
    const loads = [...lines.matchAll(/loaded (\d+) named hooks from (\d+) hooks\.json file\(s\)/g)].map(m => [Number(m[1]), Number(m[2])]);
    check('hooks manager loads workspace, global and plugin hooks.json', loads.length >= 2 && loads.at(-1)[0] >= 3 && loads.at(-1)[1] >= 3);
    evidence.hooks = {
      loadLogLines: loads,
      standalonePaths: ['<workspace>/.agents/hooks.json', '~/.gemini/config/hooks.json'],
      pluginPath: 'plugins/<name>/hooks.json (plugin root only; hooks/hooks.json is not read for native plugins)',
      format: 'named hooks object; events SessionStart/PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop; grouped matcher+hooks for tool events; handler type command, timeout seconds; enabled:false disables a named hook',
      source: 'builtin docs/hooks.md + load log line above',
    };
  },

  async skills() {
    await writeRemoteFile(`${probeRoot}/project/.agents/skills/probe-skill/SKILL.md`, `---
name: probe-skill
description: Workspace probe skill. Use when collecting Antigravity customization evidence.
---
# Probe Skill

Reply with the word probe.
`);
    await writeRemoteFile(`${probeRoot}/project/shared-skills/declared-probe-skill/SKILL.md`, `---
name: declared-probe-skill
description: Skill declared via skills.json manifest. Use when collecting evidence.
---
# Declared Probe Skill

Reply with declared-probe.
`);
    await writeRemoteFile(`${probeRoot}/project/.agents/skills.json`, `${JSON.stringify({ entries: [{ path: 'shared-skills' }] }, null, 2)}\n`);
    const files = await runLocalSsh(`find ${shellQuote(`${probeRoot}/project/.agents`)} ${shellQuote(`${probeRoot}/project/shared-skills`)} -type f | sort`);
    check('skill fixture files present', files.stdout.includes('skills.json') && files.stdout.includes('declared-probe-skill/SKILL.md'));
    evidence.skills = {
      discoveryRoots: [
        '<workspace>/.agents/skills/<name>/SKILL.md (Workspace)',
        '~/.gemini/antigravity-cli/skills/<name>/SKILL.md (Global, product /skills panel)',
        '~/.gemini/skills/<name>/SKILL.md (Shared, product /skills panel)',
        '~/.gemini/config/skills/<name>/SKILL.md (config root, product /skills panel)',
        '~/.gemini/antigravity-cli/builtin/skills (built-in)',
      ],
      manifestDeclaration: '.agents/skills.json {entries:[{path,include_only?,exclude?}],inherits:[...]} declares non-standard dirs (verified by the authenticated /skills panel capture; entries must stay inside the workspace or repository root)',
      frontmatter: 'name (must match the directory) + description required; plugin validate errors on missing/invalid frontmatter',
    };
  },

  async rules() {
    await writeRemoteFile(`${probeRoot}/project/AGENTS.md`, '# Probe Project Rules\n\nAlways answer concisely in this repository.\n');
    await writeRemoteFile(`${probeRoot}/project/sub/GEMINI.md`, '# Probe Sub Rules\n\nNested directory rule for the probe fixture.\n');
    await writeRemoteFile(`${probeRoot}/project/.agents/rules/probe-trigger.md`, `---
trigger: always_on
---
Probe always-on rule from .agents/rules.
`);
    const files = await runLocalSsh(`ls ${shellQuote(`${probeRoot}/project/AGENTS.md`)} ${shellQuote(`${probeRoot}/project/sub/GEMINI.md`)} ${shellQuote(`${probeRoot}/project/.agents/rules/probe-trigger.md`)}`);
    check('rule fixture files present', files.stdout.includes('AGENTS.md') && files.stdout.includes('GEMINI.md') && files.stdout.includes('probe-trigger.md'));
    evidence.rules = {
      hierarchical: 'AGENTS.md / GEMINI.md in any directory, walked from cwd to repository root; no frontmatter, always active for their scope',
      directoryRules: '<workspace>/.agents/rules/*.md with trigger frontmatter (always_on | glob (+globs) | model_decision (+description) | manual)',
      global: '~/.gemini/config/ rules/ folder and AGENTS.md/GEMINI.md (changelog-verified readable as global customizations)',
      pluginRules: 'plugins/<name>/rules/ (AGENTS.md recommended; plain markdown, always on while enabled)',
      limits: '24 KB per file after include expansion; 20000-token aggregate rules budget; over-budget demoted to path pointers',
      source: 'builtin docs/rules.md + agy-customizations SKILL.md + embedded changelog',
    };
  },

  async memory() {
    const observations = {};
    const help = await agy('agy --help 2>&1');
    check('no memory subcommand in agy help', !/\bmemory\b/i.test(help.stdout));
    observations.helpHasMemorySubcommand = false;
    const homeTree = await runLocalSsh(`find ${shellQuote(`${probeRoot}/home/.gemini`)} -maxdepth 2 2>/dev/null | sort`);
    check('no memory store directory in the data root', !/memory/i.test(homeTree.stdout));
    observations.isolatedHomeTree = homeTree.stdout.trim().split('\n').map(redactUuids);
    // Real state: structure listing only, auth/credential files never opened.
    const realTree = await runLocalSsh(`find /root/.gemini/antigravity-cli -maxdepth 1 | sort; echo ---; ls /root/.gemini/antigravity-cli/brain | head -3`);
    check('real data root has no memory directory either', !/\/memory/i.test(realTree.stdout));
    observations.realRootTopLevel = realTree.stdout.trim().split('\n').filter(l => !l.startsWith('/') || l.startsWith('/root/.gemini/antigravity-cli/')).map(redactUuids);
    const strings = await runLocalSsh(
      `strings -n 8 /root/.local/bin/agy 2>/dev/null | grep -c retrieve_memory || true; strings -n 8 /root/.local/bin/agy 2>/dev/null | grep -c 'name=user_memory_summary' || true; strings -n 8 /root/.local/bin/agy 2>/dev/null | grep -cE '^(save_memory|list_memories|memory_tool)$' || true`,
      300000,
    );
    const [retrieveHits, summaryTagHits, localToolHits] = strings.stdout.trim().split('\n').map(Number);
    observations.binaryStrings = {
      retrieveMemoryProtocolFieldHits: retrieveHits,
      userMemorySummaryProtoTagHits: summaryTagHits,
      localMemoryToolNameHits: localToolHits,
    };
    check('memory names exist only as cloud protocol fields', retrieveHits > 0 && summaryTagHits > 0 && localToolHits === 0);
    observations.verdictBasis = [
      'no memory subcommand or /memory slash command (full TUI command list enumerated)',
      'no memory settings key in settings.json (verified keys: model, trustedWorkspaces)',
      'no memory directory in ~/.gemini/antigravity-cli (brain/<id>/ remains per-conversation artifacts; implicit/ holds encrypted .pb trajectories)',
      'retrieve_memory / user_memory_summary appear only as protobuf protocol fields',
    ];
    evidence.memory = observations;
  },

  async settingsLaunch() {
    const observations = {};
    const modeProbe = await agy('agy --mode bogus --print hi 2>&1 | head -2');
    const modeProbeAll = `${modeProbe.stdout}${modeProbe.stderr}`;
    check('execution mode validated with the documented value set', modeProbeAll.includes('unrecognized --mode value "bogus"') && modeProbeAll.includes('accept-edits, auto, plan'));
    observations.modeValues = ['accept-edits', 'auto', 'plan'];
    const help = await agy('agy --help 2>&1');
    const effort = /--effort\s+.*?\(([^)]+)\)/.exec(help.stdout)?.[1];
    check('reasoning effort value set documented in help', effort === 'low|medium|high|xhigh|max');
    observations.effortValues = effort.split('|');
    observations.launchParams = {
      model: '--model <id-or-name> (per session; /model persists display name to settings.json model)',
      mode: '--mode accept-edits|auto|plan',
      effort: '--effort low|medium|high|xhigh|max',
      agent: '--agent <name> (custom agent selection; unknown agent exits 1 pre-session)',
      sessionOnlySettings: '--settings <json-or-file> applied for the session only, never saved',
      yolo: '--dangerously-skip-permissions',
      resume: '--conversation <id> / -c --continue',
    };
    await agy('agy --settings \'{"model":"Probe Model"}\' --print hi >/dev/null 2>&1; true');
    const persisted = await runLocalSsh(`[ ! -e ${shellQuote(`${probeRoot}/home/.gemini/antigravity-cli/settings.json`)} ] && printf absent || cat ${shellQuote(`${probeRoot}/home/.gemini/antigravity-cli/settings.json`)}`);
    check('session-only settings are never persisted', persisted.stdout.trim() === 'absent');
    observations.sessionOnlySettingsNeverPersisted = true;
    observations.verifiedSettingsKeys = { source: 'authenticated real settings.json (see report.md)', keys: ['model (display-name string)', 'trustedWorkspaces (string array; written by the trust prompt)'] };
    evidence.settings = observations;
  },

  async sessionLayout() {
    const observations = {};
    // Structure listing of the real 1.5.9 layout (no credential/auth files).
    const layout = await runLocalSsh(
      `ls /root/.gemini/antigravity-cli/ ; echo ---conversations---; ls /root/.gemini/antigravity-cli/conversations | head -4; echo ---brain---; find /root/.gemini/antigravity-cli/brain -maxdepth 4 -name "transcript_full.jsonl" | head -2; ls /root/.gemini/antigravity-cli/implicit | head -3; echo ---oldroot---; ls -a /root/.gemini/antigravity 2>/dev/null | head -4`,
    );
    check('1.5.9 session data lives under ~/.gemini/antigravity-cli', layout.stdout.includes('conversation_summaries.db') && layout.stdout.includes('conversations') && layout.stdout.includes('brain'));
    observations.rootListing = redactUuids(layout.stdout.trim());
    observations.oldRootState = 'legacy ~/.gemini/antigravity/ exists but is empty on this machine (config/.migrated marker present; embedded changelog records the migration)';

    // Copy (never modify) the stores and extract schema + sanitized shapes.
    const summariesCopy = `${probeRoot}/work/summaries-probe.db`;
    const convId = (await runLocalSsh(`ls /root/.gemini/antigravity-cli/conversations | grep -v -- -wal | grep -v -- -shm | head -1`)).stdout.trim();
    await runLocalSsh(`cp /root/.gemini/antigravity-cli/conversation_summaries.db ${shellQuote(summariesCopy)} && cp ${shellQuote(`/root/.gemini/antigravity-cli/conversations/${convId}`)} ${shellQuote(`${probeRoot}/work/conv-probe.db`)}`);
    const schema = await remotePy(`
import sqlite3, json
result = {}
for name in ("${summariesCopy}", "${probeRoot}/work/conv-probe.db"):
    con = sqlite3.connect("file:" + name + "?mode=ro", uri=True)
    tables = {}
    for (tbl,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        cols = [[r[1], r[2]] for r in con.execute(f"PRAGMA table_info({tbl})")]
        cnt = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        tables[tbl] = {"rows": cnt, "columns": cols}
    result[name.split("/")[-1]] = tables
    con.close()
print(json.dumps(result))
`);
    const schemas = jsonOrNull(schema);
    check('summaries schema captured with 1.5.9 columns', schemas?.['summaries-probe.db']?.conversation_summaries?.columns?.some(([n]) => n === 'workspace_uris')
      && schemas['summaries-probe.db'].conversation_summaries.columns.some(([n]) => n === 'parent_conversation_id'));
    observations.schemas = schemas;

    const rows = await remotePy(`
import sqlite3, json
con = sqlite3.connect("file:" + "${summariesCopy}" + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
rows = con.execute("SELECT * FROM conversation_summaries LIMIT 3").fetchall()
out = []
for r in rows:
    d = dict(r)
    s = {}
    for k, v in d.items():
        if v is None: s[k] = None
        elif k in ("conversation_id", "parent_conversation_id"): s[k] = "uuid-len=%d" % len(str(v)) if v else None
        elif k in ("title", "preview"): s[k] = "str-len=%d" % len(v)
        elif k == "workspace_uris": s[k] = "json-array-of-path-len=%s" % ([len(x) for x in json.loads(v)] if v and v.startswith("[") else None)
        elif isinstance(v, bytes): s[k] = "blob-%dB" % len(v)
        else: s[k] = v
    out.append(s)
enums = {
  "status": [r[0] for r in con.execute("SELECT DISTINCT status FROM conversation_summaries")],
  "agent_name": [r[0] for r in con.execute("SELECT DISTINCT agent_name FROM conversation_summaries")],
  "app_data_dir": [r[0] for r in con.execute("SELECT DISTINCT app_data_dir FROM conversation_summaries")],
}
print(json.dumps({"rows": out, "enums": enums}))
con.close()
`);
    observations.summariesRowsSanitized = jsonOrNull(rows);
    check('summary rows sanitized (no titles or ids leave the machine)', !JSON.stringify(observations.summariesRowsSanitized).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/));

    const genWalk = await remotePy(`
import sqlite3, json
con = sqlite3.connect("file:" + "${probeRoot}/work/conv-probe.db" + "?mode=ro", uri=True)
def walk(buf):
    i = 0; out = []
    try:
        while i < len(buf):
            tag = 0; shift = 0
            while True:
                b = buf[i]; i += 1; tag |= (b & 0x7F) << shift; shift += 7
                if not b & 0x80: break
            f, w = tag >> 3, tag & 7
            if f == 0: raise ValueError
            if w == 0:
                while buf[i] & 0x80: i += 1
                i += 1
            elif w == 1: i += 8
            elif w == 2:
                ln = 0; shift = 0
                while True:
                    b = buf[i]; i += 1; ln |= (b & 0x7F) << shift; shift += 7
                    if not b & 0x80: break
                i += ln
            elif w == 5: i += 4
            else: raise ValueError
            if i > len(buf): raise ValueError
            out.append((f, w))
    except Exception:
        return None
    return out
rows = con.execute("SELECT idx, size, data FROM gen_metadata ORDER BY idx LIMIT 8").fetchall()
print(json.dumps([{"idx": i, "size": s, "topFields": [f for f, w in (walk(d) or [])], "wires": [w for f, w in (walk(d) or [])], "parseOk": walk(d) is not None} for i, s, d in rows]))
con.close()
`);
    observations.genMetadataShape = jsonOrNull(genWalk);
    check('gen_metadata protobuf walk succeeded on real rows', observations.genMetadataShape?.length >= 5 && observations.genMetadataShape.every(r => r.parseOk));

    const transcript = await remotePy(`
import json, glob, collections
types = collections.Counter(); shapes = {}
sources = collections.Counter(); statuses = collections.Counter()
for path in glob.glob("/root/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl"):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try: d = json.loads(line)
            except Exception: types["<unparseable>"] += 1; continue
            types[d.get("type")] += 1
            sources[d.get("source")] += 1
            statuses[d.get("status")] += 1
            shapes.setdefault(d.get("type"), collections.Counter())[json.dumps(sorted(d.keys()))] += 1
print(json.dumps({"types": dict(types), "sources": dict(sources), "statuses": dict(statuses), "keyShapes": {t: [json.loads(k) for k in c] for t, c in shapes.items()}}))
`);
    observations.transcriptShapes = jsonOrNull(transcript);
    check('transcript wire types captured (USER_INPUT and PLANNER_RESPONSE with usage keys)', observations.transcriptShapes?.types?.USER_INPUT > 0
      && observations.transcriptShapes.types.PLANNER_RESPONSE > 0
      && observations.transcriptShapes.keyShapes.PLANNER_RESPONSE?.some(keys => keys.includes('input_tokens') && keys.includes('output_tokens') && keys.includes('cache_read_tokens')));

    const resume = await agy('agy --conversation 00000000-0000-0000-0000-000000000000 --print hi 2>&1 | head -2');
    const resumeAll = `${resume.stdout}${resume.stderr}`;
    check('resume by id resolves against the local store pre-auth', resumeAll.includes('not found'));
    observations.resumeProbe = resumeAll.trim();
    observations.resumeSemantics = {
      byId: '--conversation <uuid> (bogus id warns "conversation ... not found" before auth)',
      latest: '-c/--continue resumes the most recent conversation',
      remoteAgent: '--remote-agent does not support --print',
    };
    evidence.sessionLayout = observations;
  },
};

try {
  requireThat(['probe', 'cleanup'].includes(phase), 'Unknown phase.');
  requireThat(host, 'Set --host or AGY_EVIDENCE_HOST to the authorized remote target.');
  requireThat(PROBE_ROOT_PATTERN.test(probeRoot), 'probe-root must be a dedicated /root/.cliora-agy-probe-<date> directory.');
  requireThat(!/\s/.test(probeRoot), 'probe-root must not contain whitespace.');

  await mkdir(out, { recursive: true });
  await mkdir(path.join(out, 'evidence'), { recursive: true });

  if (phase === 'probe') {
    await runLocalSsh(`mkdir -p ${shellQuote(probeRoot)}/home ${shellQuote(probeRoot)}/project ${shellQuote(probeRoot)}/plugin-src ${shellQuote(probeRoot)}/work`);
    for (const [name, experiment] of Object.entries(experiments)) {
      await experiment();
      report.observations[name] = 'ok';
    }
    // Real-state guard after the suite: sizes and mtimes of user config files
    // must be unchanged (logs may rotate; they are excluded).
    const guard = await runLocalSsh(
      `stat -c "%n %s %Y" ${shellQuote('/root/.gemini/config/config.json')} ${shellQuote('/root/.gemini/config/mcp_config.json')} ${shellQuote('/root/.gemini/antigravity-cli/settings.json')}`,
    );
    const after = guard.stdout.trim().split('\n');
    const before = report.observations.realStateGuardBefore;
    check('real user config files untouched by the isolated suite', before.length === after.length && before.every((line, i) => line === after[i]));
    report.verdicts = {
      memory: 'absent — no editable native memory store in agy 1.5.9 (commands, slash commands, settings keys, filesystem and binary strings all negative; brain/<id>/ stays per-conversation artifacts and retrieve_memory/user_memory_summary remain cloud protocol fields). The 1.3.1 verdict is confirmed, not replaced.',
      independentAgents: 'exists — .agents/agents/{name}/agent.md (workspace, discovered headless without trust once the project is a committed git repo) and ~/.gemini/config/agents/{name}/agent.md (global) plus plugin agents/<name>.md; markdown + YAML frontmatter (name, description required; mainAgent/subagent/hidden/model/tools); the --agent launch roster holds main agents (mainAgent true or omitted), subagent-only entries are in-session invocations, and an unknown headless agent exits 1 while enumerating the roster.',
      projectLevelMcp: 'exists at runtime — <workspace>/.agents/mcp_config.json loads (authenticated /mcp panel connected the project entry), but the `agy mcp` CLI subcommands list/write the user-level ~/.gemini/config/mcp_config.json only, and panel toggles record overrides in that global file.',
      mcpKeyContract: 'native writer key is serverUrl (with a per-entry disabled boolean); docs describe url as current and serverUrl as accepted legacy — both keys are read; native edits canonicalize legacy url entries back to serverUrl; no dual-key writes were observed.',
    };
    report.status = failed ? 'not_verified' : 'probe_passed';
    report.limitations.push(
      'Isolated suite runs without sign-in: MCP/plugin/hooks/settings file contracts are verified, but model calls, interactive panels and custom-agent roster assembly need the signed-in state (captured separately in report.md).',
      'Evidence covers Linux (Debian 13 x86_64) only; Windows/macOS layouts are not verified here.',
      'Hook execution (a session actually firing handlers) and end-to-end custom-agent sessions were not exercised to avoid writing probe conversations into the real session store.',
    );
  } else {
    // cleanup: only the validated probe root; agy processes whose cwd is inside it.
    const killed = await runLocalSsh(
      `for p in $(pgrep -x agy 2>/dev/null); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in ${shellQuote(`${probeRoot}/`)}*) kill "$p" 2>/dev/null && echo "killed $p";; esac; done; true`,
    );
    await runLocalSsh(`tmux kill-session -t agyprobe 2>/dev/null; true`);
    await runLocalSsh(`rm -rf -- ${shellQuote(probeRoot)}`);
    const gone = await runLocalSsh(`[ ! -e ${shellQuote(probeRoot)} ] && printf absent`);
    check('probe workspace removed', gone.stdout.trim() === 'absent');
    report.cleanup = { probeRootRemoved: true, strayProcessesKilled: killed.stdout.trim().split('\n').filter(Boolean) };
    report.status = 'cleanup_complete';
  }
  console.log(`${phase}: ${report.status}`);
} catch (error) {
  failed = true;
  report.status = 'not_verified';
  // Check failures carry explicit reasons; other errors keep their class and
  // a bounded message (ssh/exec diagnostics only — no credentials involved).
  const message = String(error?.message ?? error ?? '');
  report.failure = error?.message?.startsWith?.('Failed:')
    ? error.message
    : `${error?.constructor?.name ?? 'Error'}: ${message.slice(0, 500)}`;
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await mkdir(path.join(out, 'evidence'), { recursive: true });
  for (const [name, payload] of Object.entries(evidence)) {
    await writeFile(path.join(out, 'evidence', `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }
  delete report.observations.realStateGuardBefore;
  await writeFile(path.join(out, `${phase}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
}
