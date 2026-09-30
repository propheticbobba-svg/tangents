const STORAGE_KEY = "tangents-web-search";

export function loadWebSearch(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function saveWebSearch(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}
