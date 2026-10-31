import { expect, test, type Page } from '@playwright/test';

type Manifest = { name: string | null; description: string; license: string | null; compatibility: string | null; metadata: Array<{ key: string; value: string }>; allowedTools: string[]; extra: Array<{ key: string; value: string }>; bodyLine: number; issues: Array<{ code: string; limit: number | null; actual: number | null }> };

const manifest = (fields: Partial<Manifest>): Manifest => ({ name: null, description: '', license: null, compatibility: null, metadata: [], allowedTools: [], extra: [], bodyLine: 0, issues: [], ...fields });
const issue = (code: string, limit: number | null = null, actual: number | null = null) => ({ code, limit, actual });

const PDF = '---\nname: pdf-processing\ndescription: Extract PDFs.\nlicense: Apache-2.0\nmetadata:\n  author: example-org\n  version: "1.0"\nallowed-tools: Bash(git:*) Read\n---\n# PDF guide\n\nUse the scripts. Read [the reference](references/REFERENCE.md), run `scripts/extract.py`, follow [shared usage](../_shared/core.md#usage) and skip [a missing note](references/nope.md).\n';
const MINIMAL = '---\nname: minimal\ndescription: Only the basics.\n---\n# Minimal body\n';
const CRUD = '---\nname: other-name\ndescription:\n---\n# page\n';
const CRUD_FIXED = '---\nname: crud-page\ndescription: Builds CRUD pages.\n---\n# page\n';
const BROKEN = '---\nname: [broken\n---\n# Broken body\n';

