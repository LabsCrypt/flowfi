"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState, useRef, useCallback } from "react";

function getInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  const saved = localStorage.getItem("flowfi-theme") as "light" | "dark" | "system" | null;
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  if (saved === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

export function ModeToggle() {
  const [theme, setThemeState] = useState<"light" | "dark">(() => getInitialTheme());
  const mountedRef = useRef(false);
  const [isMounted, setIsMounted] = useState(false);

  // Use requestAnimationFrame to avoid synchronous setState in effect
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      mountedRef.current = true;
      setIsMounted(true);
    });
    return () => cancelAnimationFrame(rafId);
  }, []);

  const toggleTheme = useCallback(() => {
    const newTheme = theme === "light" ? "dark" : "light";
    setThemeState(newTheme);
    localStorage.setItem("flowfi-theme", newTheme);
    document.documentElement.classList.toggle("dark", newTheme === "dark");
  }, [theme]);

  // Prevent hydration mismatch
  if (!isMounted) {
    return (
      <button className="inline-flex items-center justify-center w-8 h-8">
        <span className="sr-only">Toggle theme</span>
      </button>
    );
  }

  return (
    <button
      onClick={toggleTheme}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/10 dark:hover:bg-black/10 transition-colors"
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90 text-yellow-500" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0 text-blue-400" />
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
