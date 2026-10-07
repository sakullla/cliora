export default {
  managed: {
    title: '管理的 CLI',
    description: '首页、工具页与使用记录只显示勾选的工具。关闭管理不会删除已有配置。',
    preservedUnknown: '未安装适配器，保留 {{count}} 份配置，只读',
  },
  icons: {
    updated: '工具图标已更新。',
    restored: '已恢复默认图标。',
  },
  appearance: {
    title: '外观',
    description: '跟随系统，或固定浅色、深色。',
  },
  theme: {
    label: '主题',
    hint: '侧边栏底部也可以随时切换。',
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
  },
  language: {
    title: '语言',
    description: '选择界面显示语言，立即生效。',
    label: '界面语言',
    hint: '重启后保持所选语言。',
  },
  shortcuts: {
    label: '键盘快捷键',
    hint: '全局与编辑时的按键说明，也可以随时按 ? 打开。',
    action: '查看',
  },
  migration: {
    label: '换设备与备份',
    hint: '导出加密配置包，或通过 WebDAV 同步',
    action: '迁移与同步 →',
  },
};
