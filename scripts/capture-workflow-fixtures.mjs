/** Sanitized history UI fixtures; no native credentials or billing calls. */

// Runs in the browser after the general capture harness has been installed.
export function workflowFixtures() {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const tools = [
    ['pi', 'Pi'], ['open_code', 'OpenCode'], ['codex', 'Codex'], ['claude_code', 'Claude Code'],
    ['grok', 'Grok'], ['codebuddy', 'CodeBuddy'], ['zcode', 'ZCode'],
  ].map(([id, name]) => ({ id, name, launchForm: id === 'zcode' ? 'desktop' : 'terminal', launchDirectory: id === 'zcode' ? 'unsupported' : 'terminal', interfaceFormats: ['openai_responses'], management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } }));
  const projectDenied = {
    codex: 'Codex 项目层不能写入供应商密钥；请使用全局配置',
    pi: 'Pi 项目层不能写入供应商密钥；请使用全局配置',
    open_code: 'OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录',
    grok: 'Grok 项目层不能写入供应商密钥；请使用全局配置',
  };
  const unsupportedKey = { zcode: 'ZCode 凭据由产品加密保管（credentials.json），不提供凭据管理' };
  const unsupportedAddress = {
    codebuddy: 'CodeBuddy 此版本不提供第三方供应商接口接入；模型经官方网关访问',
    zcode: 'ZCode 桌面端经产品内账号登录；setting.json 无文档化 API 连接字段',
  };
  const policy = (id, scope) => {
    const keyState = unsupportedKey[id] ? 'unsupported' : scope === 'project' && projectDenied[id] ? 'scope_denied' : 'writable';
    return {
      apiKey: { state: keyState, reason: keyState === 'writable' ? '' : unsupportedKey[id] || projectDenied[id] },
      providerAddress: { state: unsupportedAddress[id] ? 'unsupported' : 'configurable', reason: unsupportedAddress[id] || '' },
      projection: id === 'pi' || id === 'open_code' ? 'provider_models' : id === 'codex' ? 'current_model' : 'single_connection',
    };
  };
  const connection = (providerId, model, baseUrl = 'https://api.example/v1') => ({ providerId, interfaceFormat: 'openai_responses', baseUrl, model, secretRef: null, authEnvVar: null });
  const profile = (partial) => ({ version: 1, revision: '', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, ...partial });
  const profiles = [
    profile({ id: 'pi-models', tool: 'pi', name: 'Pi 多模型', files: { models: 'model-a' }, connection: connection('demo', 'model-a') }),
    profile({ id: 'oc-models', tool: 'open_code', name: 'OpenCode 模型', files: { models: 'm1' }, connection: connection('demo', 'm1') }),
    profile({ id: 'codex-draft', tool: 'codex', name: 'Codex 草稿', files: { settings: 'model = "gpt"\nmodel_reasoning_effort = "high"\n' }, connection: connection('demo', 'gpt', 'https://api.openai.com/v1') }),
    profile({ id: 'cb-official', tool: 'codebuddy', name: '官方网关', connection: connection('official', 'auto', 'https://third.example/v1') }),
    profile({ id: 'zc-login', tool: 'zcode', name: '已有登录', authentication: { kind: 'api_key' }, connection: connection('zcode', 'z', 'https://hidden.example') }),
  ];
  const project = { id: 'demo', name: '示例项目', path: '/work/demo', available: true, preferredTool: null, lastOpened: 0, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} };
  const now = Date.now();
  const bucketStart = new Date(now);
  bucketStart.setHours(0, 0, 0, 0);
  const zero = { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 };
  const totals = { ...zero, requests: 3729, usageRecords: 108, unknownRequestRecords: 1, sessions: 1, input: 1234, cacheRead: 8000, cacheWrite: 76, output: 690, total: 10000, unpricedTokens: 10000 };
  const records = [
    { id: 'grok-accuracy', toolId: 'grok', nativeId: null, title: 'Grok · Token 核对示例', cwd: null, model: 'grok-fixture', projectId: null, startedAt: now - 3600000, updatedAt: now - 60000, favorite: true, partial: true, stale: false, messageCount: 3, usageCount: 108 },
    { id: 'grok-empty', toolId: 'grok', nativeId: null, title: 'Grok · 没有用量的会话', cwd: null, model: null, projectId: null, startedAt: null, updatedAt: null, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 },
  ];
  const filtered = (filter) => records.filter(item => (!filter.search || item.title.includes(filter.search)) && (!filter.favoriteOnly || item.favorite) && (!filter.toolId || item.toolId === filter.toolId) && (!filter.model || item.model === filter.model) && (!filter.projectId || item.projectId === filter.projectId) && (!filter.fromMs || item.updatedAt >= filter.fromMs) && (!filter.toMs || item.updatedAt < filter.toMs));
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === 'get_bootstrap') {
      const result = await invoke(command, args);
      return { ...result, preferences: { ...result.preferences, managed_tools: tools.map(item => item.id) }, tools };
    }
    if (command === 'list_cli_adapters') return { registered: tools, managedIds: tools.map(item => item.id), preservedUnknown: [] };
    if (command === 'list_projects') return [project];
    if (['list_usage_queries', 'list_usage_cache', 'usage_presets', 'list_accounts', 'account_capabilities', 'list_history_prices', 'refresh_history'].includes(command)) return [];
    if (command === 'get_registered_tool_workspace') {
      const id = args.toolId;
      return {
        probe: { selectedPath: 'C:/tool.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [id === 'claude_code' ? 'anthropic_messages' : 'openai_responses'], providerPresets: id === 'codebuddy' || id === 'codex' ? [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://platform.openai.com' }] : [], dependencies: [], installUrl: '', upgradeHint: '', connectionPolicy: policy(id, args.scope ?? 'global') },
        profiles: profiles.filter(item => item.tool === id), common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
      };
    }
    if (command === 'inspect_registered_native_draft') {
      if (args.toolId === 'pi') return { providerId: 'demo', model: 'model-a', reasoningEffort: null, projectedModels: [{ id: 'model-a', fields: { contextWindow: 100, cost: { input: 1 }, modalities: ['text'] } }, { id: 'sibling', fields: { name: 'Keep' } }], connection: connection('demo', 'model-a') };
      if (args.toolId === 'open_code') return { providerId: 'demo', model: 'm1', reasoningEffort: null, projectedModels: [{ id: 'm1', fields: { name: 'Custom', extra: true } }, { id: 'm2', fields: { name: 'Second' } }], connection: connection('demo', 'm1') };
      if (args.toolId === 'codex') return { providerId: 'demo', model: 'gpt', reasoningEffort: 'low', projectedModels: null, connection: connection('demo', 'gpt', 'https://api.openai.com/v1') };
      return { connection: null, reasoningEffort: null, projectedModels: null };
    }
    if (command === 'set_codex_reasoning_effort') {
      const line = /^\s*model_reasoning_effort\s*=.*$/m;
      return args.effort ? String(args.text).replace(line, `model_reasoning_effort = "${args.effort}"`) : String(args.text).replace(line, '');
    }
    if (command === 'list_history_sessions') return filtered(args.filter ?? {});
    if (command === 'get_history_session') {
      const session = records.find(item => item.id === args.id);
      return { session, usage: [], totals: session.id === 'grok-accuracy' ? totals : zero, resumeReason: '原始记录没有可验证的恢复 ID', messages: session.id === 'grok-accuracy' ? [
        { id: 'q', role: 'user', text: '请核对本轮 Token 用量，并区分已知调用与未知次数。', timestamp: now - 3600000, timestampSource: 'native' },
        { id: 'a', role: 'assistant', text: '总量为 10,000 Token：新输入 1,234、缓存读取 8,000、缓存写入 76、输出 690。已知模型调用 3,729 次；108 条用量记录中有 1 条次数未知。', timestamp: now - 60000, timestampSource: 'turn' },
        { id: 'u', role: 'assistant', text: '这条保留消息没有可验证时间，继续展示正文。', timestamp: null, timestampSource: 'unknown' },
      ] : [{ id: 'empty-q', role: 'user', text: '保留会话正文；原生记录未提供 Token 用量。', timestamp: null, timestampSource: 'unknown' }] };
    }
    if (command === 'get_usage_report') {
      const sessions = filtered(args.filter ?? {});
      const included = sessions.some(item => item.id === 'grok-accuracy');
      const sum = included ? totals : zero;
      const group = (key, label, extra = {}) => ({ key, label, toolId: 'grok', model: null, projectId: null, priced: false, totals: sum, ...extra });
      return { generatedAt: now, from: args.filter.fromMs ?? null, to: args.filter.toMs ?? null, bucket: 'day', currency: 'USD', totals: sum, previous: null,
        timeline: included ? [{ start: bucketStart.getTime(), end: bucketStart.getTime() + 86400000, totals: sum }] : [], byModel: included ? [group('grok|grok-fixture', 'grok-fixture', { model: 'grok-fixture' })] : [], byTool: included ? [group('grok', 'Grok')] : [], byProject: included ? [group('unknown', '未归类')] : [], topSessions: included ? [{ ...records[0], totals: sum }] : [], models: ['grok-fixture'], untimedRequests: 0, duplicateRequests: 2, partialSessions: included ? 1 : 0, staleSessions: 0, mixedCurrency: false, latestEventAt: now - 60000, priceSources: [], scans: [] };
    }
    if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
    return invoke(command, args);
  };
}


