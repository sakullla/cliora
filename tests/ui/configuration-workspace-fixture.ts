import type { Page } from '@playwright/test';

/** Synthetic IPC contract. Real native semantics are covered by Rust and CLI evidence. */
export async function installConfigurationProtocol(page: Page) {
  await page.addInitScript(() => {
    const previous = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!previous) throw new Error('Install the base tool fixture before its configuration protocol');
    const state = { calls: [] as any[], sessions: {} as Record<string, any>, cancelled: [] as string[], leases: {} as Record<string, any>, sequence: 0, currentApiWritable: null as boolean | null, omitSourceCapabilities: false, nativeCredentialTarget: null as any, commonFiles: null as Record<string, string> | null, cancelRequestFailure: '', references: {} as Record<string, string>, delayEdit: false, releaseEdit: null as (() => void) | null, delayDirectory: false, releaseDirectory: null as (() => void) | null, directoryFailure: '', applyFailure: '', disk: {} as Record<string, string>, commonFailures: ['project:/tmp/project'], comparisons: {} as Record<string, any>, backupOriginal: '', backupPreview: null as any };
    (window as any).configurationProtocol = state;
    const clone = (value: any) => structuredClone(value);
    const field = (id: string, label = id, kind = 'string', required = false, advanced = false) => ({ id, label, kind, required, advanced, choices: [], minimum: kind === 'integer' ? 1 : null, defaultSource: '原生默认', unavailableReason: null });
    function describe(tool: string, common: boolean) {
      if (common) return { version: 1, operations: ['set', 'reset'], fields: [tool === 'claude_code' ? field('effortLevel', '默认推理 effort') : field('commonSetting', '通用参数', 'integer')] };
      return { version: 1, operations: ['set', 'reset', 'create', 'copy', 'rename', 'delete', 'default', 'configure_provider', 'select_provider', 'unify'], fields:
        tool === 'codex' ? [field('model', '当前模型'), field('model_provider', '供应商 ID'), field('base_url', 'Responses 地址'), field('model_reasoning_effort', '推理强度（Codex 原生）'), field('model_context_window', '上下文窗口（Token）', 'integer'), field('model_reasoning_summary', '推理摘要'), field('model_verbosity', '回答详细程度')]
        : tool === 'claude_code' ? [field('default.model', '默认模型'), field('base_url', 'Anthropic 地址'), field('effortLevel', '默认推理 effort'), field('modelEffortLevel', '模型推理 effort'), ...['default', 'sonnet', 'opus', 'fable', 'haiku', 'subagent'].flatMap(role => [field(role+'.longContext', role+' 长上下文', 'boolean'), field(role+'.model', role+' 模型'), field(role+'.name', role+' 名称')])]
        : tool === 'kimi_code' ? [field('model', '请求模型 ID', 'string', true), field('provider', '供应商 ID', 'string', true), field('max_context_size', '上下文上限', 'integer', true), field('display_name', '显示名称'), field('max_output_size', '输出上限', 'integer', false, true), field('capabilities', '模型能力', 'string_list'), field('support_efforts', '支持的思考档位', 'json', false, true), field('default_effort', '模型思考档位', 'string', false, true), field('thinking.enabled', '默认思考', 'boolean')]
        : tool === 'pi' ? [field('name', '显示名称'), field('contextWindow', '上下文窗口', 'integer'), field('maxTokens', '输出上限', 'integer'), field('input', '输入能力', 'string_list', false, true), field('reasoning', '推理能力', 'boolean'), field('thinkingLevelMap', '思考映射', 'json', false, true), field('defaultProvider', '默认供应商'), field('defaultModel', '默认模型'), field('defaultThinkingLevel', '默认思考')]
        : [field('name', '显示名称'), field('limit.context', '上下文窗口', 'integer'), field('limit.output', '输出上限', 'integer'), field('reasoning', '推理能力', 'boolean'), field('options', '模型选项', 'json', false, true), field('variants', '推理变体', 'json', false, true)] };
    }
    function initialView(tool: string, common: boolean) {
      if (common) return { commonFields: [tool === 'claude_code' ? { id: 'effortLevel', value: 'high', target: 'configuration' } : { id: 'commonSetting', value: 4, target: 'fixture.common' }] };
      if (tool === 'codex') return { values: { model: 'fixture-model', model_provider: 'gateway', base_url: 'https://gateway.example.test/v1' }, effortChoices: ['low', 'medium', 'high', 'xhigh', 'ultra'], capabilitySource: 'fixture only' };
      if (tool === 'claude_code') return { values: { 'default.model': 'fixture-model', base_url: 'https://gateway.example.test' }, effortChoices: ['low','high','xhigh'], editTarget: 'configuration', currentEffortModel: 'fixture-model', modelEfforts: {} };
      return { providerId: 'gateway', providers: ['gateway', 'other'], defaultModel: 'one', settings: {}, connection: { baseUrl: 'https://gateway.example.test/v1', protocol: tool === 'pi' ? 'openai-completions' : tool === 'kimi_code' ? 'openai' : '@ai-sdk/openai-compatible' }, models: ['one', 'two', 'three'].map(id => ({ id, kind: 'model', fields: tool === 'kimi_code' ? { model: id, provider: 'gateway', max_context_size: 8192, display_name: id } : tool === 'pi' ? { name: id, contextWindow: 8192, maxTokens: 1024, input: ['text'], thinkingLevelMap: { low: 'low' } } : { name: id, limit: { context: 8192, output: 1024 }, options: { temperature: 0.25 } } })) };
    }
    function refresh(value: any, write = true) {
      value.issues = [];
      if (value.profile.tool === 'kimi_code' && value.subject !== 'common') for (const model of value.view.models ?? []) if (!model.fields.max_context_size) value.issues.push({ target: { kind: 'model', provider: model.fields.provider, id: model.id }, field: 'max_context_size', code: 'required', message: `${model.id} 缺少必填上下文上限` });
      if (value.profile.tool === 'claude_code' && value.subject === 'common') for (const [role, text] of Object.entries(value.profile.files)) {
        const document = JSON.parse(text as string);
        if (document.model || ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_FABLE_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','CLAUDE_CODE_SUBAGENT_MODEL'].some(field => document.env?.[field])) value.issues.push({ code: 'common_scope', target: role, field: null, message: '通用配置不允许模型引用' });
      }
      if (write && value.profile.tool === 'claude_code') {
        const role = value.subject === 'common' || value.view.editTarget !== 'local_configuration' ? 'settings' : 'local_settings';
        const document = JSON.parse(value.profile.files[role] ?? '{}');
        if (value.subject === 'common') document.effortLevel = value.view.commonFields[0].value;
        else { document.env ??= {}; document.env.ANTHROPIC_MODEL = value.view.values['default.model']; document.effortLevel = value.view.values.effortLevel; }
        value.profile.files[role] = JSON.stringify(document);
      } else if (write) value.profile.files = { ...value.profile.files, settings: JSON.stringify(value.view) };
      state.sessions[value.sessionId] = clone(value); return clone(value);
    }
    function active(args: any) { if (state.cancelled.includes(args.draft.sessionId)) throw { message: '会话已取消' }; return clone(args.draft); }
    function setPath(value: any, path: string, next: any) { const keys = path.split('.'); let object = value; for (const key of keys.slice(0,-1)) object = object[key] ?? (object[key] = {}); if (next == null) delete object[keys.at(-1)!]; else object[keys.at(-1)!] = next; }
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      state.calls.push({ command, args: clone(args ?? {}) });
      if (command === 'begin_configuration_draft') {
        const request = args.request; const workspace = await previous('get_registered_tool_workspace', { toolId: request.toolId, scope: request.scope, projectPath: request.projectPath });
        const profile = clone(request.profile ?? { id: '', tool: request.toolId, name: '', version: 0, files: {}, nativeCredentials: {}, suppressed: {}, inheritCommon: false, connection: null });
        profile.editing = { version: 1, selectedProvider: 'gateway', intents: [] };
        const view = initialView(request.toolId, request.subject === 'common');
        const credential = profile.authentication?.kind === 'oauth' ? { source: 'account', accountId: profile.authentication.accountId } : profile.authentication?.kind === 'api_key' ? { source: 'api_key', secretRef: profile.connection?.secretRef ?? null } : { source: 'native' };
        const draftConnection = request.subject === 'current' && state.nativeCredentialTarget ? null : { providerId: 'gateway', baseUrl: 'https://gateway.example.test/v1', interfaceFormat: 'openai_completions', model: 'one', secretRef: credential.secretRef ?? null, authEnvVar: null };
        const value = { sessionId: request.sessionId, revision: 0, requestGeneration: 0, subject: request.subject, scope: request.scope, projectPath: request.projectPath, contextId: workspace.effectiveContextId ?? null, profile, baselineFiles: clone(state.disk), common: workspace.common, view, issues: [], descriptor: ['pi','open_code','kimi_code','codex','claude_code'].includes(request.toolId) ? describe(request.toolId, request.subject === 'common') : undefined, sourceCapabilities: [{ source: 'native', available: true, reason: null }, { source: 'account', available: request.subject === 'profile', reason: null }, { source: 'api_key', available: request.subject === 'current' ? (state.currentApiWritable ?? (workspace.effectiveContextId == null && workspace.probe.connectionPolicy?.apiKey.state === 'writable')) : workspace.probe.connectionPolicy?.apiKey.state === 'writable', reason: '当前范围不接受新密钥' }], credential, credentialStatus: credential.secretRef ? 'stored' : 'none', nativeCredentialTarget: request.subject === 'current' ? state.nativeCredentialTarget ?? undefined : undefined, draftConnection, catalogSupport: { available: !!draftConnection, multiple: ['pi','open_code','kimi_code'].includes(request.toolId), reason: null } };
        if (request.subject === 'common') profile.files = clone(state.commonFiles ?? workspace.common?.files ?? {});
        profile.files = Object.keys(profile.files).length ? profile.files : { settings: JSON.stringify(view) }; if (request.subject === 'current') { if (!Object.keys(state.disk).length) state.disk = clone(profile.files); profile.files = clone(state.disk); } value.baselineFiles = clone(profile.files);
        if (state.omitSourceCapabilities) delete (value as any).sourceCapabilities;
        if (credential.secretRef) state.references[credential.secretRef] = draftConnection ? JSON.stringify([draftConnection.providerId,draftConnection.interfaceFormat,draftConnection.baseUrl]) : state.nativeCredentialTarget.identity;
        state.sessions[value.sessionId] = clone(value); return clone(value);
      }
      if (command === 'cancel_configuration_requests') { if (state.cancelRequestFailure) throw { message: state.cancelRequestFailure }; const value = active(args); value.requestGeneration++; state.sessions[value.sessionId] = clone(value); return value; }
      if (command === 'cancel_configuration_draft') { state.cancelled.push(args.sessionId); for (const [key, lease] of Object.entries(state.leases)) if (lease.sessionId === args.sessionId && !lease.adopted) delete state.leases[key]; return null; }
      if (['edit_configuration_draft','update_configuration_draft','select_configuration_credential','set_configuration_draft_secret','add_configuration_models','replace_configuration_text','remove_configuration_draft_secret'].includes(command)) {
        const value = active(args); value.revision++;
        if (command === 'update_configuration_draft') { value.profile.name = args.profile.name; value.profile.inheritCommon = args.profile.inheritCommon; if (!['pi','open_code','kimi_code','codex','claude_code'].includes(value.profile.tool) && args.profile.connection) { value.draftConnection = clone(args.profile.connection); value.profile.connection = value.credential.source === 'api_key' ? clone(args.profile.connection) : null; } }
        if (command === 'select_configuration_credential') { if (args.credential.secretRef && state.references[args.credential.secretRef] !== (value.draftConnection ? JSON.stringify([value.draftConnection.providerId,value.draftConnection.interfaceFormat,value.draftConnection.baseUrl]) : value.nativeCredentialTarget.identity)) throw { message: '密钥引用不属于当前连接' }; value.credentialStatus = args.credential.secretRef ? state.leases[args.credential.secretRef] ? 'draft' : 'stored' : 'none'; if (value.draftConnection) value.draftConnection.secretRef = args.credential.secretRef ?? null; value.credential = clone(args.credential); value.profile.authentication = args.credential.source === 'account' ? { kind: 'oauth', accountId: args.credential.accountId } : { kind: args.credential.source === 'api_key' ? 'api_key' : 'native' }; value.profile.connection = args.credential.source === 'api_key' && value.draftConnection ? { ...value.draftConnection, secretRef: args.credential.secretRef } : null; }
        if (command === 'remove_configuration_draft_secret') { value.credential = { source: 'api_key', secretRef: null, remove: true }; value.credentialStatus = 'removed'; if (value.draftConnection) value.draftConnection.secretRef = null; value.profile.connection = value.draftConnection ? { ...value.draftConnection, secretRef: null } : null; }
        if (command === 'set_configuration_draft_secret') { const ref = `lease-${++state.sequence}`; state.leases[ref] = { sessionId: value.sessionId, adopted: false }; state.references[ref] = (value.draftConnection ? JSON.stringify([value.draftConnection.providerId,value.draftConnection.interfaceFormat,value.draftConnection.baseUrl]) : value.nativeCredentialTarget.identity); value.credential = { source: 'api_key', secretRef: ref }; value.credentialStatus = 'draft'; if (value.draftConnection) value.draftConnection.secretRef = ref; value.profile.connection = clone(value.draftConnection); }
        if (command === 'replace_configuration_text') { value.profile.files = args.files; try { const document = JSON.parse(args.files.settings ?? '{}'); value.view = value.profile.tool === 'claude_code' && value.subject === 'common' ? { commonFields: [{ id: 'effortLevel', value: document.effortLevel ?? null, target: 'configuration' }] } : document; } catch { value.issues = [{ target: null, field: null, code: 'invalid_document', message: '原文语法无效，请修正 JSON' }]; state.sessions[value.sessionId] = clone(value); return value; } }
        if (command === 'add_configuration_models' && !value.catalogSupport.multiple) { if (value.profile.tool === 'claude_code') { value.view.values['default.model'] = args.ids[0]; value.profile.editing.intents.push({version: 1, operation: 'set', target: value.view.editTarget, field: 'default.model', value: args.ids[0]}); } value.draftConnection.model = args.ids[0]; if (value.profile.connection) value.profile.connection.model = args.ids[0]; }
        if (command === 'add_configuration_models' && value.catalogSupport.multiple) for (const id of args.ids) if (!value.view.models.some((model: any) => model.id === id)) value.view.models.push({ id, kind: 'model', fields: value.profile.tool === 'kimi_code' ? { model: id, provider: value.view.providerId } : {} });
        if (command === 'edit_configuration_draft') {
          const action = args.action; value.profile.editing.intents.push(clone(action));
          if (value.subject === 'common') value.view.commonFields[0].value = action.operation === 'reset' ? null : action.value;
          else if (value.view.values) {
            if (action.operation === 'reset') delete value.view.values[action.field]; else value.view.values[action.field] = action.value;
            if (value.profile.tool === 'codex' && value.draftConnection) {
              value.draftConnection.providerId = value.view.values.model_provider ?? '';
              value.draftConnection.baseUrl = value.view.values.base_url ?? '';
              value.draftConnection.model = value.view.values.model ?? '';
              value.profile.connection = value.credential.source === 'api_key' ? clone(value.draftConnection) : null;
            }
          }
          else if (action.operation === 'select_provider') value.view.providerId = action.target.provider;
          else if (action.operation === 'configure_provider') { value.view.providerId = action.target.provider; value.view.connection = { baseUrl: action.value.baseUrl, protocol: 'openai' }; value.draftConnection.baseUrl = action.value.baseUrl; }
          else if (action.operation === 'create') value.view.models.push({ id: action.target.id, kind: action.target.kind, fields: { ...action.value, provider: action.target.provider } });
          else if (action.operation === 'default') value.view.defaultModel = action.target.id;
          else { const model = value.view.models.find((model: any) => model.id === action.target.id); if (model) setPath(model.fields, action.field, action.operation === 'reset' ? null : action.value); }
        }
        if (state.delayEdit && command === 'edit_configuration_draft') await new Promise<void>(resolve => { state.releaseEdit = resolve; });
        return refresh(value, command !== 'replace_configuration_text');
      }
      if (command === 'list_configuration_models') { const response = { sessionId: args.draft.sessionId, revision: args.draft.revision, requestGeneration: args.draft.requestGeneration ?? 0, directory: { models: ['one','new-1','new-2'], status: state.directoryFailure ? 'error' : 'ready', fetchedAt: 1791200000, error: state.directoryFailure || null, source: 'synthetic provider' } }; if (state.delayDirectory) await new Promise<void>(resolve => { state.releaseDirectory = resolve; }); return response; }
      if (command === 'check_configuration_connection') return { sessionId: args.draft.sessionId, revision: args.draft.revision, requestGeneration: args.draft.requestGeneration ?? 0, check: { format: { message: '格式正确', state: 'passed' }, connectivity: { message: '合成非推理检查通过', state: 'passed' }, modelRequest: { message: args.allowModelRequest ? '用户明确请求' : '未发送推理', state: args.allowModelRequest ? 'passed' : 'skipped' } } };
      if (command === 'save_configuration_draft') {
        const value = active(args); if (value.subject === 'current' && JSON.stringify(value.baselineFiles) !== JSON.stringify(state.disk)) throw { message: '当前文件有外部修改，请比较后再保存' }; const profile = value.subject === 'profile' ? { ...value.profile, id: value.profile.id || 'saved-config', version: value.profile.version + 1 } : null;
        const common = value.subject === 'common' ? { tool: value.profile.tool, version: 2, revision: 'common-2', files: value.profile.files } : null;
        value.revision++; if (value.credential.source === 'api_key' && value.credential.secretRef) value.credentialStatus = 'stored';
        if (profile) { value.profile = profile; const harness = (window as any).workspaceFixture ?? (window as any).oauthHarness; if (harness) harness.profiles = [...harness.profiles.filter((item: any) => item.id !== profile.id), profile]; }
        for (const lease of Object.values(state.leases)) if (lease.sessionId === value.sessionId && value.credential.source === 'api_key') lease.adopted = true;
        if (value.subject === 'current') state.disk = clone(value.profile.files);
        state.sessions[value.sessionId] = clone(value); return { draft: value, profile, common, application: value.subject === 'current' ? { transactionId: 'current', changedFiles: ['fixture'], status: 'written_for_next_session' } : null };
      }
      if (command === 'compare_configuration_current') {
        const value = active(args); const id = `compare-${++state.sequence}`;
        state.comparisons[id] = { disk: clone(state.disk), sessionId: value.sessionId, revision: value.revision };
        return { comparisonId: id, sessionId: value.sessionId, revision: value.revision, contextId: value.contextId, files: Object.keys(value.profile.files).map(role => ({ role, original: value.baselineFiles[role] ?? '', current: state.disk[role] ?? '', edited: value.profile.files[role] ?? '' })) };
      }
      if (command === 'rebase_configuration_current') {
        const value = active(args); const comparison = state.comparisons[args.comparisonId];
        if (!comparison || comparison.sessionId !== value.sessionId || comparison.revision !== value.revision || JSON.stringify(comparison.disk) !== JSON.stringify(state.disk)) throw { message: '比较后文件再次变化，请重新比较' };
        value.revision++; value.baselineFiles = clone(state.disk); value.profile.files = clone(args.files); value.view = JSON.parse(value.profile.files.settings); return refresh(value, false);
      }
      if (command === 'preview_configuration_backup') { const value = active(args); state.backupPreview = { disk: clone(state.disk), revision: value.revision }; return { sessionId: value.sessionId, revision: value.revision, role: args.role, transactionId: args.transactionId, current: state.disk[args.role] ?? '', original: state.backupOriginal || state.disk[args.role] }; }
      if (command === 'restore_configuration_backup') { const value = active(args); if (!state.backupPreview || state.backupPreview.revision !== value.revision || JSON.stringify(state.backupPreview.disk) !== JSON.stringify(state.disk)) throw { message: '历史比较后文件变化，重新查看再恢复' }; value.revision++; state.disk[args.role] = state.backupOriginal || state.disk[args.role]; value.profile.files[args.role] = state.disk[args.role]; value.baselineFiles[args.role] = state.disk[args.role]; return { draft: value, profile: null, common: null, application: { transactionId: args.transactionId, changedFiles: [args.role], status: 'written_for_next_session' } }; }
      if (command === 'common_influence') return { toolId: args.toolId, commonVersion: 1, commonRevision: 'common-1', targets: [{ scopeKey: 'global', profileId: 'existing', profileName: '工作配置', profileVersion: 3, profileRevision: 'revision-3', appliedVersion: 1, contextId: null, scope: 'global', projectPath: null }, { scopeKey: 'project:/tmp/project', profileId: 'existing', profileName: '项目配置', profileVersion: 3, profileRevision: 'revision-3', appliedVersion: 1, contextId: null, scope: 'project', projectPath: '/tmp/project' }] };
      if (command === 'apply_common_configuration') return args.targets.map((target: any) => ({ scopeKey: target.scopeKey, profileId: target.profileId, status: state.commonFailures.includes(target.scopeKey) ? 'failed' : 'written_for_next_session', detail: state.commonFailures.includes(target.scopeKey) ? '外部修改，请重新比较' : null }));
      if (command === 'reveal_configuration_draft_secret') return 'fixture-draft-secret';
      if (command === 'get_connection_secret') return 'fixture-stored-secret';
      return previous(command, args);
    };
  });
}

