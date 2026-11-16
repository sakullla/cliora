/** Browser-only prompt IPC model. It adapts legacy library fixtures and supplies explicit rich scenarios. */
export function installPromptFixtureBridge() {
  const fixture = window.__promptFixture ??= { documents: null, metadata: {}, usage: {}, receipts: {}, calls: [], snapshots: {}, version: 1, failRead: false, failTitle: '', files: {}, delayedRead: null, delayNextRead: false };
  fixture.knownDocuments ??= {};
  function wrap(internals) {
    if (!internals?.invoke || internals.__promptBridge) return internals;
    internals.__promptBridge = true;
    const original = internals.invoke;
    const source = args => args.targetId || 'local';
    const stamp = () => ({ '$HOME/.cliora/library.json': fixture.version.toString(16).padStart(64, '0'), '$HOME/.cliora/prompts-v1.json': fixture.version.toString(16).padStart(64, '0') });
    const metadata = (host, item) => fixture.metadata[`${host}:${item.id}`] ?? { scope: item.scope ?? (item.projectId ? { kind: 'workspace', workspaceId: item.projectId } : { kind: 'global' }), tags: item.tags ?? (item.category || '').split(/[,，、]/).filter(Boolean) };
    const docs = async (host, search = '') => {
      if (fixture.documents) return fixture.documents[host] ?? [];
      const rows = await original(host === 'local' ? 'list_library_items' : 'list_remote_library_items', { targetId: host === 'local' ? null : host, kind: 'prompt', projectId: null, search });
      const values = (Array.isArray(rows) ? rows : []).filter(item => item.kind === 'prompt').map(item => ({ id: item.id, title: item.title, body: item.body, version: item.version, updatedAt: item.updatedAt, legacyProjectId: item.projectId ?? null, ...metadata(host, item) }));
      for (const value of values) fixture.knownDocuments[`${host}:${value.id}`] = structuredClone(value);
      return values;
    };
    const saveDoc = async (host, draft, id = crypto.randomUUID()) => {
      if (draft.title === fixture.failTitle || !draft.title.trim()) throw new Error('fixture: invalid title');
      const rows = fixture.documents ? await docs(host) : draft.id ? await docs(host).catch(error => { const known = fixture.knownDocuments[`${host}:${draft.id}`]; if (!known) throw error; return [known]; }) : [];
      const old = draft.id ? rows.find(row => row.id === draft.id) : null;
      if (draft.id && (!old || old.version !== draft.expectedVersion)) throw new Error('版本冲突');
      let saved;
      if (fixture.documents) {
        saved = { id: old?.id ?? id, title: draft.title.trim(), body: draft.body, scope: draft.scope, tags: draft.tags, version: (old?.version ?? 0) + 1, updatedAt: Date.now() / 1000, legacyProjectId: old?.legacyProjectId ?? null };
        const index = rows.findIndex(row => row.id === saved.id); if (index < 0) rows.push(saved); else rows[index] = saved;
      } else {
        const item = await original(host === 'local' ? 'save_library_item' : 'save_remote_library_item', { targetId: host === 'local' ? null : host, draft: { id: draft.id, kind: 'prompt', title: draft.title, body: draft.body, category: draft.tags.join(','), projectId: old?.legacyProjectId ?? null, expectedVersion: draft.expectedVersion } });
        saved = { id: item.id, title: item.title, body: item.body, scope: draft.scope, tags: draft.tags, version: item.version, updatedAt: item.updatedAt, legacyProjectId: item.projectId ?? null };
      }
      fixture.knownDocuments[`${host}:${saved.id}`] = structuredClone(saved);
      fixture.metadata[`${host}:${saved.id}`] = { scope: saved.scope, tags: saved.tags };
      return structuredClone(saved);
    };
    const applies = (scope, query) => query.scopeFilter ? JSON.stringify(scope) === JSON.stringify(query.scopeFilter) : query.includeOtherScopes || scope.kind === 'global' || (scope.kind === 'workspace' && scope.workspaceId === query.workspaceId) || (scope.kind === 'repository' && scope.repositoryId === query.repositoryId);
    internals.invoke = async (command, args = {}) => {
      if (command === 'get_remote_write_snapshot') return fixture.snapshots[args.requestId] ?? await original(command, args);
      if (command === 'list_business_workspaces') {
        const current = await original(command, args);
        if ((Array.isArray(current) && current.length) || !window.__promptLegacyWorkspaces) return current;
        const projects = await original('list_projects', {});
        return (Array.isArray(projects) ? projects : []).map(project => ({ id: project.id, name: project.name, revision: 1, manifestPath: null, manifestRevision: null, error: null, repositories: [{ id: project.id, name: project.name, favorite: false, locations: [] }] }));
      }
      if (!['query_prompts' , 'get_prompt', 'save_prompt', 'apply_prompt_batch', 'preview_prompt_import', 'delete_prompt', 'record_prompt_usage'].includes(command)) return original(command, args);
      fixture.calls.push({ command, args: structuredClone(args) });
      const host = source(args);
      if (fixture.failRead && ['query_prompts', 'get_prompt'].includes(command)) throw { message: 'fixture: prompt source unavailable' };
      if (host !== 'local' && ['save_prompt', 'apply_prompt_batch', 'delete_prompt'].includes(command)) {
        const expected = args.operation?.expectedFiles;
        if (!expected || Object.entries(stamp()).some(([path, version]) => expected[path] !== version)) throw { message: 'fixture: remote baseline conflict' };
      }
      let value;
      if (command === 'query_prompts') {
        const query = args.query || {}; const needle = (query.search || '').trim().toLowerCase();
        const matches = (await docs(host, query.search || '')).filter(item => {
          const usage = fixture.usage[`${host}:${item.id}`] ?? {};
          return applies(item.scope, query) && (!query.favoritesOnly || usage.favorite) && (!query.recentOnly || usage.lastUsed) && (query.tags || []).every(tag => item.tags.includes(tag)) && (!needle || `${item.title} ${item.body} ${item.tags.join(' ')}`.toLowerCase().includes(needle));
        }).sort((a, b) => { const ua = fixture.usage[`${host}:${a.id}`] ?? {}; const ub = fixture.usage[`${host}:${b.id}`] ?? {}; return Number(!!ub.favorite) - Number(!!ua.favorite) || (ub.lastUsed || 0) - (ua.lastUsed || 0) || a.title.localeCompare(b.title); });
        const offset = query.offset || 0; const limit = query.limit || 40;
        const items = matches.slice(offset, offset + limit).map(({ body, legacyProjectId: _legacy, ...item }) => ({ ...item, preview: body.slice(0, 160) + (body.length > 160 ? '…' : ''), favorite: false, lastUsed: 0, ...(fixture.usage[`${host}:${item.id}`] ?? {}) }));
        value = { items, total: matches.length, nextOffset: offset + items.length < matches.length ? offset + items.length : null, tags: [...new Set(matches.flatMap(item => item.tags))].sort() };
      } else if (command === 'get_prompt') {
        const rows = await docs(host).catch(error => { const known = fixture.knownDocuments[`${host}:${args.id}`]; if (!known) throw error; return [known]; });
        const item = rows.find(item => item.id === args.id);
        if (!item || (args.expectedVersion != null && args.expectedVersion !== item.version)) throw { message: '提示词已更新，请重新选择' };
        value = structuredClone(item);
        if (fixture.delayNextRead) { fixture.delayNextRead = false; return new Promise(resolve => { fixture.delayedRead = () => resolve(value); }); }
      } else if (command === 'save_prompt') { value = await saveDoc(host, args.draft); fixture.version++; }
      else if (command === 'record_prompt_usage') { const key = `${host}:${args.id}`; const usage = fixture.usage[key] ??= { favorite: false, lastUsed: 0 }; if (args.favorite != null) usage.favorite = args.favorite; if (args.used) usage.lastUsed = Date.now(); value = null; }
      else if (command === 'delete_prompt') {
        if (fixture.documents) fixture.documents[host] = (await docs(host)).filter(item => item.id !== args.id);
        else await original(host === 'local' ? 'delete_library_item' : 'delete_remote_library_item', args);
        fixture.version++; value = null;
      } else if (command === 'preview_prompt_import') {
        const input = args.input; const entries = input.jsonText.trim() ? JSON.parse(input.jsonText) : [];
        for (const path of input.files) entries.push(...(path.endsWith('.json') ? JSON.parse(fixture.files[path]) : [{ title: path.split('/').pop().replace(/\.[^.]+$/, ''), body: fixture.files[path] ?? 'fixture file\nsecond line' }]));
        const existing = await docs(host);
        value = { operationId: crypto.randomUUID(), rows: entries.map(entry => ({ item: { itemId: crypto.randomUUID(), action: 'create', draft: { id: null, title: entry.title, body: entry.body, tags: entry.tags || input.tags, scope: entry.scope || input.scope, expectedVersion: null } }, matches: existing.filter(item => item.title === entry.title || item.body === entry.body).map(item => ({ id: item.id, title: item.title, scope: item.scope, version: item.version, sameBody: item.body === entry.body })), error: entry.title.trim() ? null : '标题不能为空' })) };
      } else {
        const results = []; let changed = false;
        for (const item of args.batch.items) {
          const key = `${host}:${args.batch.operationId}:${item.itemId}`; const digest = JSON.stringify(item); const old = fixture.receipts[key];
          if (old) { results.push(old.digest === digest ? old.result : { itemId: item.itemId, status: 'conflict', id: null, version: null, error: '批次条目已保存' }); continue; }
          try {
            let saved = null;
            if (item.action !== 'skip') {
              let draft = item.draft;
              if (item.action === 'reclassify') { const current = (await docs(host)).find(doc => doc.id === draft.id); draft = { ...draft, title: current.title, body: current.body }; }
              saved = await saveDoc(host, draft, item.itemId);
            }
            const result = { itemId: item.itemId, status: saved ? 'saved' : 'skipped', id: saved?.id ?? null, version: saved?.version ?? null, error: null };
            fixture.receipts[key] = { digest, result }; results.push(result); changed = true;
          } catch (error) { results.push({ itemId: item.itemId, status: String(error.message).includes('版本') ? 'conflict' : 'failed', id: item.draft.id, version: null, error: String(error.message) }); }
        }
        if (changed) fixture.version++;
        value = { operationId: args.batch.operationId, items: results, writeApplied: changed };
      }
      if (args.operation?.requestId) fixture.snapshots[args.operation.requestId] = stamp();
      return structuredClone(value);
    };
    return internals;
  }
  if (window.__TAURI_INTERNALS__) wrap(window.__TAURI_INTERNALS__);
  else {
    let current;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, enumerable: true, get: () => current, set: value => { current = wrap(value); } });
  }
}

