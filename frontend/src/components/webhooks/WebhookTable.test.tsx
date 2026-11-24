import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WebhookTable } from "./WebhookTable";
import type { WebhookSubscription } from "@/lib/api/webhooks";

/**
 * #1488 — WebhookTable row separation must meet WCAG 2.1 AA non-text contrast
 * (1.4.11, >= 3:1) and give visible hover / keyboard-focus feedback.
 *
 * The table always sits on the webhooks page's `bg-slate-950` <main>, which is
 * not theme-aware, so the same classes must apply under both the `light` and
 * `dark` <html> class.
 */

const subscriptions: WebhookSubscription[] = [
  { id: "wh_1", userAddress: "GA", targetUrl: "https://a.example/hook", eventTypes: ["STREAM_CREATED"], isActive: true, createdAt: "2026-09-20T00:00:00.000Z" },
  { id: "wh_2", userAddress: "GA", targetUrl: "https://b.example/hook", eventTypes: ["STREAM_PAUSED"], isActive: false, createdAt: "2026-09-21T00:00:00.000Z" },
  { id: "wh_3", userAddress: "GA", targetUrl: "https://c.example/hook", eventTypes: ["TOKENS_WITHDRAWN"], isActive: true, createdAt: "2026-09-22T00:00:00.000Z" },
];

const renderTable = () =>
  render(
    <WebhookTable subscriptions={subscriptions} onEdit={vi.fn()} onToggle={vi.fn()} onDelete={vi.fn()} onDeliveries={vi.fn()} />,
  );

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

describe.each(["light", "dark"])("WebhookTable styling (%s theme)", (theme) => {
  it("separates rows with slate-500 borders instead of the low-contrast white/10", () => {
    document.documentElement.className = theme;
    const { container } = renderTable();

    expect(container.querySelector("tbody")).toHaveClass("divide-y", "divide-slate-500");
    expect(container.querySelector("thead")).toHaveClass("border-b", "border-slate-500");
    expect(container.firstElementChild).toHaveClass("border", "border-slate-500");
    expect(container.innerHTML).not.toMatch(/(border|divide)-white\/10/);
  });

  it("highlights a row on hover and when one of its controls has keyboard focus", () => {
    document.documentElement.className = theme;
    const { container } = renderTable();
    const rows = container.querySelectorAll("tbody tr");

    expect(rows).toHaveLength(subscriptions.length);
    rows.forEach((row) => {
      expect(row).toHaveClass("hover:bg-white/5", "has-focus-visible:bg-white/5", "motion-safe:transition-colors");
    });
  });

  it("keeps secondary text at slate-400 so it stays >= 4.5:1 on hovered rows", () => {
    document.documentElement.className = theme;
    const { container } = renderTable();

    expect(container.querySelector("thead")).toHaveClass("text-slate-400");
    expect(container.innerHTML).not.toContain("text-slate-500");
  });
});

describe("WebhookTable contrast budget", () => {
  type Rgb = readonly [number, number, number];

  // sRGB values of the Tailwind v4 palette entries (oklch in tailwindcss/theme.css).
  const SLATE_950: Rgb = [0x02, 0x06, 0x18];
  const SLATE_500: Rgb = [0x62, 0x74, 0x8e];
  const SLATE_400: Rgb = [0x90, 0xa1, 0xb9];
  const SLATE_300: Rgb = [0xca, 0xd5, 0xe2];
  const SLATE_700: Rgb = [0x31, 0x41, 0x58];
  const WHITE: Rgb = [0xff, 0xff, 0xff];

  // Alpha-composites `fg` at `alpha` over `bg`, the way the browser paints `bg-white/5` etc.
  const over = ([r, g, b]: Rgb, alpha: number, [br, bgc, bb]: Rgb): Rgb => [
    Math.round(r * alpha + br * (1 - alpha)),
    Math.round(g * alpha + bgc * (1 - alpha)),
    Math.round(b * alpha + bb * (1 - alpha)),
  ];
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (a: Rgb, b: Rgb) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  // page bg-slate-950 -> table wrapper bg-white/[0.03] -> row hover:bg-white/5
  const rowBg = over(WHITE, 0.03, SLATE_950);
  const hoverBg = over(WHITE, 0.05, rowBg);

  it("row borders reach 3:1 against both resting and hovered rows", () => {
    expect(contrast(SLATE_500, rowBg)).toBeGreaterThanOrEqual(3);
    expect(contrast(SLATE_500, hoverBg)).toBeGreaterThanOrEqual(3);
    expect(contrast(SLATE_500, SLATE_950)).toBeGreaterThanOrEqual(3);
  });

  it("the previous white/10 and the issue's slate-700/60 suggestion both fall short", () => {
    expect(contrast(over(WHITE, 0.1, rowBg), rowBg)).toBeLessThan(3);
    expect(contrast(over(SLATE_700, 0.6, rowBg), rowBg)).toBeLessThan(3);
  });

  it("row text stays >= 4.5:1 on resting and hovered rows", () => {
    for (const text of [SLATE_300, SLATE_400]) {
      expect(contrast(text, rowBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, hoverBg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