/** Browser-only 500 MCP / 500 Skill fixtures shared by regression and capture. */
export function resourceExperienceFixture(options = {}) {
  const count = options.count ?? 500;
  const previous = window.__TAURI_INTERNALS__?.invoke;
  const names = index => String(index + 1).padStart(3, '0');
  const definitions = Array.from({ length: count }, (_, index) => ({ id: `mcp-${names(index)}`, name: `mcp-${names(index)}`, transport: index % 2 ? 'http' : 'stdio', command: 'node', args: [`server-${names(index)}.mjs`], url: `https://example.invalid/${names(index)}`, env: { TOKEN: '${TOKEN}' }, headers: {}, inLibrary: true, version: 1 }));
  const packages = Array.from({ length: count }, (_, index) => ({ id: `skill-${names(index)}`, name: `skill-${names(index)}`, description: index === count - 1 ? 'needle-last full metadata description' : `Resource skill description ${names(index)}`, compatibility: null, source: `C:/fixtures/skills/${names(index)}`, digest: `digest-${index}`, fileCount: 3, updatedAt: 1, inLibrary: true }));
  const contents = Object.fromEntries(packages.map(item => [item.id, `---\nname: ${item.name}\ndescription: ${item.description}\n---\n# ${item.name}\n\nOriginal Markdown and frontmatter.\n`]));
  const metadata = () => packages.map(item => ({ name: item.name, path: `C:/fixtures/native/${item.name}`, digest: null, state: 'unknown', detail: item.description, packageId: null }));
  const sorts = {};
  const calls = [];
  const writes = [];
  const cancelled = new Set();
  const nativeEntries = definitions.map(item => ({ ...structuredClone(item), enabled: true, protectedValues: false }));
  const state = { calls, writes, definitions, packages, nativeEntries, conflicts: [], stateDelay: options.stateDelay ?? 0, failState: options.failState ?? 'skill-002', failBatch: options.failBatch ?? 'mcp-002', active: 0, maxActive: 0, batchDelay: 0 };
  window.__resourceScale = state;
  window.isTauri = true;
  const descriptor = { id: 'codex', name: 'Codex', launchForm: 'terminal', launchDirectory: 'terminal', interfaceFormats: [], management: { accounts: false, mcp: true, skills: true, agents: false, plugins: false, projectPlugins: false }, nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, resume: { state: 'unavailable', reason: '' }, history: { state: 'unavailable', reason: '' } };
  const entryText = item => JSON.stringify({ mcpServers: { [item.name]: { ...(item.transport === 'http' ? { url: item.url, headers: item.headers } : { command: item.command, args: item.args, env: item.env }), ...(item.enabled === false ? { enabled: false } : {}) } } }, null, 2);
  const baseline = name => JSON.stringify(nativeEntries.find(item => item.name === name) ?? null);
  const token = (definition, target) => JSON.stringify([definition.id, definition.version, target.toolId, target.scope, target.projectPath ?? null, target.contextId ?? null, target.enabled, baseline(definition.name)]);
  window.__TAURI_INTERNALS__ = { ...(window.__TAURI_INTERNALS__ ?? {}), invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: options.theme ?? 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
    if (command === 'list_cli_adapters') return { registered: [descriptor], managedIds: ['codex'], preservedUnknown: [] };
    if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null };
    if (command === 'get_launch_settings') return { selected: 'auto', terminals: [], directories: {} };
    if (command === 'resource_sort_preference') { if (args.value) { sorts[args.context] = args.value; localStorage.setItem('fixture-sort:' + args.context, args.value); } return sorts[args.context] ?? localStorage.getItem('fixture-sort:' + args.context) ?? 'added'; }
    if (command === 'list_mcp_definitions') return definitions;
    if (command === 'list_mcp_placements') return [];
    if (command === 'list_native_mcp') return structuredClone(nativeEntries);
    if (command === 'preview_mcp_targets') { const definition = definitions.find(item => item.id === args.definitionId); return args.targets.map(target => ({ ...target, path: 'C:/fixtures/mcp.jsonc', status: state.conflicts.includes(definition.name) ? 'conflict' : 'ready', detail: 'Fixture native preview', baselineHash: baseline(definition.name), previewToken: token(definition, target), existing: nativeEntries.find(item => item.name === definition.name) ?? null, proposed: { name: definition.name, enabled: target.enabled } })); }
    if (command === 'list_skill_packages') return packages;
    if (command === 'list_native_skill_metadata') return metadata();
    if (command === 'list_skill_installations') return [];
    if (command === 'resource_states') {
      if (args.requests.length > 50) throw Error('unbounded state request');
      state.maxActive = Math.max(state.maxActive, ++state.active);
      await new Promise(resolve => setTimeout(resolve, state.stateDelay)); state.active--;
      return args.requests.map((request, index) => ({ index, status: (request.packageId ?? request.name) === state.failState ? 'failed' : 'ready', detail: (request.packageId ?? request.name) === state.failState ? 'Injected item failure' : '', value: request.kind === 'native_skill' ? { ...metadata().find(item => item.name === request.name), state: 'managed', packageId: request.name } : [] }));
    }
    if (command === 'run_resource_batch') {
      if (args.operations.length > 50) throw Error('unbounded write request');
      const items = [];
      for (const [index, operation] of args.operations.entries()) {
        if (state.batchDelay) await new Promise(resolve => setTimeout(resolve, state.batchDelay));
        const id = operation.definitionId ?? operation.packageId;
        let status = cancelled.has(args.operationId) ? 'not_executed' : id === state.failBatch ? 'failed' : 'written';
        let detail = status === 'failed' ? 'Injected write failure' : '';
        if (status === 'written' && operation.action === 'mcp_apply') {
          const definition = definitions.find(item => item.id === id); const target = operation.target;
          if (!definition || target.baselineHash !== baseline(definition.name) || target.previewToken !== token(definition, target)) { status = 'failed'; detail = 'MCP definition, target or baseline changed; preview again'; }
          else if (state.conflicts.includes(definition.name) && !target.allowReplace) { status = 'conflict'; detail = 'Explicit replacement required'; }
          else { const entry = { ...structuredClone(definition), enabled: target.enabled, protectedValues: false }; const index = nativeEntries.findIndex(item => item.name === definition.name); if (index < 0) nativeEntries.push(entry); else nativeEntries[index] = entry; state.conflicts = state.conflicts.filter(name => name !== definition.name); }
        }
        if (status === 'written') writes.push({ id, operation });
        items.push({ index, status, detail, value: null });
      }
      return { operationId: args.operationId, cancelled: cancelled.has(args.operationId), items };
    }
    if (command === 'cancel_resource_batch') { cancelled.add(args.operationId); return true; }
    if (command === 'distribute_mcp') {
      const result = await window.__TAURI_INTERNALS__.invoke('run_resource_batch', { operationId: crypto.randomUUID(), operations: args.targets.map(target => ({ action: 'mcp_apply', definitionId: args.definitionId, target })) });
      return result.items.map((item, index) => ({ ...args.targets[index], status: item.status, detail: item.detail }));
    }
    if (command === 'read_skill_package_document') { const item = packages.find(item => item.id === args.packageId); return { packageId: item.id, name: item.name, digest: item.digest, content: contents[item.id] }; }
    if (command === 'save_skill_package_document') { const item = packages.find(item => item.id === args.packageId); if (item.digest !== args.baseline) throw Error('External edit conflict'); contents[item.id] = args.content; item.digest += '-saved'; writes.push({ id: item.id, kind: 'skill-document' }); return { packageId: item.id, name: item.name, digest: item.digest, content: args.content }; }
    if (command === 'read_native_skill') { const name = args.directory.split('/').at(-1); return { name, path: args.directory + '/SKILL.md', content: contents[name] }; }
    if (command === 'save_native_skill') { const name = args.directory.split('/').at(-1); contents[name] = args.content; return { name, path: args.directory + '/SKILL.md', content: args.content }; }
    if (command === 'get_skill_enabled') return true;
    if (command === 'render_mcp_draft') return { source: 'equivalent', format: 'json', name: args.draft.name, enabled: args.target.enabled, text: entryText({ ...args.draft, enabled: args.target.enabled }), rawText: null, rawScope: null, sourcePath: null, baseline: '', targetToolId: args.target.toolId, protectedValues: false, unmappedFields: [], diagnostics: [] };
    if (command === 'read_mcp_document') { const request = args.request; const item = request.definitionId ? definitions.find(item => item.id === request.definitionId) : nativeEntries.find(item => item.name === request.name); return { source: request.definitionId ? 'equivalent' : 'native_entry', name: item.name, enabled: item.enabled ?? true, format: 'json', text: entryText(item), rawText: request.definitionId ? null : '// Original fixture file\n' + entryText(item) + '\n// unrelated configuration', rawScope: request.definitionId ? null : 'native_file', sourcePath: request.definitionId ? null : 'C:/fixtures/mcp.jsonc', baseline: 'native-1', targetToolId: request.target.toolId, protectedValues: !!item.protectedValues, unmappedFields: item.unmappedFields ?? [], diagnostics: [] }; }
    if (command === 'parse_mcp_paste') {
      const parsed = JSON.parse(args.text); const entries = parsed.mcpServers ?? (args.name ? { [args.name]: parsed } : {});
      return Object.entries(entries).map(([name, value]) => { const unmappedFields = Object.keys(value).filter(key => !['command','args','env','url','headers','enabled','disabled'].includes(key)); return { name, enabled: value.enabled !== false && value.disabled !== true, draft: unmappedFields.length ? null : { id: null, expectedVersion: null, name, transport: value.url ? 'http' : 'stdio', command: value.command ?? '', args: value.args ?? [], url: value.url ?? '', env: value.env ?? {}, headers: value.headers ?? {}, inLibrary: true }, unmappedFields, diagnostics: [] }; });
    }
    if (command === 'save_mcp_definition') { const draft = args.draft; const index = definitions.findIndex(item => item.id === draft.id); if (index >= 0 && definitions[index].version !== draft.expectedVersion) throw Error('External version conflict'); const item = { ...draft, id: draft.id ?? 'new-' + definitions.length, version: (draft.expectedVersion ?? 0) + 1 }; if (index >= 0) definitions[index] = item; else definitions.unshift(item); return item; }
    if (command === 'delete_mcp_definition') { const index = definitions.findIndex(item => item.id === args.id); if (index >= 0) definitions.splice(index, 1); return null; }
    if (command === 'delete_skill_package') { const index = packages.findIndex(item => item.id === args.packageId); if (index >= 0) packages.splice(index, 1); return null; }
    if (command === 'get_tray_status') return { available: true, error: null };
    if (command === 'list_projects' || command === 'list_library_items' || command === 'list_accounts' || command === 'list_skill_recovery_issues' || command === 'account_capabilities' || command === 'list_usage_queries' || command === 'list_usage_cache') return [];
    if (previous) return previous(command, args);
    return null;
  } };
}


