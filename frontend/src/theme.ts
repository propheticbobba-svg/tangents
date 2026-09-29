import { useEffect, useState } from "react";

const STORAGE_KEY = "tangents-theme";

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [choice, setChoice] = useState<"light" | "dark" | null>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  });
  const [system, setSystem] = useState(systemTheme);
  const resolved = choice ?? system;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(systemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const next = resolved === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    setChoice(next);
  }

  return { resolved, toggle };
}