/** One synthetic native store: documents by path, a manifest per document text, and attachments per path. */
async function mockSkills(page: Page, options: { remote?: boolean } = {}) {
  await page.addInitScript(({ docs, manifests }) => {
    const root = '/tmp/.codex/skills';
    const documents: Record<string, string> = Object.fromEntries(Object.entries(docs).map(([name, text]) => [`${root}/${name}`, text]));
    const issuesOf = (text: string) => (manifests[text]?.issues ?? []).map((item: { code: string }) => item.code);
    const entries = Object.keys(docs).map(name => ({ name, path: `${root}/${name}`, digest: null, state: 'external', detail: manifests[docs[name]]?.description ?? '', packageId: null, source: 'writable', issues: issuesOf(docs[name]) }));
    // A store saved before issues existed has no `issues` field.
    entries.push({ name: 'legacy', path: `${root}/legacy`, digest: null, state: 'external', detail: 'Old store entry', packageId: null, source: 'writable' } as never);
    documents[`${root}/legacy`] = '# legacy\n';
    const attachments: Record<string, unknown> = {
      [`${root}/pdf-processing`]: { truncated: false, files: [
        { path: 'assets/logo.png', size: 7, readable: true, detail: '' },
        { path: 'notes.txt', size: 4, readable: true, detail: '' },
        { path: 'references/REFERENCE.md', size: 12, readable: true, detail: '' },
        { path: 'references/escape.md', size: null, readable: false, detail: '符号链接不读取' },
        { path: 'scripts/extract.py', size: 12, readable: true, detail: '' },
      ] },
      [`${root}/crud-page`]: { truncated: true, files: [{ path: 'scripts/a.py', size: 1, readable: true, detail: '' }] },
    };
    const previews: Record<string, { path: string; size: number; digest: string | null; text: string | null }> = {
      'scripts/extract.py': { path: 'scripts/extract.py', size: 12, digest: 'a'.repeat(64), text: "print('hi')\n" },
      'assets/logo.png': { path: 'assets/logo.png', size: 7, digest: 'b'.repeat(64), text: null },
      'notes.txt': { path: 'notes.txt', size: 4, digest: 'c'.repeat(64), text: 'note' },
      'references/REFERENCE.md': { path: 'references/REFERENCE.md', size: 12, digest: 'd'.repeat(64), text: '# Reference\n\nBack to [the core](../../_shared/core.md#用法).\n' },
      '../_shared/core.md': { path: '../_shared/core.md', size: 40, digest: 'e'.repeat(64), text: `# Core\n\n${'Intro line.\n\n'.repeat(40)}## 用法\n\n中文说明。\n\n${'Intro line.\n\n'.repeat(40)}## Usage\n\nUsage details.\n` },
    };
    /** Joins like the backend: from the referencing file's folder, then a unique bare name. */
    const resolveTarget = (from: string, target: string) => {
      const file = target.split('#')[0];
      const parts = from.split('/').slice(0, -1);
      for (const part of file.split('/')) { if (part === '..') { if (parts.length && parts.at(-1) !== '..') parts.pop(); else parts.push('..'); } else if (part && part !== '.') parts.push(part); }
      const joined = parts.join('/');
      if (previews[joined]) return joined;
      const named = Object.keys(previews).filter(path => !file.includes('/') && path.split('/').pop() === file);
      return named.length === 1 ? named[0] : null;
    };
    const calls: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __skillCalls: calls,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        calls.push(command);
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], remoteResources: { mcp: null, skillRoot: '.codex/skills', agentRoot: '.codex/agents', agentExtension: 'toml' }, nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null };
        if (command === 'scan_native_skills') return entries.map(entry => ({ ...entry }));
        if (command === 'read_native_skill') return { name: String(args.directory).split('/').pop(), path: args.directory, content: documents[args.directory] ?? '' };
        if (command === 'analyze_skill_document') return manifests[args.content] ?? { name: null, description: '', license: null, compatibility: null, metadata: [], allowedTools: [], extra: [], bodyLine: 0, issues: [{ code: 'frontmatter_missing', limit: null, actual: null }] };
        if (command === 'save_native_skill') {
          documents[args.directory] = args.content;
          const entry = entries.find(item => item.path === args.directory);
          if (entry) entry.issues = issuesOf(args.content);
          return null;
        }
        if (command === 'list_native_skill_files') return attachments[args.directory] ?? { files: [], truncated: false };
        if (command === 'read_native_skill_file') return previews[args.path];
        if (command === 'read_native_skill_reference') { if (!previews[args.path]) throw new Error('引用文件不存在，或不在可读取范围内'); return previews[args.path]; }
        if (command === 'resolve_native_skill_references') return args.targets.map((target: string) => resolveTarget(args.from, target));
        if (command === 'list_skill_packages') return [{ id: 'flagged', name: 'flagged', description: 'Has notes', compatibility: null, source: 'local', digest: 'd', fileCount: 1, updatedAt: 0, inLibrary: true, issues: ['name_mismatch'] }, { id: 'clean', name: 'clean', description: 'All good', compatibility: null, source: 'local', digest: 'e', fileCount: 1, updatedAt: 0, inLibrary: true, issues: [] }];
        if (command === 'get_skill_enabled') return false;
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:dialog|open') return 'C:/fixtures/skills.zip';
        if (command === 'list_skill_zip_entries') return ['pdf-processing'];
        if (command === 'preview_skill_local_zip') return { name: 'pdf-processing', source: args.source, digest: 'new', existingDigest: 'old', fileCount: 3, changes: [], compatibility: null, manifest: manifests[docs['pdf-processing']] };
        if (command.startsWith('list_')) return [];
        return null;
      } },
    });
  }, {
    docs: options.remote ? {} : { 'pdf-processing': PDF, minimal: MINIMAL, 'crud-page': CRUD, broken: BROKEN },
    manifests: {
      [PDF]: manifest({ name: 'pdf-processing', description: 'Extract PDFs.', license: 'Apache-2.0', metadata: [{ key: 'author', value: 'example-org' }, { key: 'version', value: '1.0' }], allowedTools: ['Bash(git:*)', 'Read'], bodyLine: 9 }),
      [MINIMAL]: manifest({ name: 'minimal', description: 'Only the basics.', bodyLine: 4 }),
      [CRUD]: manifest({ name: 'other-name', bodyLine: 4, issues: [issue('name_mismatch'), issue('description_missing')] }),
      [CRUD_FIXED]: manifest({ name: 'crud-page', description: 'Builds CRUD pages.', bodyLine: 4 }),
      [BROKEN]: manifest({ issues: [issue('yaml_invalid')] }),
    },
  });
}

