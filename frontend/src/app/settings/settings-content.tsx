"use client";

import { useState, useEffect, useMemo } from "react";
import { Copy, Check, LogOut, Moon, Sun, Bell, Globe } from "lucide-react";
import { STELLAR_NETWORK, shortenPublicKey } from "@/lib/wallet";
import { useWallet } from "@/context/wallet-context";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatNetwork } from "@/lib/wallet";
import toast from "react-hot-toast";
import { getApiBaseUrl } from "@/lib/api/_shared";
import { DisconnectConfirmModal } from "@/components/wallet/DisconnectConfirmModal";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

type DisplayCurrency = "USD" | "EUR" | "GBP" | "XLM" | "USDC";
type AmountFormat = "full" | "compact";
type DecimalPlaces = 2 | 4 | 7;

interface Settings {
  theme: "light" | "dark" | "system";
  displayCurrency: DisplayCurrency;
  amountFormat: AmountFormat;
  decimalPlaces: DecimalPlaces;
}

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0";
const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_STREAMING_CONTRACT || "CDV4K...7ZQY";
const INDEXER_URL = `${getApiBaseUrl()}/v1`;

const STORAGE_KEYS = {
  theme: "flowfi-theme",
  displayCurrency: "flowfi-currency",
  amountFormat: "flowfi-amount-format",
  decimalPlaces: "flowfi-decimal-places",
} as const;

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  displayCurrency: "USD",
  amountFormat: "full",
  decimalPlaces: 7,
};

function loadSavedSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const savedDecimals = localStorage.getItem(STORAGE_KEYS.decimalPlaces);
  return {
    theme:
      (localStorage.getItem(STORAGE_KEYS.theme) as Settings["theme"]) ||
      DEFAULT_SETTINGS.theme,
    displayCurrency:
      (localStorage.getItem(STORAGE_KEYS.displayCurrency) as DisplayCurrency) ||
      DEFAULT_SETTINGS.displayCurrency,
    amountFormat:
      (localStorage.getItem(STORAGE_KEYS.amountFormat) as AmountFormat) ||
      DEFAULT_SETTINGS.amountFormat,
    decimalPlaces: savedDecimals
      ? (parseInt(savedDecimals, 10) as DecimalPlaces)
      : DEFAULT_SETTINGS.decimalPlaces,
  };
}

function applyThemeClass(theme: Settings["theme"]): void {
  if (typeof window === "undefined") return;
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

function persistSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEYS.theme, settings.theme);
  localStorage.setItem(STORAGE_KEYS.displayCurrency, settings.displayCurrency);
  localStorage.setItem(STORAGE_KEYS.amountFormat, settings.amountFormat);
  localStorage.setItem(STORAGE_KEYS.decimalPlaces, settings.decimalPlaces.toString());
}

