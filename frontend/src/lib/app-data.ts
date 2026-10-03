const DISPOSABLE_LOCAL_STORAGE_KEYS = [
  "flowfi.wallet.session.v1",
  "flowfi-theme",
  "flowfi-currency",
  "flowfi-amount-format",
  "flowfi-decimal-places",
  "flowfi.stream.templates.v1",
] as const;

const DISPOSABLE_SESSION_STORAGE_KEYS = [
  "flowfi.create-stream.draft.v1",
] as const;

export const APP_DATA_CLEAR_EVENT = "flowfi.app-data.clear.v1";

type ClearDisposableAppDataOptions = {
  broadcast?: boolean;
};

export function clearDisposableAppData({
  broadcast = true,
}: ClearDisposableAppDataOptions = {}): void {
  if (typeof window === "undefined") return;

  for (const key of DISPOSABLE_LOCAL_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }

  for (const key of DISPOSABLE_SESSION_STORAGE_KEYS) {
    sessionStorage.removeItem(key);
  }

  if (broadcast) {
    localStorage.setItem(
      APP_DATA_CLEAR_EVENT,
      JSON.stringify({ clearedAt: Date.now() }),
    );
  }
}

export function isAppDataClearEvent(key: string | null): boolean {
  return key === APP_DATA_CLEAR_EVENT;
}