/** A remote host whose Codex skills store holds one document; records every call. */
async function mockRemoteSkills(page: Page, versions = false) {
  await page.addInitScript(({ crud, fixed, crudManifest, fixedManifest, versions }) => {
    const host = { id: 'host-1', name: '测试远程主机', host: '203.0.113.9', port: 22, user: 'root', authMethod: 'key', identityFile: '', sshConfig: null, defaultPath: '/srv/project', enabled: true, createdAt: 1, updatedAt: 1 };
    localStorage.setItem('cliora:remote-target', host.id);
    const path = '/root/.codex/skills/crud-page/SKILL.md';
    let store: Record<string, any> = { entries: [{ name: 'crud-page', path, digest: null, state: 'external', detail: '', packageId: null, source: 'writable', pluginName: null, pluginEnabled: null, issues: ['name_mismatch', 'description_missing'] }], documents: { [path]: crud } };
    const calls: Array<{ command: string; args: Record<string, any> }> = [];
    const state = { body: crud, version: 'old', attempts: [] as string[], saves: 0 };
    const snapshots = new Map<string, Record<string, string>>();
    Object.assign(window, {
      isTauri: true,
      __remoteCalls: calls, __remoteSkillState: state,
      __TAURI_INTERNALS__: { transformCallback: () => 1, invoke: async (command: string, args: Record<string, any> = {}) => {
        calls.push({ command, args });
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: true }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], remoteResources: { mcp: null, skillRoot: '.codex/skills', agentRoot: '.codex/agents', agentExtension: 'toml' }, nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_remote_targets') return [host];
        if (command === 'probe_remote_cli') return { targetId: host.id, toolId: 'codex', executable: '/usr/bin/codex', installed: true, version: null, detail: null };
        if (command === 'get_remote_tool_store') return { profiles: [], common: null, currentFiles: {} };
        if (command === 'get_remote_write_snapshot') return snapshots.get(args.requestId) ?? {};
        if (command === 'get_remote_resource_store') { if (versions) { store.documents[path] = state.body; snapshots.set(args.operation.requestId, { [path]: state.version }); } return JSON.parse(JSON.stringify(store)); }
        if (command === 'save_remote_resource_store') { if (versions) { const expected = args.operation.expectedFiles[path]; state.attempts.push(expected); if (expected !== state.version) throw { message: 'fixture skill version conflict' }; } store = JSON.parse(JSON.stringify(args.value ?? args.store ?? args.data ?? {})); state.body = store.documents[path]; state.version = `saved-${++state.saves}`; snapshots.set(args.operation.requestId, { [path]: state.version }); return null; }
        if (command === 'analyze_skill_document') return args.content === fixed ? fixedManifest : crudManifest;
        if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('list_')) return [];
        return null;
      } },
    });
  }, { versions, crud: CRUD, fixed: CRUD_FIXED, crudManifest: manifest({ name: 'other-name', bodyLine: 4, issues: [issue('name_mismatch'), issue('description_missing')] }), fixedManifest: manifest({ name: 'crud-page', description: 'Builds CRUD pages.', bodyLine: 4 }) });
}

async function openSkills(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  return page.getByRole('navigation', { name: 'Skill 列表' });
}

