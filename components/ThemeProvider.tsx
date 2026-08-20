"use client";

import React, { useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const ThemeContext = React.createContext<ThemeContextType>({
  theme: "system",
  setTheme: () => {},
});

function applyTheme(theme: Theme) {
  if (theme === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

// The stored theme is external state, so it is read through
// useSyncExternalStore: the server renders "system" and the client swaps in
// the stored value on hydration without a state update in an effect.
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

// Fallback when localStorage is unavailable, so the theme still switches for
// the current session.
let memoryTheme: Theme | null = null;

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : memoryTheme ?? "system";
  } catch {
    // localStorage can throw when cookies/storage are blocked.
    return memoryTheme ?? "system";
  }
}

function getServerTheme(): Theme {
  return "system";
}

function storeTheme(theme: Theme) {
  memoryTheme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Ignore write failures; memoryTheme keeps the choice for this session.
  }
  listeners.forEach((listener) => listener());
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getStoredTheme, getServerTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    // Listen for system theme changes when in system mode
    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = () => applyTheme("system");
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme: storeTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
