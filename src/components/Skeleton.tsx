import { useTranslation } from 'react-i18next';

export function SkeletonBlock({ tall = false, short = false }: { tall?: boolean; short?: boolean }) {
  return <div className={`skeleton-block${tall ? ' tall' : ''}${short ? ' short' : ''}`} />;
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return <div className="skeleton-page" aria-busy="true">{Array.from({ length: count }, (_, index) => <SkeletonBlock key={index} />)}</div>;
}

export function PageSkeleton({ note }: { note?: string }) {
  const { t } = useTranslation();
  return <div className="skeleton-page" aria-busy="true">
    <p className="muted-copy">{note ?? t('common.loading.note')}</p>
    <div className="skeleton-row"><div className="skeleton-page"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div><SkeletonBlock tall /></div>
  </div>;
}
