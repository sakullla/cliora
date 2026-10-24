import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { displayPath, shortPath } from '../../lib/paths';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import styles from './SessionWorkbench.module.css';

export function WorkbenchEmpty({ tools, projects, onNewSession, onOpenHome }: {
  tools: AdapterDescriptor[];
  projects: Project[];
  onNewSession: (prefill?: { toolId?: string; projectId?: string }) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const quickTools = tools.slice(0, 6);
  return <div className={styles.empty}>
    <header className={styles.emptyHero}>
      <span className={styles.emptyGlyph} aria-hidden="true"><Icon name="terminal" size={26} /><span className={styles.emptyGlyphCursor} /></span>
      <div className={styles.emptyIntro}>
        <span className={styles.emptyEyebrow}>{t('sessions.workspaceEyebrow')}</span>
        <h2>{t('sessions.emptyTitle')}</h2>
        <p>{t('sessions.emptyDetail')}</p>
        <div className={styles.emptyPromise}><span><Icon name="check" size={12} />{t('sessions.emptyPromiseSessions')}</span><span><Icon name="check" size={12} />{t('sessions.emptyPromiseInput')}</span></div>
      </div>
      <div className={styles.emptyActions}>
        {tools.length > 0 && <button type="button" className="button primary" onClick={() => onNewSession()}><Icon name="plus" size={15} /><span>{t('sessions.newSession')}</span></button>}
        <button type="button" className={tools.length > 0 ? 'button' : 'button primary'} onClick={onOpenHome}><span>{t('sessions.openHome')}</span><Icon name="arrowRight" size={14} /></button>
      </div>
    </header>
    {tools.length > 0 && <div className={styles.launchpad}>
      <section className={styles.launchSection} aria-label={t('sessions.quickTools')}>
        <div className={styles.launchSectionHead}><span><Icon name="terminal" size={14} />{t('sessions.quickTools')}</span><small>{t('sessions.quickToolsHint')}</small></div>
        <div className={styles.toolGrid}>{quickTools.map((tool) => <button key={tool.id} type="button" className={styles.toolChip} title={t('sessions.quickToolTitle', { name: tool.name })} onClick={() => onNewSession({ toolId: tool.id })}><span className={styles.launchToolIcon}><ToolIcon toolId={tool.id} size={20} /></span><span className={styles.toolChipName}>{tool.name}</span><Icon name="arrowUpRight" size={13} /></button>)}{tools.length > 6 && <button type="button" className={styles.toolChip} data-more onClick={() => onNewSession()}><span className={styles.toolChipName}>{t('sessions.moreTools', { count: tools.length - 6 })}</span><Icon name="arrowRight" size={13} /></button>}</div>
      </section>
      {projects.length > 0 && <section className={styles.launchSection} aria-label={t('sessions.recentProjects')}>
        <div className={styles.launchSectionHead}><span><Icon name="folder" size={14} />{t('sessions.recentProjects')}</span><small>{t('sessions.recentProjectsHint')}</small></div>
        <div className={styles.recentsGrid}>{projects.slice(0, 4).map((project) => {
          const toolId = project.preferredTool && tools.some((item) => item.id === project.preferredTool) ? project.preferredTool : tools[0]?.id;
          return <button key={project.id} type="button" className={styles.recentCard} onClick={() => onNewSession({ projectId: project.id, toolId: project.preferredTool ?? undefined })}><span className={styles.recentIcon}>{toolId ? <ToolIcon toolId={toolId} size={20} /> : <Icon name="folder" size={18} />}</span><span className={styles.recentCopy}><strong>{project.name}</strong><small>{project.path ? shortPath(displayPath(project.path)) : t('sessions.placeUnknown')}</small></span><span className={styles.recentAction} aria-hidden="true"><Icon name="arrowUpRight" size={13} /></span></button>;
        })}</div>
      </section>}
      <div className={styles.launchpadFoot}><span className={styles.shortcutsHint} aria-label={t('sessions.shortcutsHint')}><kbd>Alt</kbd><kbd>↑</kbd><kbd>↓</kbd><span>{t('sessions.shortcutSwitch')}</span><span className={styles.shortcutSep} aria-hidden="true">·</span><kbd>Alt</kbd><kbd>N</kbd><span>{t('sessions.shortcutNew')}</span></span><span className={styles.localOnly}><Icon name="lock" size={11} />{t('sessions.localSessions')}</span></div>
    </div>}
  </div>;
}
