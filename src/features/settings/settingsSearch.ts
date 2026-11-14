import type { TFunction } from 'i18next';
import type { IconName } from '../../components/Icon';

export type SettingsTab = 'general' | 'tools' | 'launch' | 'worktrees' | 'hosts' | 'migration';

export type SettingsSearchEntry = {
  id: string;
  category: SettingsTab;
  categoryLabel: string;
  categoryIcon: IconName;
  title: string;
  description: string;
  keywords: string;
  anchorId: string;
  toolId?: string;
  toolQuery?: string;
};

const categoryIcons: Record<SettingsTab, IconName> = {
  general: 'sliders',
  tools: 'plug',
  launch: 'terminal',
  worktrees: 'gitWorktree',
  hosts: 'server',
  migration: 'migration',
};

export function buildSettingsSearchEntries(
  t: TFunction,
  tools: ReadonlyArray<{ id: string; name: string }>,
  nativeAvailable: boolean,
): SettingsSearchEntry[] {
  const catLabel = (id: SettingsTab) => t(`settings.categories.${id}`);
  const item = (
    id: string,
    category: SettingsTab,
    title: string,
    description: string,
    anchorId: string,
    keywords: string,
    extra?: { toolId?: string; toolQuery?: string },
  ): SettingsSearchEntry => ({
    id,
    category,
    categoryLabel: catLabel(category),
    categoryIcon: categoryIcons[category],
    title,
    description,
    anchorId,
    keywords,
    ...extra,
  });

  const base: SettingsSearchEntry[] = [
    item(
      'general-theme',
      'general',
      t('settings.theme.label'),
      `${t('settings.appearance.description')} ${t('settings.theme.hint')}`,
      'settings-interface',
      'theme appearance dark light system 主题 外观 配色 深色 浅色 跟随系统 暗黑',
    ),
    item(
      'general-language',
      'general',
      t('settings.language.label'),
      t('settings.language.description'),
      'settings-interface',
      'language locale chinese english zh en 语言 界面语言 中文 英文 多语言',
    ),
    ...(nativeAvailable ? [
      item(
        'general-update',
        'general',
        t('settings.update.title'),
        t('settings.update.description'),
        'app-update',
        'update upgrade version release notes check 更新 升级 版本 检查更新 新版本',
      ),
      item(
        'general-tray',
        'general',
        t('settings.terminal.tray'),
        t('settings.terminal.trayAvailable'),
        'settings-tray',
        'tray close quit exit background 托盘 关闭 完全退出 退出 后台运行',
      ),
    ] : []),
    item(
      'general-shortcuts',
      'general',
      t('settings.shortcuts.label'),
      t('settings.shortcuts.hint'),
      'settings-other',
      'shortcut keyboard hotkey keybinding 快捷键 键盘 按键 热键',
    ),
    item(
      'general-onboarding',
      'general',
      t('settings.onboarding.label'),
      t('settings.onboarding.hint'),
      'settings-other',
      'onboarding guide welcome checklist 上手引导 新手引导 首次使用 三步清单',
    ),
    item(
      'tools-managed',
      'tools',
      t('settings.managed.title'),
      `${t('settings.managed.description')} ${t('settings.icons.description')}`,
      'settings-managed',
      'cli tools managed enable disable icon custom logo 工具 启用 隐藏 显示 自定义图标 图标',
    ),
    item(
      'launch-terminal',
      'launch',
      t('settings.terminal.title'),
      `${t('settings.terminal.launchHint')} ${t('settings.terminal.cliModeHint')}`,
      'settings-terminal',
      'terminal launch workbench powershell cmd iterm tabby custom script yolo mode 启动 终端 工作台 外部终端 自定义命令 默认模式 普通模式 YOLO',
    ),
    item(
      'launch-display',
      'launch',
      t('settings.terminal.display'),
      t('settings.terminal.displayHint'),
      'settings-terminal-display',
      'terminal display font size line height spacing density cursor blink sound bell chime colors dark light 终端显示 配色 字号 行距 光标 闪烁 提示音',
    ),
    item(
      'worktrees-launch',
      'worktrees',
      t('settings.worktrees.launchTitle'),
      t('settings.worktrees.launchDescription'),
      'settings-worktree-launch',
      'worktree start location direct branch git 工作树 启动位置 直接开始 新建工作树 分支',
    ),
    item(
      'worktrees-prepare',
      'worktrees',
      t('settings.worktrees.prepareTitle'),
      t('settings.worktrees.prepareDescription'),
      'settings-worktree-prepare',
      'worktree prepare command setup repository npm install 准备命令 仓库 初始化 依赖',
    ),
    item(
      'worktrees-ledger',
      'worktrees',
      t('settings.worktrees.ledgerTitle'),
      t('settings.worktrees.ledgerDescription'),
      'settings-worktree-ledger',
      'worktree ledger cleanup remove stale branch 工作树清理 移除失效记录 分支清理',
    ),
    item(
      'hosts-ssh',
      'hosts',
      t('settings.remoteSsh.hostsTitle'),
      `${t('settings.remoteSsh.description')} ${t('settings.remoteSsh.hostsDescription')}`,
      'settings-remote',
      'remote ssh host server key password port address 远程 主机 服务器 连接 密钥 密码 端口 测试连接',
    ),
    item(
      'migration-webdav',
      'migration',
      t('settings.webdav.title'),
      t('settings.webdav.description'),
      'webdav-sync-section',
      'webdav sync cloud auto conflict backup migration 同步 迁移 云端 自动同步 冲突 备份 坚果云 nextcloud',
    ),
    item(
      'migration-bundle',
      'migration',
      t('settings.migration.cardTitle'),
      t('settings.migration.cardDetail'),
      'portable-bundle-section',
      'bundle export import restore passphrase backup migration cliora 加密配置包 导出 恢复 备份 换电脑 口令 迁移',
    ),
  ];

  const dynamicTools = tools.map((tool) => item(
    `tool-${tool.id}`,
    'tools',
    tool.name,
    `${t('settings.managed.title')} · ${t('settings.icons.title')}`,
    'settings-managed',
    `${tool.id} ${tool.name} cli tool icon 工具 图标`,
    { toolId: tool.id, toolQuery: tool.name },
  ));

  return [...base, ...dynamicTools];
}

function scoreEntry(entry: SettingsSearchEntry, needle: string): number {
  const title = entry.title.toLowerCase();
  const category = entry.categoryLabel.toLowerCase();
  const desc = entry.description.toLowerCase();
  const keywords = entry.keywords.toLowerCase();

  if (title === needle) return 120;
  if (title.startsWith(needle)) return 95;
  if (title.includes(needle)) return 80;
  if (category === needle || category.includes(needle)) return 68;
  if (keywords.split(/\s+/).some((word) => word === needle)) return 64;
  if (keywords.includes(needle)) return 52;
  if (desc.includes(needle)) return 38;

  const haystack = `${title} ${category} ${desc} ${keywords}`;
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) {
    return 30 + tokens.filter((token) => title.includes(token)).length * 12;
  }
  return 0;
}

export function filterSettingsSearchEntries(entries: ReadonlyArray<SettingsSearchEntry>, query: string): SettingsSearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return entries
    .map((entry, order) => ({ entry, order, score: scoreEntry(entry, needle) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((item) => item.entry);
}