test('Skill reading view shows specification fields once, with allowed-tools marked experimental', async ({ page }) => {
  await mockSkills(page);
  const list = await openSkills(page);
  await list.getByRole('button', { name: /pdf-processing/ }).click();
  const preview = page.getByRole('region', { name: 'SKILL.md 预览' });
  await expect(preview.getByText('Extract PDFs.')).toBeVisible();
  const card = preview.getByLabel('SKILL.md 字段');
  await expect(card).toContainText('license');
  await expect(card).toContainText('Apache-2.0');
  await expect(card).toContainText('metadata.author');
  await expect(card).toContainText('example-org');
  await expect(card).toContainText('metadata.version');
  await expect(card).toContainText('1.0');
  const tools = preview.getByRole('list', { name: 'allowed-tools' });
  await expect(tools.getByRole('listitem')).toHaveText(['Bash(git:*)', 'Read']);
  await expect(card.getByText('实验字段')).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'PDF guide' })).toBeVisible();
  // Fields render once, in the manifest card, not again as body properties.
  await expect(preview.getByText('Apache-2.0')).toHaveCount(1);
  await expect(preview.getByLabel('SKILL.md 字段')).toHaveCount(1);
  await expect(preview.getByLabel('规范提示')).toHaveCount(0);

  await list.getByRole('button', { name: /minimal/ }).click();
  const minimal = page.getByRole('region', { name: 'SKILL.md 预览' });
  await expect(minimal.getByRole('heading', { name: 'Minimal body' })).toBeVisible();
  await expect(minimal.getByText('license')).toHaveCount(0);
  await expect(minimal.getByText(/^metadata/)).toHaveCount(0);
  await expect(minimal.getByRole('list', { name: 'allowed-tools' })).toHaveCount(0);
  await expect(minimal.getByLabel('附带文件', { exact: true })).toHaveCount(0);
});

test('specification notes mark rows, explain each issue, and clear after a fixing save', async ({ page }) => {
  await mockSkills(page);
  const list = await openSkills(page);
  const crud = list.getByRole('button', { name: /crud-page/ });
  await expect(crud).toContainText('规范提示');
  await expect(crud).toContainText('本机目录');
  await expect(list.getByRole('button', { name: /pdf-processing/ })).not.toContainText('规范提示');
  await expect(list.getByRole('button', { name: /legacy/ })).not.toContainText('规范提示');
  await crud.click();
  const notes = page.getByRole('region', { name: 'SKILL.md 预览' }).getByLabel('规范提示');
  await expect(notes.getByRole('listitem')).toHaveCount(2);
  await expect(notes).toContainText('与目录名「crud-page」不一致');
  await expect(notes).toContainText('缺少 description');

  await page.getByRole('article').getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SKILL.md', exact: true });
  await editor.fill(CRUD_FIXED);
  await page.getByRole('article').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('region', { name: 'SKILL.md 预览' }).getByText('Builds CRUD pages.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'SKILL.md 预览' }).getByLabel('规范提示')).toHaveCount(0);
  await expect(list.getByRole('button', { name: /crud-page/ })).not.toContainText('规范提示');
});

test('an unreadable YAML header is reported and the whole file stays readable', async ({ page }) => {
  await mockSkills(page);
  const list = await openSkills(page);
  await list.getByRole('button', { name: /broken/ }).click();
  const preview = page.getByRole('region', { name: 'SKILL.md 预览' });
  await expect(preview.getByLabel('规范提示')).toContainText('YAML 头信息无法解析');
  await expect(preview).toContainText('name: [broken');
  await expect(preview.getByRole('heading', { name: 'Broken body' })).toBeVisible();
});

test('bundled files are listed by folder and open read-only in the reader', async ({ page }) => {
  await mockSkills(page);
  const list = await openSkills(page);
  await list.getByRole('button', { name: /pdf-processing/ }).click();
  const skill = page.getByRole('region', { name: 'SKILL.md 预览' });
  const files = skill.getByLabel('附带文件', { exact: true });
  await expect(files.getByRole('group', { name: 'scripts/' }).getByRole('button', { name: 'scripts/extract.py' })).toContainText('extract.py');
  await expect(files.getByRole('group', { name: 'references/' }).getByRole('button', { name: 'references/REFERENCE.md' })).toBeVisible();
  await expect(files.getByRole('group', { name: 'assets/' }).getByRole('button', { name: 'assets/logo.png' })).toBeVisible();
  await expect(files.getByRole('group', { name: 'Skill 目录' }).getByRole('button', { name: 'notes.txt' })).toBeVisible();
  await expect(files.getByRole('group', { name: 'references/' })).toContainText('符号链接不读取');
  await expect(files.getByRole('button', { name: /escape\.md/ })).toHaveCount(0);
  await expect(files).not.toContainText('清单不完整');
  // A shared file outside the skill that SKILL.md links to is listed too.
  await expect(skill.getByLabel('本文引用的共享文件').getByRole('button', { name: '../_shared/core.md' })).toBeVisible();

  await files.getByRole('button', { name: 'scripts/extract.py' }).click();
  const trail = page.getByRole('navigation', { name: 'Skill 文件导航' });
  await expect(trail).toContainText('scripts/extract.py');
  const script = page.getByRole('textbox', { name: '引用文件：scripts/extract.py' });
  await expect(script).toContainText("print('hi')");
  await expect(script).toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByRole('article').getByRole('button', { name: '保存' })).toHaveCount(0);
  await trail.getByRole('button', { name: '返回' }).click();
  await expect(trail).toHaveCount(0);
  await files.getByRole('button', { name: 'assets/logo.png' }).click();
  await expect(page.getByRole('region', { name: '引用文件：assets/logo.png' })).toContainText('7 B · 二进制文件，不显示内容');
  await trail.getByRole('button', { name: 'SKILL.md' }).click();
  await expect(skill).toBeVisible();

  await list.getByRole('button', { name: /crud-page/ }).click();
  await expect(page.getByRole('region', { name: 'SKILL.md 预览' }).getByLabel('附带文件', { exact: true })).toContainText('清单不完整');
});

