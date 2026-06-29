"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ModeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    const rafId = requestAnimationFrame(() => setIsMounted(true));
    return () => cancelAnimationFrame(rafId);
  }, []);

  const toggleTheme = () => {
    setTheme(resolvedTheme === "light" ? "dark" : "light");
  };

  // Prevent hydration mismatch
  if (!isMounted) {
    return (
      <button className="inline-flex items-center justify-center w-8 h-8" aria-label="Toggle theme">
        <span className="sr-only">Toggle theme</span>
      </button>
    );
  }

  const currentTheme = resolvedTheme || theme;

  return (
    <button
      onClick={toggleTheme}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/10 dark:hover:bg-black/10 transition-colors"
      aria-label={`Switch to ${currentTheme === "light" ? "dark" : "light"} mode`}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90 text-yellow-500" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0 text-blue-400" />
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
