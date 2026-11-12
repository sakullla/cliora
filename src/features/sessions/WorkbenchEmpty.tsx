import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { HostSwitcher } from '../../components/HostSwitcher';
import { ToolIcon } from '../../components/ToolIcon';
import { displayPath, shortPath } from '../../lib/paths';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import type { RemoteTarget } from '../../types/remote';
import styles from './SessionWorkbench.module.css';

const QUICK_TOOL_LIMIT = 8;

export function WorkbenchEmpty({ tools, projects, remoteTargets = [], remoteEnabled = false, activeTargetId = 'local', onTargetChange, onManageHosts, onNewSession, onOpenHome }: {
  tools: AdapterDescriptor[];
  projects: Project[];
  remoteTargets?: RemoteTarget[];
  remoteEnabled?: boolean;
  activeTargetId?: string;
  onTargetChange?: (targetId: string) => void;
  onManageHosts?: () => void;
  onNewSession: (prefill?: { toolId?: string; projectId?: string }) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const quickTools = tools.slice(0, QUICK_TOOL_LIMIT);
  const recent = [...projects].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 4);
  return <div className={styles.empty}>
    <div className={styles.emptyShell}>
      <header className={styles.emptyHero}>
        <span className={styles.emptyGlyph} aria-hidden="true">
          <span className={styles.emptyGlyphBar}><i /><i /><i /></span>
          <span className={styles.emptyGlyphLine}><b>›</b><span className={styles.emptyGlyphCursor} /></span>
        </span>
        <h2>{t('sessions.emptyTitle')}</h2>
        <p>{t('sessions.emptyDetail')}</p>
        {/* One launcher bar, like a command field: the whole bar opens the new-session dialog. */}
        {tools.length > 0 && <button type="button" className={styles.launcherBar} aria-label={t('sessions.newSession')} title={t('sessions.newSession') + ' (Alt+N)'} onClick={() => onNewSession()}>
          <span className={styles.launcherGlyph} aria-hidden="true"><Icon name="plus" size={18} /></span>
          <span className={styles.launcherCopy}><strong>{t('sessions.newSession')}</strong><small>{t('sessions.launcherHint')}</small></span>
          <span className={styles.launcherKeys} aria-hidden="true"><kbd>Alt</kbd><kbd>N</kbd></span>
        </button>}
        {/* With tools, the launcher bar is the next step and the sidebar already reaches Home. */}
        {tools.length === 0 && <div className={styles.emptyActions}>
          <Button variant="primary" className={styles.emptyAction} onClick={onOpenHome}><span>{t('sessions.openHome')}</span><Icon name="arrowRight" size={14} /></Button>
        </div>}
      </header>

      {tools.length > 0 && <section className={styles.launchSection} aria-label={t('sessions.quickTools')}>
        <div className={styles.launchSectionHead}><span>{t('sessions.quickTools')}</span><small>{t('sessions.quickToolsHint')}</small></div>
        <div className={styles.toolGrid}>{quickTools.map((tool) => <button key={tool.id} type="button" className={styles.toolChip} title={t('sessions.quickToolTitle', { name: tool.name })} onClick={() => onNewSession({ toolId: tool.id })}>
          <span className={styles.launchToolIcon}><ToolIcon toolId={tool.id} size={22} /></span>
          <span className={styles.toolChipName}><strong>{tool.name}</strong>{!tool.yoloAvailable && <small>{t('sessions.toolNoYolo')}</small>}</span>
          <span className={styles.toolChipAction} aria-hidden="true"><Icon name="arrowRight" size={14} /></span>
        </button>)}{tools.length > QUICK_TOOL_LIMIT && <button type="button" className={styles.toolChip} data-more onClick={() => onNewSession()}>
          <span className={styles.launchToolIcon}><Icon name="more" size={18} /></span>
          <span className={styles.toolChipName}><strong>{t('sessions.moreTools', { count: tools.length - QUICK_TOOL_LIMIT })}</strong></span>
          <span className={styles.toolChipAction} aria-hidden="true"><Icon name="arrowRight" size={14} /></span>
        </button>}</div>
      </section>}

      {tools.length > 0 && recent.length > 0 && <section className={styles.launchSection} aria-label={t('sessions.recentProjects')}>
        <div className={styles.launchSectionHead}><span>{t('sessions.recentProjects')}</span><small>{t('sessions.recentProjectsHint')}</small></div>
        <div className={styles.recentsGrid}>{recent.map((project) => {
          const toolId = project.preferredTool && tools.some((item) => item.id === project.preferredTool) ? project.preferredTool : tools[0]?.id;
          const toolName = tools.find((item) => item.id === toolId)?.name;
          return <button key={project.id} type="button" className={styles.recentCard} onClick={() => onNewSession({ projectId: project.id, toolId: project.preferredTool ?? undefined })}>
            <span className={styles.recentIcon}><Icon name="folder" size={16} /></span>
            <span className={styles.recentCopy}><strong>{project.name}</strong><small>{project.path ? shortPath(displayPath(project.path)) : t('sessions.placeUnknown')}</small></span>
            {toolId && <span className={styles.recentTool} title={toolName}><ToolIcon toolId={toolId} size={16} /></span>}
            <span className={styles.recentAction} aria-hidden="true"><Icon name="arrowRight" size={14} /></span>
          </button>;
        })}</div>
      </section>}

      <footer className={styles.emptyFoot}>
        {/* Alt+N already sits on the launcher bar; the footer only teaches switching. */}
        <span className={styles.shortcutsHint} aria-label={t('sessions.shortcutsHint')}>{tools.length === 0 && <><kbd>Alt</kbd><kbd>N</kbd><span>{t('sessions.shortcutNew')}</span><span className={styles.shortcutSep} aria-hidden="true">·</span></>}<kbd>Alt</kbd><kbd>↑</kbd><kbd>↓</kbd><span>{t('sessions.shortcutSwitch')}</span></span>
        {remoteEnabled ? <HostSwitcher variant="chip" targets={remoteTargets} value={activeTargetId} onChange={(targetId) => onTargetChange?.(targetId)} onManage={onManageHosts} /> : <span className={styles.localOnly}><Icon name="lock" size={12} />{t('sessions.localSessions')}</span>}
      </footer>
    </div>
  </div>;
}
