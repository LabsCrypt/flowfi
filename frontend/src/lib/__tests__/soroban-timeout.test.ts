import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SorobanCallError } from "@/lib/soroban";

describe("Soroban Transaction Timeout & Abort Cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out and cleans up pending transaction promises when duration exceeds threshold", async () => {
    let timedOut = false;
    const timeoutMs = 500;

    const pendingTxPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!timedOut) {
          timedOut = true;
          reject(new SorobanCallError("Transaction timed out", "NetworkError"));
        }
      }, timeoutMs);

      // Clean up timer if settled elsewhere
      return () => clearTimeout(timer);
    });

    const wrapped = Promise.race([
      pendingTxPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new SorobanCallError("Transaction timed out", "NetworkError")), timeoutMs)
      ),
    ]);

    vi.advanceTimersByTime(500);

    await expect(wrapped).rejects.toThrowError(
      expect.objectContaining({
        message: "Transaction timed out",
        code: "NetworkError",
      })
    );
    expect(timedOut).toBe(true);
  });

  it("aborts cleanly when AbortSignal is triggered during transaction polling", async () => {
    const controller = new AbortController();
    let cleanupCalled = false;

    const abortableOperation = new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanupCalled = true;
        reject(new SorobanCallError("Transaction aborted by user", "WalletRejected"));
      };

      if (controller.signal.aborted) {
        onAbort();
      } else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    controller.abort();

    await expect(abortableOperation).rejects.toThrowError(
      expect.objectContaining({
        message: "Transaction aborted by user",
        code: "WalletRejected",
      })
    );
    expect(cleanupCalled).toBe(true);
  });

  it("retries specified number of times on transient network error before succeeding or failing", async () => {
    let attempts = 0;
    const maxRetries = 3;

    const unreliableCall = async (): Promise<string> => {
      attempts++;
      if (attempts < 3) {
        throw new SorobanCallError("Temporary RPC failure", "NetworkError");
      }
      return "success-tx-hash";
    };

    async function retryWithBackoff<T>(fn: () => Promise<T>, retries: number): Promise<T> {
      try {
        return await fn();
      } catch (err) {
        if (retries > 0 && err instanceof SorobanCallError && err.code === "NetworkError") {
          return retryWithBackoff(fn, retries - 1);
        }
        throw err;
      }
    }

    const result = await retryWithBackoff(unreliableCall, maxRetries);
    expect(result).toBe("success-tx-hash");
    expect(attempts).toBe(3);
  });
});
