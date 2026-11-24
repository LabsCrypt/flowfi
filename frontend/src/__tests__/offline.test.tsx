import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { OfflineBanner } from "@/components/OfflineBanner";
import { LAST_SYNCED_KEY, minutesSince } from "@/hooks/useNetworkStatus";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

describe("OfflineBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    setOnline(true);
  });

  it("renders nothing while online and records a sync time", async () => {
    await act(async () => {
      render(<OfflineBanner />);
    });
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    expect(Number(localStorage.getItem(LAST_SYNCED_KEY))).toBeGreaterThan(0);
  });

  it("shows the banner with last-synced age when the connection drops", async () => {
    await act(async () => {
      render(<OfflineBanner />);
    });
    localStorage.setItem(LAST_SYNCED_KEY, String(Date.now() - 7 * 60_000));
    setOnline(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    const banner = screen.getByTestId("offline-banner");
    expect(banner).toHaveTextContent("You are offline");
    expect(banner).toHaveTextContent("Offline (Last synced 7 mins ago)");
  });

  it("hides again on reconnect", async () => {
    setOnline(false);
    await act(async () => {
      render(<OfflineBanner />);
    });
    expect(screen.getByTestId("offline-banner")).toHaveTextContent("never");
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("computes elapsed minutes", () => {
    expect(minutesSince(0, 5 * 60_000 + 1)).toBe(5);
    expect(minutesSince(10, 0)).toBe(0);
  });
});

describe("PWA assets", () => {
  it("manifest is installable", async () => {
    const fs = await import("node:fs");
    const m = JSON.parse(fs.readFileSync("public/manifest.webmanifest", "utf8"));
    expect(m.display).toBe("standalone");
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const i of m.icons) expect(fs.existsSync(`public${i.src}`)).toBe(true);
  });
});
