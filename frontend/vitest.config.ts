import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./__tests__/setup.ts"],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
});