export function installRichPromptFixtures() {
  window.__promptFixture ??= { documents: null, metadata: {}, usage: {}, receipts: {}, calls: [], snapshots: {}, version: 1, failRead: false, failTitle: '', files: {}, delayedRead: null, delayNextRead: false };
  const doc = (id, title, body, scope = { kind: 'global' }, tags = ['review']) => ({ id, title, body, scope, tags, version: 1, updatedAt: 1, legacyProjectId: null });
  window.__promptFixture.documents = {
    local: [doc('general', '通用审查', '先检查边界，再检查错误恢复。'), doc('project-a', '项目 A 发布', 'A 的发布说明\n逐项确认回滚步骤。', { kind: 'workspace', workspaceId: 'workspace-commerce' }, ['release']), doc('project-b', '项目 B 发布', 'B-only-secret-scope', { kind: 'workspace', workspaceId: 'workspace-payments' }, ['release']), doc('repo-a', 'API 回归', 'API-specific-body', { kind: 'repository', repositoryId: 'repo-0' }, ['test']), ...Array.from({ length: 120 }, (_, i) => doc(`large-${i}`, `模板 ${String(i).padStart(3, '0')}`, `${'长正文 '.repeat(50)}全文后段命中-${i}\n保留多行。`))],
    'remote-a': [doc('remote-only', '远端审查', 'remote-only-body')],
  };
}
