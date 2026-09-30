const STORAGE_KEY = "tangents-sidebar-width";
const MIN_CHAT_WIDTH = 360;

export const DEFAULT_SIDEBAR_WIDTH = 384;
export const MIN_SIDEBAR_WIDTH = 280;

export function maxSidebarWidth(viewport = window.innerWidth): number {
  return Math.max(MIN_SIDEBAR_WIDTH, viewport - MIN_CHAT_WIDTH);
}

export function clampSidebarWidth(width: number, viewport = window.innerWidth): number {
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), maxSidebarWidth(viewport)));
}

export function loadSidebarWidth(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH;
}

export function saveSidebarWidth(width: number) {
  localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
}
