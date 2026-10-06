/** Sanitized history UI fixtures; no native credentials or billing calls. */

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
