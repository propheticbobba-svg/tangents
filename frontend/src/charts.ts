const STORAGE_KEY = "tangents-charts";

export function loadCharts(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function saveCharts(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}
