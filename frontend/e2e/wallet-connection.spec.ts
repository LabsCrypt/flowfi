import { test, expect } from "@playwright/test";
import { installFreighterMock, WALLET_PUBLIC_KEY } from "./utils/freighter";

test("connects a Freighter wallet, shows the account badge, and disconnects", async ({
  page,
}) => {
  await installFreighterMock(page);

  await page.goto("/");

  const connectButton = page.locator(".wallet-connect-btn").first();
  await expect(connectButton).toBeVisible({ timeout: 30_000 });
  await connectButton.click();

  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Connect Freighter" }).click();

  const chip = page.locator(".wallet-chip").first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toContainText(WALLET_PUBLIC_KEY.slice(0, 4));

  await chip.click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(page.locator(".wallet-connect-btn").first()).toBeVisible();
});