/** Cursor IDE only. Install after resourceExperienceFixture; browser evidence only. */
export function cursorIdeFixture(options = {}) {
  const previous = window.__TAURI_INTERNALS__.invoke;
  const calls = [];
  const fields = [['editor.fontSize','number',15],['editor.tabSize','integer',2],['editor.wordWrap','string','on'],['files.autoSave','string','off'],['workbench.colorTheme','string','Default Dark Modern']];
  const configuration = { version: 1, operations: ['set','reset'], fields: fields.map(([id,kind]) => ({ id,label:id,kind,required:false,advanced:false,choices:id==='editor.wordWrap'?['off','on','wordWrapColumn','bounded']:id==='files.autoSave'?['off','afterDelay','onFocusChange','onWindowChange']:[],minimum:kind==='number'?6:kind==='integer'?1:null,defaultSource:'Cursor IDE',unavailableReason:null })) };
  const descriptor = { id:'cursor_ide',name:'Cursor IDE',launchForm:'desktop',launchDirectory:'unsupported',interfaceFormats:[],configuration,yoloAvailable:false,management:{accounts:false,mcp:true,skills:true,agents:false,plugins:false,projectPlugins:false},nativeConfig:{state:'available',reason:''},launch:{state:'available',reason:''},resources:{state:'available',reason:''},resume:{state:'unsupported',reason:'未验证'},history:{state:'unsupported',reason:'未验证'} };
  const entries = ['primary','agents','claude'].map((source,index) => ({ name:'same-skill',path:`C:/fixtures/${source}/skills/same-skill`,source,readOnly:index>0,readOnlyReason:index>0?'兼容来源只读，安装与修改使用 .cursor/skills':null,state:'external',detail:`${source} Skill source`,digest:null,packageId:null }));
  const contents = Object.fromEntries(entries.map(entry => [entry.path,`---\nname: mismatched\ndescription: \n---\n# ${entry.source} Skill\n`]));
  const sessions = {};
  window.__cursorIde = { calls, entries, contents, failLaunch:false };
  window.__TAURI_INTERNALS__.invoke = async (command,args={}) => {
    calls.push({command,args});
    if(command==='get_bootstrap')return {preferences:{schema_version:1,managed_tools:['cursor_ide'],theme:options.theme??'light'},tools:[{id:'cursor_ide',name:'Cursor IDE'}]};
    if(command==='list_cli_adapters')return {registered:[descriptor],managedIds:['cursor_ide'],preservedUnknown:[]};
    if(command==='get_registered_tool_workspace')return {probe:{selectedPath:options.missing?null:'C:/fixtures/Cursor.exe',installations:options.missing?[]:[{path:'C:/fixtures/Cursor.exe',version:'3.24.9',source:'native',status:'available'}],nativeFiles:[{role:'settings',path:'C:/fixtures/Cursor/User/settings.json',format:'jsonc',exists:true,writable:!options.missing,sensitive:false,reason:null}],nativeWrites:{state:options.missing?'unknown':'supported',reason:options.missing?'未确认兼容的 Cursor IDE 安装标记':''},interfaceFormats:[],providerPresets:[],dependencies:[],installUrl:'https://cursor.com/downloads',upgradeHint:'',connectionPolicy:{apiKey:{state:'unsupported',reason:'IDE 客户端管理'},providerAddress:{state:'unsupported',reason:'IDE 客户端管理'},projection:'single_connection'}},profiles:[],common:null,binding:null,effectiveContextId:null,snapshots:[],recoveryNeeded:[],customPath:null};
    if(command==='launch_cli'){if(window.__cursorIde.failLaunch)throw Error('Cursor IDE 启动失败');return {terminal:'desktop',status:'desktop_requested',mode:'normal'};}
    if(command==='list_native_skill_metadata')return entries.map(entry=>({...entry,state:'unknown'}));
    if(command==='resource_states')return args.requests.map((request,index)=>({index,status:'ready',detail:'',value:entries.find(entry=>entry.path===request.directory)}));
    if(command==='read_native_skill'){const entry=entries.find(entry=>entry.path===args.directory);return {...entry,content:contents[entry.path]};}
    if(command==='save_native_skill'){const entry=entries.find(entry=>entry.path===args.directory);if(entry.readOnly)throw Error(entry.readOnlyReason);if(contents[entry.path]!==args.baseline)throw Error('外部修改');contents[entry.path]=args.content;return null;}
    if(command==='begin_configuration_draft'){
      const request=args.request;const view=Object.fromEntries(fields.map(([id,,value])=>[id,value]));const files={settings:JSON.stringify(view,null,2)};
      const value={sessionId:request.sessionId,revision:0,requestGeneration:0,subject:request.subject,scope:request.scope,projectPath:request.projectPath,contextId:null,profile:{id:'',tool:'cursor_ide',name:'Cursor IDE',version:1,revision:'',inheritCommon:false,files,suppressed:{},authentication:{kind:'native'},connection:null,nativeCredentials:{},editing:{version:1,selectedProvider:null,intents:[]}},baselineFiles:files,common:null,view,issues:[],descriptor:configuration,draftConnection:null,credential:{source:'native'},credentialStatus:'none',sourceCapabilities:[{source:'native',available:true,reason:null},{source:'account',available:false,reason:'客户端管理'},{source:'api_key',available:false,reason:'客户端管理'}],catalogSupport:{available:false,multiple:false,reason:'IDE 设置'}};sessions[value.sessionId]=value;return structuredClone(value);
    }
    if(command==='edit_configuration_draft'){const value=sessions[args.draft.sessionId];if(args.action.operation==='reset')delete value.view[args.action.field];else value.view[args.action.field]=args.action.value;value.profile.files.settings=JSON.stringify(value.view,null,2);value.revision++;return structuredClone(value);}
    if(command==='cancel_configuration_draft')return null;
    return previous(command,args);
  };
}
