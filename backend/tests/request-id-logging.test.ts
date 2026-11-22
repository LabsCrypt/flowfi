/**
 * Issue #1494, acceptance criterion 3 — Winston appends the request id to log
 * lines on its own, so no handler has to pass it.
 *
 * The logger is used here unmocked, with a capture transport added to it, so
 * what is asserted is the real format pipeline in `src/logger.ts` reading the
 * real `requestContext` store that `requestIdMiddleware` populates.
 */
import { describe, it, expect, afterEach } from "vitest";
import Transport from "winston-transport";
import logger, { requestContext } from "../src/logger.js";

class CaptureTransport extends Transport {
  lines: Record<string, unknown>[] = [];

  log(info: Record<string, unknown>, next: () => void): void {
    this.lines.push(info);
    next();
  }
}

describe("request id logging (#1494 AC3)", () => {
  let capture: CaptureTransport;

  afterEach(() => {
    if (capture) logger.remove(capture);
  });

  function attach(): CaptureTransport {
    capture = new CaptureTransport({ level: "debug" });
    logger.add(capture);
    return capture;
  }

  it("appends requestId to a line logged inside the request context", () => {
    const transport = attach();

    requestContext.run({ requestId: "auto-append" }, () => {
      logger.info("handler wrote this without mentioning the id");
    });

    expect(transport.lines).toHaveLength(1);
    expect(transport.lines[0]?.requestId).toBe("auto-append");
    expect(transport.lines[0]?.level).toBe("info");
  });

  it("appends the id to every level the logger exposes", () => {
    const transport = attach();

    requestContext.run({ requestId: "all-levels" }, () => {
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
    });

    expect(transport.lines).toHaveLength(4);
    expect(transport.lines.map((line) => line.requestId)).toEqual([
      "all-levels",
      "all-levels",
      "all-levels",
      "all-levels",
    ]);
  });

  it("leaves the field off outside a request, rather than inventing one", () => {
    const transport = attach();

    logger.info("logged between requests");

    expect(transport.lines).toHaveLength(1);
    expect(transport.lines[0]?.requestId).toBeUndefined();
  });

  it("gives concurrent requests their own id in the log", () => {
    const transport = attach();

    // Two overlapping async scopes: each line must report the id of the request
    // that was in flight when it was written, not the last one to start.
    const first = new Promise<void>((resolve) => {
      requestContext.run({ requestId: "concurrent-first" }, async () => {
        await Promise.resolve();
        logger.info("first");
        resolve();
      });
    });
    const second = new Promise<void>((resolve) => {
      requestContext.run({ requestId: "concurrent-second" }, async () => {
        await Promise.resolve();
        logger.info("second");
        resolve();
      });
    });

    return Promise.all([first, second]).then(() => {
      const ids = transport.lines.map((line) => line.requestId).sort();
      expect(ids).toEqual(["concurrent-first", "concurrent-second"]);
    });
  });
});
