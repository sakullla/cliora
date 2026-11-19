/** Synthetic project membership; shared by Playwright tests and the existing capture gallery. */
export function installWorkspaceFixtures() {
  const original = window.__TAURI_INTERNALS__.invoke;
  const host = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const repository = (id, name, path) => ({ id, name, favorite: false, locations: [{ id: `location-${id}`, hostId: host, path, projectId: null, targetId: null, available: true, kind: 'repository', reason: null, worktrees: [{ name: 'main', branch: 'main', path, current: true }, { name: 'feature', branch: 'feature/search', path: `${path}-feature`, current: false }] }] });
  // `__workspaceRepositoryCount` sizes the first project (a large-project scenario sets it to hundreds);
  // `__workspaceEmptyProjects` starts a first-run app with no project at all.
  const count = Math.max(48, Number(window.__workspaceRepositoryCount) || 48);
  const workspaces = window.__workspaceEmptyProjects ? [] : [
    { id: 'workspace-commerce', name: '电商平台', revision: 1, manifestPath: null, manifestRevision: null, error: null, repositories: Array.from({ length: count }, (_, i) => repository(`repo-${i}`, i < 2 ? 'api' : `service-${String(i).padStart(2, '0')}`, `/work/commerce/${i < 2 ? `team-${i}/api` : `service-${String(i).padStart(2, '0')}`}`)) },
    { id: 'workspace-payments', name: '支付系统', revision: 1, manifestPath: null, manifestRevision: null, error: null, repositories: [repository('pay-api', 'payment-api', '/work/payments/api')] },
  ];
  // One moved checkout: the entry stays visible as missing and other repositories keep working.
  const moved = workspaces[0]?.repositories[46];
  if (moved) moved.locations = [{ ...moved.locations[0], available: false, reason: '目录不存在', worktrees: [] }];
  const fixture = { workspaces, calls: [], launches: [], failBatch: false, failDelete: false, scanDelayed: false, scanResolve: null, saved: [], dialogPath: null, contexts: [], sessions: [], preview: null };
  window.__workspaceFixture = fixture;
  const copy = value => structuredClone(value);
  const find = id => workspaces.find(item => item.id === id);
  // A checkout can disappear between two reads; the page hears the new list exactly like a refresh.
  fixture.setWorktrees = (workspaceId, repositoryId, worktrees) => {
    const row = find(workspaceId);
    row.repositories.find(repo => repo.id === repositoryId).locations[0].worktrees = copy(worktrees);
    row.revision++;
    window.dispatchEvent(new CustomEvent('cliora:business-workspaces-changed', { detail: { workspace: copy(row) } }));
  };
  const candidates = [
    { path: '/work/new/api', name: 'api', kind: 'repository', reason: null, commonDirectory: '/work/new/api/.git' },
    { path: '/work/new/web', name: 'web', kind: 'repository', reason: null, commonDirectory: '/work/new/web/.git' },
    { path: '/work/new/private', name: 'private', kind: 'unavailable', reason: 'Permission denied', commonDirectory: null },
  ];
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    fixture.calls.push({ command, args: copy(args) });
    if (command === 'list_business_workspaces') return copy(workspaces);
    if (command === 'list_workspace_session_contexts') return copy(fixture.contexts);
    if (command === 'create_business_workspace') { const row = { id: `workspace-${workspaces.length}`, name: args.name, revision: 1, manifestPath: null, manifestRevision: null, error: null, repositories: [] }; workspaces.push(row); return copy(row); }
    if (command === 'delete_business_workspace') { if (fixture.failDelete) throw { message: '项目文件被其他窗口占用' }; const at = workspaces.findIndex(item => item.id === args.workspaceId); if (at >= 0) workspaces.splice(at, 1); return null; }
    if (command === 'rename_business_workspace') { const row = find(args.workspaceId); if (row.revision !== args.expectedVersion) throw { message: '项目已在其他窗口更新' }; row.name = args.name; row.revision++; return copy(row); }
    if (command === 'favorite_workspace_repository') { const row = find(args.workspaceId); row.repositories.find(repo => repo.id === args.repositoryId).favorite = args.favorite; return copy(row); }
    if (command === 'refresh_workspace_manifest') return copy(find(args.workspaceId));
    if (command === 'scan_workspace_repositories') { if (fixture.scanDelayed) return new Promise(resolve => { fixture.scanResolve = resolve; }); return { candidates: copy(candidates), cancelled: false, partial: false }; }
    if (command === 'cancel_workspace_scan') { fixture.scanResolve?.({ candidates: copy(candidates), cancelled: true, partial: true }); fixture.scanResolve = null; return null; }
    if (command === 'add_workspace_repositories') {
      const row = find(args.workspaceId);
      if (row.revision !== args.expectedVersion) throw { message: '项目已在其他窗口更新，请刷新后重试' };
      return args.paths.map(path => {
        if (fixture.failBatch && path.endsWith('/web')) return { path, repositoryId: null, error: '目录不可访问' };
        const id = `added:${path}`;
        if (!row.repositories.some(repo => repo.id === id)) row.repositories.push(repository(id, path.split('/').pop(), path));
        row.revision++; return { path, repositoryId: id, error: null };
      });
    }
    if (command === 'remove_workspace_repository') { const row = find(args.workspaceId); row.repositories = row.repositories.filter(repo => repo.id !== args.repositoryId); row.revision++; return copy(row); }
    if (command === 'relink_workspace_repository') { const row = find(args.workspaceId); const repo = row.repositories.find(repo => repo.id === args.repositoryId); repo.locations = repository(repo.id, repo.name, args.path).locations; row.revision++; return copy(row); }
    if (command === 'export_workspace_manifest') { const row = find(args.workspaceId); row.manifestPath = args.path; row.manifestRevision = row.revision; return copy(row); }
    if (command === 'preview_workspace_manifest' || command === 'preview_workspace_link') {
      const manifest = { schemaVersion: 1, workspaceId: 'shared-workspace', name: '共享研发项目', revision: 3, repositories: [repository('shared-api', 'shared-api', '/work/shared/api')].map(repo => ({ id: repo.id, name: repo.name, locations: repo.locations.map(({ hostId, path }) => ({ hostId, path })) })) };
      fixture.preview = { manifest, path: args.path || '/work/shared.dev-workspace.json', digest: 'fixture-digest', conflict: false }; return copy(fixture.preview);
    }
    if (command === 'attach_workspace_manifest') { const preview = fixture.preview; const row = { id: preview.manifest.workspaceId, name: preview.manifest.name, revision: preview.manifest.revision, manifestPath: preview.path, manifestRevision: preview.manifest.revision, error: null, repositories: preview.manifest.repositories.map(repo => repository(repo.id, repo.name, repo.locations[0].path)) }; if (!find(row.id)) workspaces.push(row); return copy(row); }
    if (command === 'launch_workspace_cli') { fixture.launches.push(copy(args)); const id = 'workspace-session'; fixture.sessions = [{ id, toolId: args.request.toolId, projectId: null, directory: args.request.directory, mode: 'normal', running: false, exitCode: 0 }]; fixture.contexts = [{ sessionId: id, workspaceId: args.workspaceId, repositoryId: args.repositoryId, hostId: host, directory: args.request.directory }]; return { toolId: args.request.toolId, projectId: null, mode: 'normal', terminal: 'workbench', status: 'session_started', sessionId: id, warnings: [] }; }
    if (command === 'list_workbench_sessions' && fixture.sessions.length) return copy(fixture.sessions);
    if (command === 'plugin:dialog|open') return fixture.dialogPath || (args.options?.directory ? (args.options.multiple ? ['/work/new/api', '/work/new/web'] : '/work/new') : '/work/shared.dev-workspace.json');
    if (command === 'plugin:dialog|save') return '/work/commerce.dev-workspace.json';
    return original(command, args);
  };
}
