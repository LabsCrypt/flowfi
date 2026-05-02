import { test, expect, type Page, type Route } from "@playwright/test";

test.describe("Stream Lifecycle Flow", () => {
  const MOCK_ADDRESS =
    "GBRRDO6S746E56R2T2B4VAM7J6U6U7S7S7S7S7S7S7S7S7S7S7S7S7S7";

  test.beforeEach(async ({ page }: { page: Page }) => {
    // Explicitly type the address parameter in the init script
    await page.addInitScript((addr: string) => {
      window.localStorage.setItem("wallet-connect-status", "connected");
      window.localStorage.setItem("wallet-address", addr);
    }, MOCK_ADDRESS);

    // Explicitly type the route parameter
    await page.route("**/v1/users/*/summary", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          address: MOCK_ADDRESS,
          totalStreamsCreated: 1,
          totalStreamedOut: "100000000",
          totalStreamedIn: "0",
          currentClaimable: "0",
          activeOutgoingCount: 1,
          activeIncomingCount: 0,
        }),
      });
    });

    await page.route("**/v1/streams*", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            streamId: 101,
            sender: MOCK_ADDRESS,
            recipient: "G...RECEIVER",
            tokenAddress: "C...TOKEN",
            ratePerSecond: "100",
            depositedAmount: "1000000",
            withdrawnAmount: "0",
            startTime: Math.floor(Date.now() / 1000),
            isActive: true,
          },
        ]),
      });
    });
  });

  // ... previous tests ...

  test("should pause, resume, and cancel a stream", async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.goto("http://localhost:3000/app/activity");

    // 1. Pause
    await page.getByRole("button", { name: /pause/i }).first().click();
    await expect(page.getByText(/paused/i)).toBeVisible();

    // 2. Resume
    await page
      .getByRole("button", { name: /resume/i })
      .first()
      .click();
    // FIXED: Use a proper Regex for "resumed" OR "active"
    await expect(page.locator("text=/resumed|active/i").first()).toBeVisible();

    // 3. Cancel
    await page
      .getByRole("button", { name: /cancel/i })
      .first()
      .click();
    await page.getByRole("button", { name: /confirm/i }).click();
    await expect(page.getByText(/cancelled/i)).toBeVisible();
  });
});
