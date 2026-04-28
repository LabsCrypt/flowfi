"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export function ModeToggle() {
  const [theme, setThemeState] = useState<"light" | "dark">("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Read from localStorage directly to sync with settings page
    const saved = localStorage.getItem("flowfi-theme") as "light" | "dark" | "system" | null;
    if (saved === "light" || saved === "dark") {
      setThemeState(saved);
    } else if (saved === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setThemeState(prefersDark ? "dark" : "light");
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === "light" ? "dark" : "light";
    setThemeState(newTheme);
    // Save to localStorage with the same key as settings page
    localStorage.setItem("flowfi-theme", newTheme);
    // Apply theme immediately
    document.documentElement.classList.toggle("dark", newTheme === "dark");
  };

  // Prevent hydration mismatch
  if (!mounted) {
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
