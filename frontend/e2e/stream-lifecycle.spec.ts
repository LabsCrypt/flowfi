import { test, expect, type Page, type Route } from "@playwright/test";

test.describe("Stream Lifecycle Flow", () => {
  const MOCK_ADDRESS =
    "GCKSZH3YZR7BBA76LXI4RUKMVMSTJ67DIABZTQA2H3ISG5VZGLNU2NGP";

  test.beforeEach(async ({ page }: { page: Page }) => {
    // Mock Freighter extension messaging
    await page.addInitScript((addr: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).E2E_MOCK_SOROBAN = true;

      // The freighter API sets up a listener for FREIGHTER_EXTERNAL_MSG_RESPONSE
      window.addEventListener("message", (event) => {
        if (
          event.data &&
          event.data.source === "FREIGHTER_EXTERNAL_MSG_REQUEST"
        ) {
          const { type, messageId } = event.data;

          let responseData = {};
          if (type === "REQUEST_CONNECTION_STATUS") {
            responseData = { isConnected: true };
          } else if (type === "REQUEST_PUBLIC_KEY") {
            responseData = { publicKey: addr };
          } else if (type === "REQUEST_NETWORK_DETAILS") {
            responseData = {
              networkDetails: {
                network: "TESTNET",
                networkUrl: "https://horizon-testnet.stellar.org",
                networkPassphrase: "Test SDF Network ; September 2015",
              },
            };
          } else if (type === "SET_ALLOWED_STATUS") {
            responseData = { isAllowed: true };
          } else if (type === "REQUEST_ALLOWED_STATUS") {
            responseData = { isAllowed: true };
          } else if (type === "SIGN_TRANSACTION") {
            responseData = {
              signedTransaction: "mock_signed_tx_xdr",
              signedTxXdr: "mock_signed_tx_xdr",
              signerAddress: addr,
            };
          } else if (type === "REQUEST_ACCESS") {
            responseData = { publicKey: addr };
          }

          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messagedId: messageId,
              ...responseData,
            },
            "*",
          );
        }
      });

      // Also set window.freighter just in case
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).freighter = true;
    }, MOCK_ADDRESS);

    // Setup API interception routes
    // Note: use route.fulfill with JSON so the stream list can render deterministically.

    await page.route("**/v1/streams/*/events*", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
        }),
      });
    });

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
            lastUpdateTime: Math.floor(Date.now() / 1000),
            isActive: true,
            isPaused: false,
            status: "Active",
          },
        ]),
      });
    });

    // Mock individual stream endpoint since we navigate to details
    await page.route("**/v1/streams/101", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          streamId: 101,
          sender: MOCK_ADDRESS,
          recipient: "G...RECEIVER",
          tokenAddress: "C...TOKEN",
          ratePerSecond: "100",
          depositedAmount: "1000000",
          withdrawnAmount: "0",
          startTime: Math.floor(Date.now() / 1000),
          lastUpdateTime: Math.floor(Date.now() / 1000),
          isActive: true,
          isPaused: false,
          status: "Active",
        }),
      });
    });
  });

  test("should pause, resume, and cancel a stream", async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(60000); // 60 seconds

    await page.goto("http://localhost:3000/dashboard");

    // On the dashboard without a wallet, the connect modal appears automatically.
    const connectModal = page.getByRole("dialog", {
      name: /connect a wallet/i,
    });
    await expect(connectModal).toBeVisible({ timeout: 7000 });

    // Select Freighter from the modal
    const freighterBtn = page.getByRole("button", {
      name: /connect freighter/i,
    });
    await freighterBtn.waitFor({ state: "visible", timeout: 5000 });
    await freighterBtn.click();

    // Wait for modal to close indicating successful connection
    await expect(connectModal).toBeHidden({ timeout: 7000 });

    // Wait for the mocked stream list to mount
    await expect(
      page.getByRole("link", { name: /details/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // --- Create a new stream ---
    await page.getByRole("link", { name: "Create Stream" }).click();
    await expect(
      page.getByRole("heading", { name: "Create New Stream" }),
    ).toBeVisible({ timeout: 30000 });

    await page
      .getByPlaceholder("G...")
      .fill("GDOS6EZLJWBJIX7FUIC5EJ657T6MAFCADO524ZHFCKUIE3VZX23JRCY5");
    await page.getByPlaceholder("0.00").fill("100");
    await page.getByRole("button", { name: "Start Streaming" }).click();

    // Verify success and redirect
    await expect(page.getByText("Stream created successfully!")).toBeVisible({
      timeout: 30000,
    });
    // Wait for the automatic redirect back to dashboard
    await expect(page.getByRole("heading", { name: /Streams/i })).toBeVisible({
      timeout: 10000,
    });

    // --- Pause and Resume the stream ---
    // Navigate directly to the details page to avoid click bubbling issues on the row
    await page.goto("http://localhost:3000/streams/101");

    await expect(
      page.getByRole("heading", { name: /Stream Details/i }),
    ).toBeVisible({ timeout: 30000 });

    // Mock update BEFORE clicking pause! This prevents a race condition where
    // fetchStream() is called before the test runner sets up the new route.
    await page.route("**/v1/streams/101", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          streamId: 101,
          sender: "GCKSZH3YZR7BBA76LXI4RUKMVMSTJ67DIABZTQA2H3ISG5VZGLNU2NGP",
          recipient: "G...RECEIVER",
          tokenAddress: "C...TOKEN",
          ratePerSecond: "100",
          depositedAmount: "1000000",
          withdrawnAmount: "0",
          startTime: Math.floor(Date.now() / 1000),
          lastUpdateTime: Math.floor(Date.now() / 1000),
          isActive: true,
          isPaused: true,
          status: "Paused",
        }),
      });
    });

    // Click Pause
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Stream paused")).toBeVisible({
      timeout: 30000,
    });

    // Wait for the UI to reflect the paused state
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({
      timeout: 10000,
    });

    // Click Resume
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText("Stream resumed")).toBeVisible({
      timeout: 30000,
    });

    // --- Cancel Stream ---
    // The details page has a 'Cancel' button with an X icon
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // This opens the CancelConfirmModal
    await page.getByRole("button", { name: "Yes, Cancel Stream" }).click();

    // Status should be verified by the success toast
    await expect(page.getByText("Stream cancelled")).toBeVisible({
      timeout: 30000,
    });
  });
});
