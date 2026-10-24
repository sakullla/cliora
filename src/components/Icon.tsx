export type IconName = 'home' | 'connections' | 'library' | 'records' | 'settings' | 'leaf' | 'migration' | 'tool'
  | 'sun' | 'moon' | 'monitor' | 'alert' | 'info' | 'close' | 'check' | 'trash' | 'sparkle' | 'folder' | 'search' | 'clock' | 'archive' | 'copy' | 'arrowDown' | 'arrowLeft' | 'chevronLeft' | 'chevronRight' | 'plus' | 'refresh' | 'sidebarClose' | 'sidebarOpen' | 'play'
  | 'terminal' | 'globe' | 'eye' | 'eyeOff' | 'pencil' | 'clipboard' | 'minimize' | 'download' | 'arrowRight' | 'chevronDown' | 'package'
  | 'cloud' | 'upload' | 'lock' | 'shield' | 'user' | 'link' | 'pin'
  | 'arrowUp' | 'arrowUpRight' | 'sliders' | 'command' | 'more' | 'square';
const paths: Record<IconName, string> = {
  sidebarClose: 'M3 4h18v16H3zM9 4v16m7-11-3 3 3 3',
  sidebarOpen: 'M3 4h18v16H3zM9 4v16m4-11 3 3-3 3',
  home: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9M10 20v-6h4v6',
  connections: 'M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
  library: 'M4 4.5h6v15H4zM10 4.5h5v15h-5M15.5 5l4.5 1.2-3.6 13.6-4.4-1.2',
  records: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 7.5V12l3 2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  leaf: 'M5 19C3 10 8 4 20 4c0 12-6 17-15 15ZM6 18 16 8M11 13v-4M11 13h4',
  migration: 'M4 7h15l-4-4M20 17H5l4 4',
  tool: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM8 9.5l2.5 2.5L8 14.5M12.5 15h3.5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z',
  monitor: 'M3.5 5h17v11h-17zM8.5 20h7M12 16v4',
  alert: 'M12 9v4M12 16.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.5v.01',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  trash: 'M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A1.5 1.5 0 0 0 8 21h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7',
  sparkle: 'M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9Z',
  folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h3.6a1.5 1.5 0 0 1 1.2.6l1 1.4H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-4.8-4.8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 6.5V12l3.5 2',
  archive: 'M4 8V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M4 8h16M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4',
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5zM6 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V6',
  arrowDown: 'M12 4.5v15M5.5 13 12 19.5 18.5 13',
  arrowLeft: 'M19 12H5m6 6-6-6 6-6',
  chevronLeft: 'm15 5-7 7 7 7',
  chevronRight: 'm9 5 7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  play: 'M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9',
  terminal: 'M3.5 6A1.5 1.5 0 0 1 5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18zM7.5 9.5 10 12l-2.5 2.5M12.5 15H16',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9c2.4-2.5 3.6-5.5 3.6-9S14.4 5.5 12 3Z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M3.5 3.5l17 17M10.4 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.4M6.6 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  pencil: 'M4.5 19.5h3.8L19 8.8a2.2 2.2 0 0 0-3.1-3.1L5.2 16.4 4.5 19.5ZM14.5 7l2.5 2.5',
  clipboard: 'M9 3.5h6v3H9zM9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15M8.5 11.5h7M8.5 15.5h5',
  minimize: 'M5 14h5v5M19 10h-5V5M14 10l6-6M4 20l6-6',
  download: 'M12 4v11M7 10.5l5 5 5-5M4.5 19.5h15',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  package: 'M12 3 20 7.5v9L12 21l-8-4.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.4',
  cloud: 'M7 19h10.5a4.5 4.5 0 0 0 .7-8.95A6.5 6.5 0 0 0 5.6 9.4 4.8 4.8 0 0 0 7 19Z',
  upload: 'M12 15.5V4.5M7 9l5-5 5 5M4.5 19.5h15',
  lock: 'M6.5 10.5h11A1.5 1.5 0 0 1 19 12v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5ZM8 10.5v-3a4 4 0 0 1 8 0v3M12 14.5v2',
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6ZM9 12l2 2 4-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  pin: 'M12 17v5M9 3h6l-1 8 4 3H6l4-3-1-8Z',
  arrowUp: 'M12 19.5v-15M5.5 11 12 4.5 18.5 11',
  arrowUpRight: 'M7 17 17 7M7 7h10v10',
  sliders: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  square: 'M7 7h10v10H7z',
};
/*
 * Icon sizes follow the type scale in style.css:
 *   12      tiny chip / clear buttons (11-12px text)
 *   14      buttons, tabs, chips (12-13px text)
 *   16      body, banners, dialogs, toolbars (14-15px text)
 *   18      navigation and headings (14-16px text)
 *   20, 24  empty-state and feature glyphs
 * The stroke thickens as the glyph shrinks so every size renders a ~1.2-1.3px line,
 * matching the stem weight of Segoe UI / YaHei at those sizes.
 */
function opticalStroke(size: number) {
  if (size <= 12) return 2.2;
  if (size <= 14) return 2;
  if (size <= 16) return 1.85;
  if (size <= 18) return 1.75;
  if (size <= 20) return 1.6;
  return 1.5;
}
export function Icon({ name, size = 18, strokeWidth }: { name: IconName; size?: number; strokeWidth?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth ?? opticalStroke(size)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
