"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type SortDirection = "asc" | "desc";

export interface TablePreferences<ColumnId extends string = string> {
  sortBy: ColumnId | null;
  sortDirection: SortDirection;
  visibleColumns: ColumnId[];
}

export interface UseTablePreferencesOptions<ColumnId extends string> {
  /** localStorage key for this table's preferences. */
  storageKey: string;
  /** All available column ids, in their default display order. */
  defaultColumns: readonly ColumnId[];
  /** Column to sort by on first load (defaults to no sorting). */
  defaultSortBy?: ColumnId | null;
  /** Default sort direction (defaults to "desc"). */
  defaultSortDirection?: SortDirection;
}

export interface UseTablePreferencesReturn<ColumnId extends string> {
  sortBy: ColumnId | null;
  sortDirection: SortDirection;
  visibleColumns: ColumnId[];
  /** Whether a column is currently visible. */
  isVisible: (columnId: ColumnId) => boolean;
  /** Toggle a column's visibility. */
  toggleColumn: (columnId: ColumnId) => void;
  /** Sort by a column, toggling direction when that column is already active. */
  setSort: (columnId: ColumnId) => void;
  /** Restore the default layout (sort + visible columns). */
  resetPreferences: () => void;
}

const COLUMN_SEPARATOR = "\u0000";

const isSortDirection = (value: unknown): value is SortDirection =>
  value === "asc" || value === "desc";

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Coerce an arbitrary parsed localStorage value into a valid preferences
 * object. Unknown columns and invalid directions are dropped; a completely
 * invalid payload falls back to the defaults. This is what makes the table
 * resilient to corrupted or stale ("schema drift") stored state.
 */
export function sanitizeTablePreferences<ColumnId extends string>(
  raw: unknown,
  defaults: TablePreferences<ColumnId>,
  knownColumns: readonly ColumnId[],
): TablePreferences<ColumnId> {
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const candidate = raw as Partial<TablePreferences<ColumnId>>;

  const sortBy =
    candidate.sortBy === null ||
    (typeof candidate.sortBy === "string" &&
      knownColumns.includes(candidate.sortBy as ColumnId))
      ? (candidate.sortBy as ColumnId | null)
      : defaults.sortBy;

  const sortDirection = isSortDirection(candidate.sortDirection)
    ? candidate.sortDirection
    : defaults.sortDirection;

  let visibleColumns = defaults.visibleColumns;
  if (Array.isArray(candidate.visibleColumns)) {
    const deduped: ColumnId[] = [];
    const seen = new Set<ColumnId>();
    for (const id of candidate.visibleColumns) {
      if (
        typeof id === "string" &&
        knownColumns.includes(id as ColumnId) &&
        !seen.has(id as ColumnId)
      ) {
        seen.add(id as ColumnId);
        deduped.push(id as ColumnId);
      }
    }
    // Keep only known columns; if none survive, fall back to defaults so the
    // table is never rendered completely empty.
    visibleColumns = deduped.length > 0 ? deduped : defaults.visibleColumns;
  }

  return { sortBy, sortDirection, visibleColumns };
}

// ─── External store (localStorage-backed) ─────────────────────────────────────

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

function notify(storageKey: string): void {
  listeners.get(storageKey)?.forEach((listener) => listener());
}

function getSnapshot(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function getServerSnapshot(): string | null {
  return null;
}

function subscribe(storageKey: string, listener: Listener): () => void {
  let group = listeners.get(storageKey);
  if (!group) {
    group = new Set();
    listeners.set(storageKey, group);
  }
  group.add(listener);

  // Keep other tabs in sync.
  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey) listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  return () => {
    group?.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function writeSnapshot(storageKey: string, value: string): void {
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // Storage may be unavailable or full — preferences simply won't persist.
  }
  notify(storageKey);
}

/**
 * Persist a table's sort column/direction and visible columns to
 * localStorage. Safe for SSR (server snapshot is the default layout) and
 * tolerates corrupted or stale stored values.
 */
export function useTablePreferences<ColumnId extends string>({
  storageKey,
  defaultColumns,
  defaultSortBy = null,
  defaultSortDirection = "desc",
}: UseTablePreferencesOptions<ColumnId>): UseTablePreferencesReturn<ColumnId> {
  // Depend on the column *contents* rather than the array identity so callers
  // can pass an inline array without triggering render loops.
  const columnsKey = defaultColumns.join(COLUMN_SEPARATOR);

  const knownColumns = useMemo(
    () =>
      columnsKey ? (columnsKey.split(COLUMN_SEPARATOR) as ColumnId[]) : [],
    [columnsKey],
  );

  const defaultPreferences = useMemo<TablePreferences<ColumnId>>(
    () => ({
      sortBy: defaultSortBy,
      sortDirection: defaultSortDirection,
      visibleColumns: [...knownColumns],
    }),
    [knownColumns, defaultSortBy, defaultSortDirection],
  );

  const subscribeToStore = useCallback(
    (listener: Listener) => subscribe(storageKey, listener),
    [storageKey],
  );
  const getClientSnapshot = useCallback(
    () => getSnapshot(storageKey),
    [storageKey],
  );

  const storedValue = useSyncExternalStore(
    subscribeToStore,
    getClientSnapshot,
    getServerSnapshot,
  );

  const preferences = useMemo(
    () =>
      sanitizeTablePreferences(
        safeParse(storedValue),
        defaultPreferences,
        knownColumns,
      ),
    [storedValue, defaultPreferences, knownColumns],
  );

  const commit = useCallback(
    (next: TablePreferences<ColumnId>) => {
      writeSnapshot(storageKey, JSON.stringify(next));
    },
    [storageKey],
  );

  const setSort = useCallback(
    (columnId: ColumnId) => {
      const next: TablePreferences<ColumnId> =
        preferences.sortBy === columnId
          ? {
              ...preferences,
              sortDirection:
                preferences.sortDirection === "asc" ? "desc" : "asc",
            }
          : { ...preferences, sortBy: columnId, sortDirection: "asc" };
      commit(next);
    },
    [preferences, commit],
  );

  const toggleColumn = useCallback(
    (columnId: ColumnId) => {
      if (preferences.visibleColumns.includes(columnId)) {
        const remaining = preferences.visibleColumns.filter(
          (id) => id !== columnId,
        );
        // Never hide the last remaining column.
        commit({
          ...preferences,
          visibleColumns:
            remaining.length > 0
              ? remaining
              : [...defaultPreferences.visibleColumns],
        });
        return;
      }
      // Re-insert the column according to the default column order.
      const next = defaultPreferences.visibleColumns.filter(
        (id) => preferences.visibleColumns.includes(id) || id === columnId,
      );
      commit({ ...preferences, visibleColumns: next });
    },
    [preferences, defaultPreferences, commit],
  );

  const resetPreferences = useCallback(() => {
    commit({
      sortBy: defaultPreferences.sortBy,
      sortDirection: defaultPreferences.sortDirection,
      visibleColumns: [...defaultPreferences.visibleColumns],
    });
  }, [commit, defaultPreferences]);

  const isVisible = useCallback(
    (columnId: ColumnId) => preferences.visibleColumns.includes(columnId),
    [preferences.visibleColumns],
  );

  return {
    sortBy: preferences.sortBy,
    sortDirection: preferences.sortDirection,
    visibleColumns: preferences.visibleColumns,
    isVisible,
    toggleColumn,
    setSort,
    resetPreferences,
  };
}