test('links and path-like code open referenced files, including ../ shared files, with a breadcrumb back', async ({ page }) => {
  await mockSkills(page);
  const list = await openSkills(page);
  await list.getByRole('button', { name: /pdf-processing/ }).click();
  const skill = page.getByRole('region', { name: 'SKILL.md 预览' });
  const trail = page.getByRole('navigation', { name: 'Skill 文件导航' });

  // A link that names no readable file stays plain and says so.
  const missing = skill.getByRole('link', { name: 'a missing note' });
  await expect(missing).toHaveAttribute('title', '找不到这个文件：references/nope.md');
  await expect(missing).toHaveAttribute('aria-disabled', 'true');

  // Inline code that is a path opens the file.
  await skill.getByRole('link', { name: 'scripts/extract.py' }).click();
  await expect(page.getByRole('textbox', { name: '引用文件：scripts/extract.py' })).toContainText("print('hi')");
  await trail.getByRole('button', { name: '返回' }).click();

  await skill.getByRole('link', { name: 'the reference' }).click();
  const reference = page.getByRole('region', { name: '引用文件：references/REFERENCE.md' });
  await expect(reference.getByRole('heading', { name: 'Reference' })).toBeVisible();
  // `../../_shared/core.md` resolves from the reference's own folder.
  await reference.getByRole('link', { name: 'the core' }).click();
  const core = page.getByRole('region', { name: '引用文件：../_shared/core.md' });
  // The percent-encoded CJK anchor still resolves and scrolls to its heading.
  await expect(core.getByRole('heading', { name: '用法' })).toBeInViewport();
  await expect(trail.getByRole('listitem')).toHaveCount(3);
  await expect(trail).toContainText('SKILL.md');
  await expect(trail).toContainText('REFERENCE.md');
  await expect(trail).toContainText('../_shared/core.md');

  // Back steps one file; the breadcrumb returns to SKILL.md.
  await trail.getByRole('button', { name: '返回' }).click();
  await expect(reference).toBeVisible();
  await trail.getByRole('button', { name: 'SKILL.md' }).click();
  await expect(trail).toHaveCount(0);

  // A link with an anchor scrolls to that heading.
  await skill.getByRole('link', { name: 'shared usage' }).click();
  const usage = core.getByRole('heading', { name: 'Usage' });
  await expect(usage).toBeInViewport();
  // 源码 shows the referenced file read-only.
  await page.getByRole('article').getByRole('button', { name: '源码', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '引用文件：../_shared/core.md' })).toHaveAttribute('aria-readonly', 'true');
});

