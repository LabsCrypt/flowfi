import { test, expect } from "@playwright/test";
import { mockConnectedWallet, RECIPIENT_PUBLIC_KEY } from "./utils/freighter";

const MOCK_API_URL = "http://localhost:3100";

test("dashboard Details link opens the stream detail page", async ({ page }) => {
  // Connect as the stream SENDER so stream #42 is listed under My Active Streams.
  await mockConnectedWallet(page);

  await page.goto("/dashboard");

  const details = page.getByRole("link", { name: "Details" }).first();
  await expect(details).toBeVisible({ timeout: 30_000 });
  await expect(details).toHaveAttribute("href", "/streams/42");

  await details.click();

  await expect(page).toHaveURL(/\/streams\/42$/, { timeout: 20_000 });
  await expect(
    page.locator(".glass-card", { hasText: "Withdrawn" }).first(),
  ).toBeVisible({ timeout: 30_000 });
});

test("stream detail page shows stream state and reflects a withdrawal via mock events", async ({
  page,
}) => {
  // Connect as the stream RECIPIENT so the Withdraw action is available.
  await mockConnectedWallet(page, RECIPIENT_PUBLIC_KEY);

  await page.goto("/streams/42");

  const withdrawnCard = page.locator(".glass-card", { hasText: "Withdrawn" }).first();
  const claimableCard = page.locator(".glass-card", { hasText: "Claimable" }).first();

  await expect(withdrawnCard).toContainText("0 USDC", { timeout: 30_000 });
  // Live claimable is capped at the deposited amount by the dashboard contract.
  await expect(claimableCard).toContainText("10000 USDC", { timeout: 30_000 });

  const bump = await page.request.post(`${MOCK_API_URL}/__e2e/stream/42/withdraw`);
  expect(bump.ok()).toBeTruthy();

  await expect(withdrawnCard).toContainText("10 USDC", { timeout: 20_000 });

  const eventRow = page
    .locator("div.flex.items-center.gap-4.py-3", { hasText: "Withdrawn" })
    .first();
  await expect(eventRow).toBeVisible({ timeout: 20_000 });

  const withdrawnButton = page
    .getByRole("button", { name: /Withdraw/, exact: false })
    .first();
  await expect(withdrawnButton).toBeEnabled();
  await withdrawnButton.click();

  await expect(page.getByText("Withdrawal successful!")).toBeVisible({
    timeout: 30_000,
  });
});