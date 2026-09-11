/**
 * Icon set.
 *
 * One family, one grid (24), one stroke weight (1.5), round caps and joins.
 * Drawn inline rather than pulled from a font or a sprite so there is no extra
 * request and no flash of missing glyphs — and no emoji, which never match a
 * typeface and read as decoration rather than interface.
 */

/**
 * @param {string} paths
 * @param {number} size
 */
const svg = (paths, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/**
 * The icon set. Deliberately NOT annotated as a Record: with the concrete
 * object type inferred, `icon.candls(18)` fails to compile instead of throwing
 * "icon.candls is not a function" while rendering a page.
 */
export const icon = {
  // navigation
  candles: (s = 20) => svg('<path d="M7 3v4M7 17v4M17 3v2M17 19v2"/><rect x="4.5" y="7" width="5" height="10" rx="1"/><rect x="14.5" y="5" width="5" height="14" rx="1"/>', s),
  gauge: (s = 20) => svg('<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="m13.4 10.6 4-4"/><path d="M20.5 16a9 9 0 1 0-17 0"/>', s),
  list: (s = 20) => svg('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>', s),
  external: (s = 20) => svg('<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>', s),
  wallet: (s = 20) => svg('<path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h11.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19H6a2.5 2.5 0 0 1-2.5-2.5v-8Z"/><path d="M16 12.5h.01M3.5 10h17"/>', s),
  arrowDownCircle: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M9 12.5l3 3 3-3"/>', s),
  arrowUpCircle: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 15.5v-7M9 11.5l3-3 3 3"/>', s),
  transfer: (s = 20) => svg('<path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3"/>', s),
  receipt: (s = 20) => svg('<path d="M6 3.5h12v17l-2.5-1.5L13 20.5 10.5 19 8 20.5 6 19V3.5Z"/><path d="M9.5 8h5M9.5 12h5"/>', s),
  coins: (s = 20) => svg('<ellipse cx="9" cy="7" rx="5.5" ry="2.5"/><path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7"/><path d="M14.5 11.2c3 .2 5.2 1.2 5.2 2.4 0 1.4-2.5 2.5-5.5 2.5-1 0-2-.1-2.8-.4"/><path d="M8.5 15.5V17c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-3.4"/>', s),
  chart: (s = 20) => svg('<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>', s),
  gift: (s = 20) => svg('<rect x="3.5" y="9" width="17" height="4" rx="1"/><path d="M5 13v6.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V13M12 9v12"/><path d="M12 9S10.5 4 8 4a2 2 0 0 0 0 5M12 9s1.5-5 4-5a2 2 0 0 1 0 5"/>', s),
  users: (s = 20) => svg('<circle cx="9" cy="8" r="3.25"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.3a3.25 3.25 0 0 1 0 5.4M17.5 14.4a5.5 5.5 0 0 1 3 5.1"/>', s),

  // chrome
  chevronDown: (s = 20) => svg('<path d="m6 9 6 6 6-6"/>', s),
  chevronRight: (s = 20) => svg('<path d="m9 6 6 6-6 6"/>', s),
  chevronLeft: (s = 20) => svg('<path d="m15 6-6 6 6 6"/>', s),
  chevronsLeft: (s = 20) => svg('<path d="m11 6-6 6 6 6M18 6l-6 6 6 6"/>', s),
  plus: (s = 20) => svg('<path d="M12 5v14M5 12h14"/>', s),
  close: (s = 20) => svg('<path d="M6 6l12 12M18 6 6 18"/>', s),
  search: (s = 20) => svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>', s),
  bell: (s = 20) => svg('<path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>', s),
  grid: (s = 20) => svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>', s),
  rows: (s = 20) => svg('<rect x="3.5" y="4.5" width="17" height="5" rx="1.5"/><rect x="3.5" y="14.5" width="17" height="5" rx="1.5"/>', s),
  apps: (s = 20) => svg('<circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/>', s),
  sun: (s = 20) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>', s),
  moon: (s = 20) => svg('<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z"/>', s),
  globe: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17Z"/>', s),
  help: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.2 2.2 0 1 1 2.9 2.1c-.5.2-.7.6-.7 1.1v.5M12 16.5h.01"/>', s),
  user: (s = 20) => svg('<circle cx="12" cy="8.5" r="3.75"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>', s),
  menu: (s = 20) => svg('<path d="M4 7h16M4 12h16M4 17h16"/>', s),
  settings: (s = 20) => svg('<circle cx="12" cy="12" r="2.75"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>', s),
  logout: (s = 20) => svg('<path d="M15 17l5-5-5-5M20 12H9M12 20H6.5A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4H12"/>', s),
  info: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>', s),
  lock: (s = 20) => svg('<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>', s),
  shield: (s = 20) => svg('<path d="M12 3 5 5.8v5.6c0 4.2 2.9 8.1 7 9.1 4.1-1 7-4.9 7-9.1V5.8L12 3Z"/><path d="m9.2 12 2 2 3.6-3.8"/>', s),
  archive: (s = 20) => svg('<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-10"/><path d="M10 12h4"/>', s),
  restore: (s = 20) => svg('<path d="M4 9V4M4 9h5"/><path d="M4.6 9a8 8 0 1 1-.5 5.5"/>', s),
  download: (s = 20) => svg('<path d="M12 4v10M8.5 10.5 12 14l3.5-3.5"/><path d="M5 17.5v1A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-1"/>', s),
  copy: (s = 20) => svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>', s),
  card: (s = 20) => svg('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 14.5h3"/>', s),
  bank: (s = 20) => svg('<path d="M4 10h16M5.5 10v7M10 10v7M14 10v7M18.5 10v7M3 20h18M12 3.5 21 8H3l9-4.5Z"/>', s),
  bitcoin: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M10 7.5v9M12.5 7.5v9M8.5 9.5h5a2 2 0 0 1 0 4h-5h4.8a2 2 0 0 1 0 4H8.5"/>', s),
  more: (s = 20) => svg('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>', s),
  calendar: (s = 20) => svg('<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>', s),
  sparkline: (s = 20) => svg('<path d="M3.5 15.5 8 11l3.5 3 6-7"/><path d="M17.5 7H21v3.5"/>', s),

  // identity
  mail: (s = 20) => svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>', s),
  key: (s = 20) => svg('<circle cx="8" cy="8" r="4.5"/><path d="m11.2 11.2 8.3 8.3M17 14l2.5 2.5M14.5 16.5 17 19"/>', s),
  // Two states of one control, so they share a grid and the swap does not jump.
  eye: (s = 20) => svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>', s),
  eyeOff: (s = 20) => svg('<path d="M9.9 5.8A8.9 8.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4M6.2 7.9A17 17 0 0 0 2.5 12S6 18.5 12 18.5a8.8 8.8 0 0 0 3.4-.66"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3.5 3.5 17 17"/>', s),
  check: (s = 20) => svg('<path d="m4.5 12.5 5 5 10-11"/>', s),
  checkCircle: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.2 2.6 2.6 5-5.4"/>', s),
  alert: (s = 20) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>', s),
  smartphone: (s = 20) => svg('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>', s),
  monitor: (s = 20) => svg('<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20h6M12 16.5V20"/>', s),
  userPlus: (s = 20) => svg('<path d="M14.5 20v-1.5a4 4 0 0 0-4-4h-3a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M18 7.5v6M21 10.5h-6"/>', s),
  login: (s = 20) => svg('<path d="M14 3.5h3.5A2.5 2.5 0 0 1 20 6v12a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 16.5 14.5 12 10 7.5M14 12H3.5"/>', s),
};

/** Every icon name, as a type. */
/** @typedef {keyof typeof icon} IconName */

/**
 * Resolve an icon chosen at runtime (from data rather than written literally).
 *
 * Falls back to the info glyph rather than throwing: a missing icon should
 * leave the page readable, and the mistake is caught at build time anyway
 * wherever the name is a literal.
 *
 * @param {string} name
 * @param {number} [size]
 * @returns {string}
 */
export function glyph(name, size) {
  const draw = Object.hasOwn(icon, name)
    ? icon[/** @type {IconName} */ (name)]
    : icon.info;
  return draw(size);
}
