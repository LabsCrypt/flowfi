import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

const eslintConfig = defineConfig([
  // ── TypeScript-aware parsing ──────────────────────────────────────────────
  ...tseslint.configs.recommended,

  // ── React rules ──────────────────────────────────────────────────────────
  {
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      // Next.js manages the React import; suppress the no-unused-vars for it
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },

  // ── Next.js rules ─────────────────────────────────────────────────────────
  {
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },

  // ── Global ignores ────────────────────────────────────────────────────────
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // ── Project-specific overrides ────────────────────────────────────────────
  {
    // Forbid raw console.* calls outside the logger module.
    // Use src/lib/logger.ts instead.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/logger.ts"],
    rules: {
      "no-console": "error",
    },
  },
]);

export default eslintConfig;
