import { test, expect } from "@playwright/test";
import { mockConnectedWallet, RECIPIENT_PUBLIC_KEY } from "./utils/freighter";

test("single-screen /streams/create form validates input and submits a stream", async ({
  page,
}) => {
  await mockConnectedWallet(page);
  await page.goto("/streams/create");

  await expect(page.getByRole("heading", { name: "Create New Stream" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".wallet-chip").first()).toBeVisible({ timeout: 30_000 });

  const amount = page.locator("#create-stream-amount");

  await page.locator("#recipient").fill(RECIPIENT_PUBLIC_KEY);
  await page.locator("#create-stream-token").selectOption("USDC");

  // The other required fields are filled first because the browser's own
  // `required` check blocks the submit (and therefore the app's validation)
  // while one of them is empty. The form then validates on submit and renders
  // the messages inline.
  await amount.fill("0");
  await page.getByRole("button", { name: "Start Streaming" }).click();
  // The same message shows twice: inline under the field and as a toast.
  await expect(page.getByText("Amount must be a positive number").first()).toBeVisible();

  await amount.fill("10");
  await page.locator("#create-stream-duration").fill("7");

  await expect(page.getByText("0.00001653 USDC/sec")).toBeVisible();

  await page.getByRole("button", { name: "Start Streaming" }).click();

  await expect(page.getByText("Stream created successfully!")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
});