import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "src/generated/**",
      "prisma/migrations/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Types are checked by `tsc`; this gate is about the patterns `tsc`
      // cannot see (dead imports, shadowed names, accidental globals).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Existing service code still crosses the Stellar SDK boundary with
      // `any` in a few places; keep those visible without failing the build.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "error",
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "e2e/**/*.ts", "scripts/**/*.ts", "examples/**/*"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // Test doubles deliberately capture `this` for their mock transaction.
      "@typescript-eslint/no-this-alias": "off",
    },
  },
);
