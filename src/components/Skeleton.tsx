export function SkeletonBlock({ tall = false, short = false }: { tall?: boolean; short?: boolean }) {
  return <div className={`skeleton-block${tall ? ' tall' : ''}${short ? ' short' : ''}`} />;
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return <div className="skeleton-page" aria-busy="true">{Array.from({ length: count }, (_, index) => <SkeletonBlock key={index} />)}</div>;
}

export function PageSkeleton({ note = '正在读取本机设置' }: { note?: string }) {
  return <div className="skeleton-page" aria-busy="true">
    <p className="muted-copy">{note}</p>
    <div className="skeleton-row"><div className="skeleton-page"><SkeletonBlock /><SkeletonBlock /><SkeletonBlock /></div><SkeletonBlock tall /></div>
  </div>;
}
