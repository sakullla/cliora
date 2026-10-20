/** Sanitized history UI fixtures; no native credentials or billing calls. */

export function qoderHistoryFixtures() {
  const prior = window.__TAURI_INTERNALS__?.invoke;
  const now = Date.now();
  const start = new Date().setHours(0, 0, 0, 0);
  const tool = { id: 'qoder_cn', name: 'Qoder CN', yoloAvailable: true, history: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, interfaceFormats: [], management: { accounts: false } };
  const nativeUsage = [
    { unit: 'credits', value: 12.345, originalValue: 24.69, billable: false, records: 3, unknownOriginalRecords: 0 },
    { unit: 'credits', value: 0.75, originalValue: 1.5, billable: true, records: 1, unknownOriginalRecords: 0 },
    { unit: 'credits', value: 0.125, originalValue: null, billable: null, records: 1, unknownOriginalRecords: 1 },
  ];
  const totals = { requests: 5, usageRecords: 5, unknownRequestRecords: 0, unknownTokenRecords: 5, sessions: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0, nativeUsage };
  const zero = { ...totals, requests: 0, usageRecords: 0, unknownTokenRecords: 0, sessions: 0, nativeUsage: [] };
  const session = { id: 'qoder-credits', toolId: 'qoder_cn', nativeId: '11111111-2222-4333-8444-555555555555', title: 'Qoder CN · 原生 Credits 与会话', cwd: 'C:/Synthetic/Qoder', model: 'qfmodel', projectId: null, startedAt: now - 600000, updatedAt: now - 1000, favorite: false, partial: false, stale: false, messageCount: 2, usageCount: 5 };
  const included = (filter = {}) => (!filter.toolId || filter.toolId === session.toolId) && (!filter.model || filter.model === session.model)
    && (!filter.search || session.title.includes(filter.search)) && (!filter.favoriteOnly || session.favorite)
    && (!filter.fromMs || now - 1000 >= filter.fromMs) && (!filter.toMs || now - 1000 < filter.toMs);
  const calls = [];
  Object.assign(window, { isTauri: true, __qoderHistoryCalls: calls, __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'get_bootstrap') { const original = prior ? await prior(command, args) : null; return { preferences: { schema_version: 1, managed_tools: ['qoder_cn'], theme: original?.preferences?.theme ?? 'light' }, tools: [tool] }; }
    if (command === 'list_cli_adapters') return { registered: [tool], managedIds: ['qoder_cn'], preservedUnknown: [] };
    if (['list_projects', 'list_history_prices', 'refresh_history'].includes(command)) return [];
    if (command === 'list_history_sessions') return included(args.filter) ? [session] : [];
    if (command === 'get_history_session') return { session, totals, usage: [], resumeReason: null, messages: [
      { id: 'qoder-u', role: 'user', text: '请检查项目并给出修改建议。', timestamp: now - 600000, timestampSource: 'native' },
      { id: 'qoder-a', role: 'assistant', text: '已检查项目。原生会话正文保留，工具输出和子代理正文不混入这段对话。', timestamp: now - 1000, timestampSource: 'native' },
    ] };
    if (command === 'get_usage_report') {
      const active = included(args.filter); const sum = active ? totals : zero;
      const group = (key, label, extra = {}) => ({ key, label, toolId: 'qoder_cn', model: null, projectId: null, priced: false, totals: sum, ...extra });
      return { generatedAt: now, from: args.filter?.fromMs ?? start, to: args.filter?.toMs ?? now + 1, bucket: 'day', currency: 'USD', totals: sum, previous: null,
        timeline: active ? [{ start, end: start + 86400000, totals: sum }] : [], byModel: active ? [group('qoder_cn|qfmodel', 'qfmodel', { model: 'qfmodel' })] : [], byTool: active ? [group('qoder_cn', 'Qoder CN')] : [], byProject: active ? [group('unknown', '未归类')] : [], topSessions: active ? [{ ...session, totals: sum }] : [], models: ['qfmodel'], untimedRequests: 0, duplicateRequests: 1, partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: now - 1000, priceSources: [], scans: [] };
    }
    if (command === 'copy_history_resume_command') return `qoderclicn -r ${session.nativeId}`;
    if (command === 'resume_history_session') return { toolId: 'qoder_cn', projectId: null, mode: args.mode, terminal: 'power_shell', status: 'terminal_requested' };
    if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
    if (command === 'get_tray_status') return { available: false, error: null };
    if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
    return prior ? prior(command, args) : null;
  } } });
}

// Runs in the browser after the general capture harness has been installed.
export function workflowFixtures() {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const tools = [
    ['pi', 'Pi'], ['open_code', 'OpenCode'], ['codex', 'Codex'], ['claude_code', 'Claude Code'],
    ['grok', 'Grok'], ['codebuddy', 'CodeBuddy'], ['zcode', 'ZCode'],
  ].map(([id, name]) => ({ id, name, interfaceFormats: ['openai_responses'], management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } }));
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
