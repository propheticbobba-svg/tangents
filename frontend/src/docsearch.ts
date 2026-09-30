const STORAGE_KEY = "tangents-doc-search";

export function loadDocSearch(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function saveDocSearch(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}
