"use client";

export function KeyboardShortcutBadge({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Show keyboard shortcuts"
      className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-accent/40 hover:text-accent"
    >
      <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 group-hover:text-accent">
        ?
      </kbd>
      <span>Keyboard shortcuts</span>
    </button>
  );
}