export async function installConfigurationWorkspace(page: Page, toolId = 'kimi_code', apiWritable = true, appliedOld = false, toolIds = [toolId]) {
  await page.addInitScript(({ toolId, apiWritable, appliedOld, toolIds }) => {
    const account = (id: string, owner = toolId) => ({ id, label: `${id}账号`, toolId: owner, version: 1, state: 'signed_in', identity: { subject: id, email: `${id}@example.test`, source: 'fixture' }, context: { id: `ctx-${id}` }, retiredContexts: [], pendingLogin: null, detail: null });
    const fixture = { profiles: [{ id: 'existing', tool: toolId, name: '工作配置', version: 3, revision: 'revision-3', files: {}, suppressed: {}, nativeCredentials: {}, inheritCommon: true, authentication: { kind: 'api_key' }, connection: { providerId: 'gateway', interfaceFormat: 'openai_completions', baseUrl: 'https://gateway.example.test/v1', model: 'one', secretRef: 'saved-original', authEnvVar: null } }], binding: { scopeKey: 'global', tool: toolId, profileId: 'existing', profileVersion: appliedOld ? 2 : 3, contextId: null, managed: {}, commonVersion: 1, commonRevision: 'common-1', appliedProfileAvailable: true, appliedSummary: appliedOld ? { authentication: { kind: 'native' }, providerId: 'old-provider', baseUrl: 'https://old.example.test', model: 'old-model', contextId: null, profileVersion: 2, profileRevision: 'old-revision' } : { authentication: { kind: 'api_key' }, providerId: 'gateway', baseUrl: 'https://gateway.example.test/v1', model: 'one', contextId: null, profileVersion: 3, profileRevision: 'revision-3' } }, accounts: [account('a'), account('b'), ...toolIds.filter(id => id !== toolId).map(id => account(`${id}-a`, id))], modelSummaries: {} as Record<string, any>, effectiveContextId: null as string | null, nativeContextError: null as string | null, delayAccountCheck: false, releaseAccountCheck: null as (() => void) | null, calls: [] as any[] };
    Object.assign(window, { workspaceFixture: fixture, isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      fixture.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: toolIds, theme: 'system' }, tools: toolIds.map(id => ({ id, name: id })) };
      if (command === 'list_cli_adapters') return { registered: toolIds.map(id => ({ id, name: id, interfaceFormats: ['openai_completions'], management: { accounts: id !== 'kimi_code', mcp: true, skills: true, agents: true, plugins: true, projectPlugins: true } })), managedIds: toolIds, preservedUnknown: [] };
      if (command === 'list_accounts') return structuredClone(fixture.accounts);
      if (command === 'account_capabilities') return toolIds.filter(id => id !== 'kimi_code').map(id => ({ toolId: id, provider: 'fixture', managedLogin: true, methods: ['browser'], reason: 'fixture only' }));
      if (command === 'create_account') { const value = { ...account('new'), label: args.label, state: 'signed_out', identity: null, context: null }; fixture.accounts.push(value as any); return structuredClone(value); }
      if (command === 'start_account_login') { const value: any = fixture.accounts.find(account => account.id === args.id); value.version++; value.state = 'pending'; value.pendingLogin = { id: 'login-1', operation: 'login' }; return structuredClone(value); }
      if (command === 'cancel_account_login') { const value: any = fixture.accounts.find(account => account.id === args.id); value.version++; value.pendingLogin = null; value.state = 'signed_out'; return structuredClone(value); }
      if (command === 'check_account') { const value = structuredClone(fixture.accounts.find(account => account.id === args.id)); if (fixture.delayAccountCheck) await new Promise<void>(resolve => { fixture.releaseAccountCheck = resolve; }); return value; }
      if (command === 'discover_native_logins') return { toolId, checkedAt: 1, logins: [{ provider: 'fixture', authKind: 'oauth', state: 'signed_in', identity: { subject: 'native', email: 'native@example.test' }, detail: '只读合成观察', managedAccountId: null }] };
      if (command === 'get_registered_tool_workspace') return { probe: { tool: toolId, selectedPath: '/fixture/cli', installations: [{ path: '/fixture/cli', version: 'fixture-only', status: 'available', source: 'native' }], nativeFiles: [{ role: 'settings', path: '/fixture/config.json', format: 'json', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, connectionPolicy: { apiKey: { state: apiWritable ? 'writable' : 'scope_denied', reason: apiWritable ? '' : '项目不保存新密钥' }, providerAddress: { state: 'configurable', reason: '' }, projection: 'provider_models' }, interfaceFormats: ['openai_completions'], providerPresets: [], dependencies: [], installUrl: 'https://example.test', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null }, profiles: structuredClone(fixture.profiles), profileModelSummaries: Object.keys(fixture.modelSummaries).length ? structuredClone(fixture.modelSummaries) : undefined, common: { tool: toolId, version: 1, revision: 'common-1', files: {} }, binding: structuredClone(fixture.binding), effectiveContextId: fixture.effectiveContextId, nativeContextError: fixture.nativeContextError, snapshots: fixture.nativeContextError ? [] : [{ role: 'settings', text: '{}', fingerprint: 'present', error: null }], recoveryNeeded: [], customPath: null };
      if (command === 'apply_registered_native_profile') { if ((window as any).configurationProtocol.applyFailure) throw { message: (window as any).configurationProtocol.applyFailure }; const profile = fixture.profiles.find(profile => profile.id === args.profileId)!; fixture.binding.profileId = profile.id; fixture.binding.profileVersion = profile.version; return { transactionId: 'apply', changedFiles: [], status: 'written_for_next_session' }; }
      if (command === 'list_native_backups') return [{ transactionId: 'backup-1', path: '/fixture/backup', createdAt: 1791200000 }];
      if (command === 'read_registered_native_file_for_edit') return '{}';
      if (command === 'preview_registered_native_profile') return { rendered: args.profile.files, documents: {}, sources: { settings: { '/model': '通用配置', '/model_context_window': '命名配置' } } };
      if (command === 'inspect_registered_native_draft') return { connection: null, providerId: null, model: null, reasoningEffort: null };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_') || command === 'scan_native_skills') return [];
      return null;
    } } });
  }, { toolId, apiWritable, appliedOld, toolIds });
  await installConfigurationProtocol(page);
}

export async function setupConfigurationWorkspace(page: Page, toolId = 'kimi_code', apiWritable = true, appliedOld = false, toolIds = [toolId]) {
  await installConfigurationWorkspace(page, toolId, apiWritable, appliedOld, toolIds);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
}
