import { useCallback, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "sb_theme";

function stored(): Theme | null {
  const t = localStorage.getItem(KEY);
  return t === "light" || t === "dark" ? t : null;
}

/** Resolve the theme that should be active right now (stored → system). */
export function resolveTheme(): Theme {
  return (
    stored() ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}

/** Apply a theme to <html> and persist the choice. */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", t === "dark");
  root.style.colorScheme = t;
  localStorage.setItem(KEY, t);
}

/** React hook: current theme + toggle. Initial state mirrors the class the
 * inline boot script in index.html already applied, so there is no flash. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, toggle };
}
