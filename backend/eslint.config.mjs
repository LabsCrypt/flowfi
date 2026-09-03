// ESLint flat config for the FlowFi backend (Node.js/Express + TypeScript).
// Mirrors the frontend setup (frontend/eslint.config.mjs), adapted for a
// non-React, Node-first codebase via typescript-eslint's recommended ruleset.
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "src/generated/**",
    "examples/**",
    "src/**/*.example.ts",
  ]),
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Forbid raw console.* calls in favour of the winston-based logger
      // (src/logger.ts).
      "no-console": "error",
      // Allow the conventional `_`-prefix for intentionally-unused
      // parameters, destructured variables, and caught errors.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Seed scripts legitimately print to stdout — console is fine there.
    files: ["prisma/seed.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Test files use `any` liberally for mocks/test doubles; keep them linted
    // but surface `any` as a warning instead of blocking.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
