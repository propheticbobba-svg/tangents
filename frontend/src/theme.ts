import { useEffect, useState } from "react";

const STORAGE_KEY = "tangents-theme";

export function useTheme() {
  const [choice, setChoice] = useState<"light" | "dark" | null>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  });
  // Dark-first: with no stored choice we default to dark, not the OS setting.
  const resolved = choice ?? "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  function toggle() {
    const next = resolved === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    setChoice(next);
  }

  return { resolved, toggle };
}
