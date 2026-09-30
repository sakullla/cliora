export type IconName = 'home' | 'connections' | 'library' | 'records' | 'settings' | 'leaf' | 'migration' | 'tool';
const paths: Record<IconName, string> = {
  home: 'M3 10 12 3l9 7M5 9v11h14V9M9 20v-7h6v7',
  connections: 'M5 3h14v18H5zM9 7h6M9 12h6M9 17h6',
  library: 'M4 4h7v16H4zM14 4h6v16h-6M7 8h1M17 8h1',
  records: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6M12 7v5l3 2',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  leaf: 'M5 19C3 10 8 4 20 4c0 12-6 17-15 15ZM6 18 16 8M11 13v-4M11 13h4',
  migration: 'M4 7h15l-4-4M20 17H5l4 4M20 7v5M4 17v-5',
  tool: 'M8 4h8v16H8zM4 8h4M16 8h4M4 16h4M16 16h4M11 8h2M11 12h2M11 16h2',
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
