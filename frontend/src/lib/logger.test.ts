import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "./logger";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("error always calls console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("test error", { detail: 1 });
    expect(spy).toHaveBeenCalledWith("test error", { detail: 1 });
  });

  it("debug calls console.debug in dev", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    logger.debug("debug msg");
    // In test env (NODE_ENV !== 'production'), debug should fire
    expect(spy).toHaveBeenCalledWith("debug msg");
  });

  it("info calls console.info in dev", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logger.info("info msg");
    expect(spy).toHaveBeenCalledWith("info msg");
  });

  it("warn calls console.warn in dev", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.warn("warn msg");
    expect(spy).toHaveBeenCalledWith("warn msg");
  });
});
