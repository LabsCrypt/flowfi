"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@/context/wallet-context";;

export default function SettingsPage() {
  const wallet = useWallet();

const address = wallet.session?.publicKey ?? "";
const disconnect = wallet.disconnect;

  const [emailNotifications, setEmailNotifications] = useState<boolean>(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [theme]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-gray-900 dark:via-gray-950 dark:to-black transition-colors">
      <div className="max-w-2xl mx-auto px-6 py-16 space-y-10">

        {/* Header */}
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Settings
          </h1>
          <p className="text-gray-500 mt-2">
            Manage your account preferences and wallet connection.
          </p>
        </div>

        {/* Wallet Section */}
        <div className="p-6 rounded-2xl bg-white/80 dark:bg-white/5 backdrop-blur border border-gray-200 dark:border-gray-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">Connected Wallet</span>
            {address && (
              <span className="text-xs px-3 py-1 rounded-full bg-green-100 dark:bg-green-900 text-green-600 dark:text-green-300">
                Connected
              </span>
            )}
          </div>

          <div className="p-3 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm break-all font-mono">
            {address || "No wallet connected"}
          </div>

          {address && (
            <button
              onClick={disconnect}
              className="w-full mt-2 bg-red-500 hover:bg-red-600 text-white py-2 rounded-xl transition-colors"
            >
              Disconnect Wallet
            </button>
          )}
        </div>

        {/* Preferences Section */}
        <div className="p-6 rounded-2xl bg-white/80 dark:bg-white/5 backdrop-blur border border-gray-200 dark:border-gray-800 shadow-sm space-y-6">

          {/* Email Notifications */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Email Notifications</p>
              <p className="text-sm text-gray-500">
                Receive updates and alerts about account activity.
              </p>
            </div>

            <button
              type="button"
               onClick={() => setEmailNotifications(prev => !prev)}
              className={`w-14 h-7 flex items-center rounded-full p-1 transition ${
                emailNotifications ? "bg-blue-600" : "bg-gray-400"
              }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full shadow transform transition ${
                  emailNotifications ? "translate-x-7" : ""
                }`}
              />
            </button>
          </div>

          {/* Theme Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Theme</p>
              <p className="text-sm text-gray-500">
                Toggle between light and dark mode.
              </p>
            </div>

            <button
              onClick={() =>
                setTheme(prev => (prev === "light" ? "dark" : "light"))
              }
              className="px-4 py-2 rounded-xl border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              {theme === "light" ? "Switch to Dark" : "Switch to Light"}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}