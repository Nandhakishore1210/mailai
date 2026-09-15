"use client";
import { useEffect } from "react";
import { useUIStore } from "@/store/uiStore";

/** Restores the saved theme (or the OS preference) on first load. */
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    let theme: "light" | "dark" = "light";
    try {
      const saved = localStorage.getItem("theme");
      const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      theme = saved === "dark" || (!saved && prefersDark) ? "dark" : "light";
    } catch {
      /* ignore */
    }
    setTheme(theme);
  }, [setTheme]);

  return <>{children}</>;
}