export default function SettingsContent() {
  const router = useRouter();
  const { session, disconnect, isHydrated } = useWallet();

  const [browserPush, setBrowserPush] = useState(false);
  const [draft, setDraft] = useState<Settings>(() => loadSavedSettings());
  const [saved, setSaved] = useState<Settings>(() => loadSavedSettings());
  const [lastLedger, setLastLedger] = useState<string>("Loading...");
  const [copied, setCopied] = useState(false);

  const isDirty = useMemo(
    () =>
      draft.theme !== saved.theme ||
      draft.displayCurrency !== saved.displayCurrency ||
      draft.amountFormat !== saved.amountFormat ||
      draft.decimalPlaces !== saved.decimalPlaces,
    [draft, saved]
  );

  // Covers tab close/refresh, internal link navigation, and back/forward
  useUnsavedChangesGuard(isDirty);

  // Apply the saved theme on mount
  useEffect(() => {
    applyThemeClass(draft.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleThemeChange = (newTheme: Settings["theme"]) => {
    setDraft((prev) => ({ ...prev, theme: newTheme }));
    applyThemeClass(newTheme); // live preview; persisted on save
  };

  const handleSave = () => {
    persistSettings(draft);
    setSaved(draft);
    toast.success("Settings saved");
  };

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleDisconnect = () => {
    if (isDirty) {
      const confirmed = window.confirm(
        "You have unsaved changes. Are you sure you want to disconnect?"
      );
      if (!confirmed) return;
    }
    disconnect();
    toast.success("Wallet disconnected");
    router.push("/");
  };

  const copyAddress = async () => {
    if (session?.publicKey) {
      await navigator.clipboard.writeText(session.publicKey);
      setCopied(true);
      toast.success("Address copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleBrowserPushToggle = async () => {
    if (!browserPush) {
      try {
        await Notification.requestPermission();
        setBrowserPush(Notification.permission === "granted");
        if (Notification.permission === "granted") {
          toast.success("Browser notifications enabled");
        }
      } catch {
        toast.error("Failed to enable notifications");
      }
    } else {
      setBrowserPush(false);
      toast("Browser notifications disabled");
    }
  };

  useEffect(() => {
    const fetchLastLedger = async () => {
      try {
        const response = await fetch(`${INDEXER_URL}/health`);
        if (response.ok) {
          const data = await response.json();
          if (data.ledger) {
            setLastLedger(data.ledger.toString());
          } else {
            setLastLedger("Unknown");
          }
        } else {
          setLastLedger("Unavailable");
        }
      } catch {
        setLastLedger("Error");
      }
    };
    fetchLastLedger();
  }, []);

  if (!isHydrated) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-black dark:from-white dark:via-gray-100 dark:to-gray-200 transition-colors flex items-center justify-center">
        <div className="text-white dark:text-black">Loading...</div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-black dark:from-white dark:via-gray-100 dark:to-gray-200 transition-colors">

      {/* Background Glow */}
      <div className="absolute -top-40 -right-40 w-96 h-96 bg-purple-600/20 blur-3xl rounded-full" />
      <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-blue-600/20 blur-3xl rounded-full" />

      <div className="relative max-w-xl mx-auto px-6 py-20">
        <div className="rounded-3xl border border-white/10 dark:border-black/10 bg-white/5 dark:bg-black/5 backdrop-blur-2xl shadow-2xl p-10 space-y-10">

          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white dark:text-black">
              Settings
            </h1>
            <p className="text-sm opacity-60 mt-1">
              Manage your FlowFi preferences
            </p>
          </div>

          {/* Browser Push Notifications */}
          <div className="flex items-center justify-between group">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400">
                <Bell size={18} />
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">
                  Browser Notifications
                </p>
                <p className="text-sm opacity-60">
                  Get notified about stream activity
                </p>
              </div>
            </div>

            <button
              onClick={handleBrowserPushToggle}
              aria-label="Toggle browser notifications"
              aria-pressed={browserPush}
              className={`relative w-14 h-7 rounded-full transition-all duration-300 ${
                browserPush
                  ? "bg-gradient-to-r from-purple-500 to-blue-500"
                  : "bg-zinc-600"
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow-md transform transition duration-300 ${
                  browserPush
                    ? "translate-x-7"
                    : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Theme Toggle */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
                {draft.theme === "dark" ? <Moon size={18} /> : draft.theme === "light" ? <Sun size={18} /> : <Globe size={18} />}
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">
                  Appearance
                </p>
                <p className="text-sm opacity-60">
                  Choose your theme preference
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              {(["light", "dark", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                    draft.theme === t
                      ? "border-purple-500 bg-purple-500/20 text-white"
                      : "border-white/10 dark:border-black/10 text-white/60 dark:text-black/60 hover:border-white/20"
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Display Preferences */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/20 text-green-400">
                <Globe size={18} />
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">
                  Display Preferences
                </p>
                <p className="text-sm opacity-60">
                  Customize how amounts are displayed
                </p>
              </div>
            </div>

            <div className="space-y-3 pl-12">
              <div>
                <label htmlFor="default-token" className="text-sm text-white/60 dark:text-black/60">Default Token</label>
                <select
                  id="default-token"
                  value={draft.displayCurrency}
                  onChange={(e) => {
                    const val = e.target.value as DisplayCurrency;
                    setDraft((prev) => ({ ...prev, displayCurrency: val }));
                  }}
                  className="mt-1 block w-full px-3 py-2 rounded-lg bg-black/40 dark:bg-white/40 border border-white/10 dark:border-black/10 text-white dark:text-black text-sm"
                >
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="GBP">GBP (£)</option>
                  <option value="XLM">XLM</option>
                  <option value="USDC">USDC</option>
                </select>
              </div>

              <div>
                <label id="amount-format-label" className="text-sm text-white/60 dark:text-black/60">Amount Format</label>
                <div
                  className="flex gap-2 mt-1"
                  role="radiogroup"
                  aria-labelledby="amount-format-label"
                >
                  {(["full", "compact"] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, amountFormat: fmt }))
                      }
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                        draft.amountFormat === fmt
                          ? "border-blue-500 bg-blue-500/20 text-white"
                          : "border-white/10 text-white/60 hover:border-white/20"
                      }`}
                    >
                      {fmt === "full" ? "Full (1.0000000)" : "Compact (1.0)"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label id="decimal-places-label" className="text-sm text-white/60 dark:text-black/60">Decimal Places</label>
                <div
                  className="flex gap-2 mt-1"
                  role="radiogroup"
                  aria-labelledby="decimal-places-label"
                >
                  {([2, 4, 7] as DecimalPlaces[]).map((places) => (
                    <button
                      key={places}
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, decimalPlaces: places }))
                      }
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                        draft.decimalPlaces === places
                          ? "border-green-500 bg-green-500/20 text-white"
                          : "border-white/10 text-white/60 hover:border-white/20"
                      }`}
                    >
                      {places} decimals
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Save Changes */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 dark:border-black/10 bg-black/30 dark:bg-white/30 px-5 py-4">
            <div>
              <p className="text-sm font-medium text-white dark:text-black">
                Save changes
              </p>
              <p className="text-xs opacity-60">
                {isDirty
                  ? "You have unsaved changes"
                  : "Your preferences are up to date"}
              </p>
            </div>
            <button
              onClick={handleSave}
              disabled={!isDirty}
              className={`px-4 py-2 text-sm rounded-xl font-semibold transition-all ${
                isDirty
                  ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/25 cursor-pointer"
                  : "bg-white/10 text-white/40 dark:bg-black/10 dark:text-black/40 cursor-not-allowed"
              }`}
            >
              Save changes
            </button>
          </div>

          {/* Wallet Section */}
          {session ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-medium text-white dark:text-black">
                  Connected Wallet
                </p>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                    {formatNetwork(session.network)}
                  </span>
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">
                    {session.walletName}
                  </span>
                </div>
              </div>

              <div className="relative flex items-center justify-between bg-black/40 dark:bg-white/40 px-5 py-4 rounded-xl font-mono text-sm break-all text-white dark:text-black border border-white/10 dark:border-black/10">
                <span className="pr-4">{session.publicKey}</span>

                <button
                  onClick={copyAddress}
                  aria-label={copied ? "Address copied" : "Copy wallet address"}
                  className="ml-3 opacity-70 hover:opacity-100 transition flex-shrink-0"
                >
                  {copied ? (
                    <Check size={18} className="text-green-400" />
                  ) : (
                    <Copy size={18} />
                  )}
                </button>

                {copied && (
                  <span className="absolute -top-8 right-2 text-xs bg-black text-white dark:bg-white dark:text-black px-2 py-1 rounded-md shadow">
                    Copied
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="font-medium text-white dark:text-black">
                Wallet Status
              </p>
              <div className="flex items-center justify-between bg-black/40 dark:bg-white/40 px-5 py-4 rounded-xl text-white dark:text-black border border-white/10 dark:border-black/10">
                <span>Not connected</span>
                <Link href="/" className="text-accent hover:opacity-80 transition font-semibold">
                  Connect Wallet
                </Link>
              </div>
            </div>
          )}

          {/* About Section */}
          <div className="space-y-4 pt-6 border-t border-white/10 dark:border-black/10">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-slate-500/20 text-slate-400">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4M12 8h.01"/>
                </svg>
              </div>
              <div>
                <p className="font-medium text-white dark:text-black">About</p>
                <p className="text-sm opacity-60">App and contract information</p>
              </div>
            </div>

            <div className="space-y-3 pl-12">
              <div className="flex items-center justify-between py-2 border-b border-white/5 dark:border-black/5">
                <span className="text-sm text-white/60 dark:text-black/60">App Version</span>
                <span className="text-sm font-mono text-white dark:text-black">{APP_VERSION}</span>
              </div>

              <div className="flex items-center justify-between py-2 border-b border-white/5 dark:border-black/5">
                <span className="text-sm text-white/60 dark:text-black/60">Contract Address</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-white dark:text-black">{shortenPublicKey(CONTRACT_ADDRESS)}</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(CONTRACT_ADDRESS);
                      toast.success("Contract address copied");
                    }}
                    aria-label="Copy contract address"
                    className="opacity-60 hover:opacity-100 transition"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between py-2 border-b border-white/5 dark:border-black/5">
                <span className="text-sm text-white/60 dark:text-black/60">Network</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                  {STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet"}
                </span>
              </div>

              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-white/60 dark:text-black/60">Indexer Last Ledger</span>
                <span className="text-sm font-mono text-white dark:text-black">{lastLedger}</span>
              </div>
            </div>
          </div>

          {/* Disconnect */}
          {session && (
            <>
              <button
                onClick={() => setShowDisconnectConfirm(true)}
                className="w-full flex items-center justify-center gap-2 bg-red-600/90 hover:bg-red-600 transition px-4 py-3 rounded-xl text-white font-medium shadow-lg hover:shadow-red-500/30"
              >
                <LogOut size={18} />
                Disconnect Wallet
              </button>

              {showDisconnectConfirm && (
                <DisconnectConfirmModal
                  onClose={() => setShowDisconnectConfirm(false)}
                  onConfirm={() => {
                    setShowDisconnectConfirm(false);
                    handleDisconnect();
                  }}
                  walletAddress={session.publicKey}
                />
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
