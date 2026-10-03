import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_DATA_CLEAR_EVENT,
  clearDisposableAppData,
  isAppDataClearEvent,
} from "./app-data";

describe("clearDisposableAppData", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("clears disposable FlowFi data", () => {
    localStorage.setItem("flowfi.wallet.session.v1", "wallet-session");
    localStorage.setItem("flowfi-theme", "light");
    localStorage.setItem("flowfi-currency", "EUR");
    localStorage.setItem("flowfi-amount-format", "compact");
    localStorage.setItem("flowfi-decimal-places", "4");
    localStorage.setItem("flowfi.stream.templates.v1", "templates");

    sessionStorage.setItem(
      "flowfi.create-stream.draft.v1",
      "draft"
    );

    clearDisposableAppData({ broadcast: false });

    expect(localStorage.getItem("flowfi.wallet.session.v1")).toBeNull();
    expect(localStorage.getItem("flowfi-theme")).toBeNull();
    expect(localStorage.getItem("flowfi-currency")).toBeNull();
    expect(localStorage.getItem("flowfi-amount-format")).toBeNull();
    expect(localStorage.getItem("flowfi-decimal-places")).toBeNull();
    expect(localStorage.getItem("flowfi.stream.templates.v1")).toBeNull();
    expect(
      sessionStorage.getItem("flowfi.create-stream.draft.v1")
    ).toBeNull();
  });

  it("does not clear storage keys outside the disposable allowlist", () => {
    localStorage.setItem(
      "flowfi.encrypted.vault.v1",
      "encrypted-vault-material"
    );
    localStorage.setItem("future-sensitive-key", "keep-me");

    clearDisposableAppData({ broadcast: false });

    expect(localStorage.getItem("flowfi.encrypted.vault.v1")).toBe(
      "encrypted-vault-material"
    );
    expect(localStorage.getItem("future-sensitive-key")).toBe("keep-me");
  });

  it("broadcasts a clear event by default", () => {
    clearDisposableAppData();

    const eventPayload = localStorage.getItem(APP_DATA_CLEAR_EVENT);

    expect(eventPayload).not.toBeNull();
    expect(eventPayload).toContain("clearedAt");
  });

  it("does not broadcast when broadcast is disabled", () => {
    clearDisposableAppData({ broadcast: false });

    expect(localStorage.getItem(APP_DATA_CLEAR_EVENT)).toBeNull();
  });

});

describe("isAppDataClearEvent", () => {
  it("recognizes the FlowFi clear event key", () => {
    expect(isAppDataClearEvent(APP_DATA_CLEAR_EVENT)).toBe(true);
  });

  it("rejects unrelated storage keys", () => {
    expect(isAppDataClearEvent("flowfi-theme")).toBe(false);
    expect(isAppDataClearEvent(null)).toBe(false);
  });
});