test('the import update preview shows the incoming manifest', async ({ page }) => {
  await mockSkills(page);
  await openSkills(page);
  await page.getByRole('button', { name: '添加 Skill', exact: true }).first().click();
  await page.getByRole('button', { name: '导入 ZIP 文件', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Skill 同名更新预览' });
  await expect(panel.getByLabel('SKILL.md 字段')).toContainText('Apache-2.0');
  await expect(panel.getByRole('list', { name: 'allowed-tools' }).getByRole('listitem')).toHaveText(['Bash(git:*)', 'Read']);
});

test('remote skills read the manifest but never list bundled files, and a save refreshes the stored notes', async ({ page }) => {
  await mockRemoteSkills(page);
  const list = await openSkills(page);
  const crud = list.getByRole('button', { name: /crud-page/ });
  await expect(crud).toContainText('规范提示');
  await crud.click();
  const preview = page.getByRole('region', { name: 'SKILL.md 预览' });
  await expect(preview.getByLabel('规范提示').getByRole('listitem')).toHaveCount(2);
  await expect(preview.getByLabel('附带文件', { exact: true })).toHaveCount(0);
  await page.getByRole('article').getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: 'SKILL.md', exact: true }).fill(CRUD_FIXED);
  await page.getByRole('article').getByRole('button', { name: '保存', exact: true }).click();
  await expect(list.getByRole('button', { name: /crud-page/ })).not.toContainText('规范提示');
  const calls = await page.evaluate(() => (window as unknown as { __remoteCalls: Array<{ command: string }> }).__remoteCalls.map(call => call.command));
  expect(calls).not.toContain('list_native_skill_files');
  expect(calls).not.toContain('read_native_skill_file');
  expect(calls).not.toContain('resolve_native_skill_references');
  expect(calls).not.toContain('read_native_skill_reference');
});

test('library cards mark packages with specification notes', async ({ page }) => {
  await mockSkills(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(library.getByText('Has notes')).toBeVisible();
  await expect(library.getByText('All good')).toBeVisible();
  await expect(library.getByText('规范提示')).toHaveCount(1);
});


test('a saved remote skill preserves a stale draft conflict and accepts actual bytes only after close and reload', async ({ page }) => {
  await mockRemoteSkills(page, true);
  const list = await openSkills(page);
  await list.getByRole('button', { name: /crud-page/ }).click();
  const article = page.getByRole('article');
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'SKILL.md', exact: true });
  await editor.fill(CRUD_FIXED);
  await article.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteSkillState.saves)).toBe(1);
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.fill(`${CRUD_FIXED}user draft\n`);
  await page.evaluate(() => { const state = (window as any).__remoteSkillState; state.body += 'external body\n'; state.version = 'external'; });
  await article.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('fixture skill version conflict')).toBeVisible();
  await expect(editor).toContainText('user draft');
  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await list.getByRole('button', { name: /crud-page/ }).click();
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor).toContainText('external body');
  await editor.fill(`${CRUD_FIXED}external body\naccepted edit\n`);
  await article.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteSkillState.saves)).toBe(2);
  expect(await page.evaluate(() => (window as any).__remoteSkillState.attempts)).toEqual(['old', 'saved-1', 'external']);
});
