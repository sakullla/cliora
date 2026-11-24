import test from 'node:test';
import assert from 'node:assert/strict';
import { inferWorkspaceScope } from '../../src/lib/workspaceScope.ts';

const location = (path, extra = {}) => ({ id: path, hostId: 'h', path, projectId: null, targetId: null, available: true, kind: 'repository', reason: null, worktrees: [], ...extra });
const workspaces = [
  { id: 'e2e', name: '端到端', revision: 1, manifestPath: null, manifestRevision: null, error: null, repositories: [
    { id: 'biz', name: 'demo-app-example-service', favorite: false, locations: [location('/Users/me/demo/demo-app-example-service', { projectId: 'p-biz', worktrees: [{ name: 'fix', branch: 'fix', path: '/Users/me/worktrees/fix', current: false }] })] },
    { id: 'root', name: 'demo', favorite: false, locations: [location('/Users/me/demo')] },
  ] },
  { id: 'qs', name: '示例工作区', revision: 1, manifestPath: null, manifestRevision: null, error: null, repositories: [
    { id: 'menu', name: 'menu', favorite: false, locations: [location('/Users/me/demo-group/menu'), location('/remote/menu', { targetId: 'ssh-1' })] },
  ] },
];

test('a restored session without a saved binding finds its project by checkout path', () => {
  assert.deepEqual(inferWorkspaceScope({ directory: '/Users/me/demo/demo-app-example-service/', projectId: null }, workspaces), { workspaceId: 'e2e', repositoryId: 'biz' });
  assert.deepEqual(inferWorkspaceScope({ directory: '/Users/me/worktrees/fix', projectId: null }, workspaces), { workspaceId: 'e2e', repositoryId: 'biz' });
});

test('the native directory project and the deepest containing member are later fallbacks', () => {
  assert.deepEqual(inferWorkspaceScope({ directory: '/elsewhere', projectId: 'p-biz' }, workspaces), { workspaceId: 'e2e', repositoryId: 'biz' });
  assert.deepEqual(inferWorkspaceScope({ directory: '/Users/me/demo/demo-app-example-service/src', projectId: null }, workspaces), { workspaceId: 'e2e', repositoryId: 'biz' });
  assert.deepEqual(inferWorkspaceScope({ directory: '/Users/me/demo/other', projectId: null }, workspaces), { workspaceId: 'e2e', repositoryId: 'root' });
});

test('remote locations, unrelated folders and ambiguous claims are not guessed', () => {
  assert.equal(inferWorkspaceScope({ directory: '/remote/menu', projectId: null }, workspaces), null);
  assert.equal(inferWorkspaceScope({ directory: '/tmp/x', projectId: null }, workspaces), null);
  const twice = [...workspaces, { ...workspaces[1], id: 'qs2', repositories: [{ ...workspaces[1].repositories[0], id: 'menu2' }] }];
  assert.equal(inferWorkspaceScope({ directory: '/Users/me/demo-group/menu', projectId: null }, twice), null);
});

test('windows paths compare without case or separator differences', () => {
  const win = [{ ...workspaces[1], repositories: [{ id: 'w', name: 'w', favorite: false, locations: [location('C:\\Work\\Repo')] }] }];
  assert.deepEqual(inferWorkspaceScope({ directory: 'c:/work/repo/', projectId: null }, win), { workspaceId: 'qs', repositoryId: 'w' });
});
