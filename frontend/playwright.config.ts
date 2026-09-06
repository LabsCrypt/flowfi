import { defineConfig, devices } from "@playwright/test";

const API_PORT = Number(process.env.MOCK_API_PORT || 3100);
const APP_PORT = Number(process.env.E2E_APP_PORT || 3101);
const RPC_PORT = Number(process.env.MOCK_RPC_PORT || 3102);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      command: "node ./e2e/mocks/api-server.mjs",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npm run dev -- -p " + APP_PORT,
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_SOROBAN_RPC_URL: `https://localhost:${RPC_PORT}/soroban`,
        NEXT_PUBLIC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
        NEXT_PUBLIC_STREAM_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
      },
    },
  ],
});