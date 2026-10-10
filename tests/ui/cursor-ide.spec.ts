import { expect, test, type Page } from '@playwright/test';
import { resourceExperienceFixture, cursorIdeFixture } from '../../scripts/capture-workflow-fixtures.mjs';
async function fixture(page: Page) {
  await page.addInitScript(resourceExperienceFixture, { count: 2 });
  await page.addInitScript(cursorIdeFixture);
  await page.goto('/');
}
test('Cursor IDE launches bare and supported failure keeps retry', async ({ page }) => {
  await fixture(page);
  const tools=page.getByLabel('管理中的工具');
  await expect(tools.getByText('Cursor IDE',{exact:true})).toBeVisible();
  await expect(tools.getByRole('button',{name:'启动目录'})).toHaveCount(0);
  await tools.getByRole('button',{name:'启动',exact:true}).click();
  await expect(tools.getByRole('status')).toContainText('已请求启动桌面应用');
  expect(await page.evaluate(()=>(window as any).__cursorIde.calls.find((c:any)=>c.command==='launch_cli').args.request)).toEqual({toolId:'cursor_ide',projectId:null,sessionId:null,mode:'normal',directory:null});
  await page.evaluate(()=>{(window as any).__cursorIde.failLaunch=true;});
  await tools.getByRole('button',{name:'启动',exact:true}).click();
  await expect(tools.getByRole('alert')).toContainText('Cursor IDE 启动失败');
  await expect(tools.getByRole('button',{name:'启动',exact:true})).toBeEnabled();
});
test('Cursor native skill sources with identical names stay separate and read only', async ({ page }) => {
  await fixture(page);
  await page.getByRole('navigation',{name:'页面'}).getByRole('button',{name:'工具与连接',exact:true}).click();
  for(const name of ['账号','Agent','插件'])await expect(page.getByRole('tab',{name,exact:true})).toHaveCount(0);
  await page.getByRole('tab',{name:'Skill',exact:true}).click();
  const rows=page.getByRole('region',{name:'Skill',exact:true}).locator('article');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({hasText:'只读来源'})).toHaveCount(2);
  await rows.filter({hasText:'agents Skill source'}).getByRole('button',{name:'same-skill',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'SKILL.md',exact:true})).toHaveAttribute('contenteditable','false');
  await expect(page.getByRole('dialog').getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await rows.filter({hasText:'primary Skill source'}).getByRole('button',{name:'same-skill',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'SKILL.md',exact:true});await expect(editor).toHaveAttribute('contenteditable','true');await editor.fill('# updated');
  await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__cursorIde.contents['C:/fixtures/agents/skills/same-skill'])).toContain('agents Skill');
});
test('Cursor configuration editor exposes IDE fields', async ({ page }) => {
  await fixture(page);
  await page.getByLabel('管理中的工具').getByRole('button',{name:'编辑配置',exact:true}).click();
  await page.getByRole('button',{name:'新建配置',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'编辑器字号'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'编辑器字号'})).toHaveValue('15');
  await expect(page.getByRole('button',{name:'连接与模型',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'常用设置',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'原生文本',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'合并与来源',exact:true})).toBeVisible();
  await expect(page.getByRole('list',{name:'连接顺序',exact:true})).toHaveCount(0);
});

test('existing connection tool keeps its connection view', async ({ page }) => {
  const { installConfigurationWorkspace } = await import('./configuration-workspace-fixture');
  await installConfigurationWorkspace(page, 'codex', true);
  await page.goto('/');
  await page.getByRole('navigation',{name:'页面'}).getByRole('button',{name:'工具与连接',exact:true}).click();
  await page.getByRole('button',{name:'新建配置',exact:true}).click();
  await expect(page.getByRole('button',{name:'连接与模型',exact:true})).toBeVisible();
  await expect(page.getByRole('list',{name:'连接顺序',exact:true})).toBeVisible();
});
