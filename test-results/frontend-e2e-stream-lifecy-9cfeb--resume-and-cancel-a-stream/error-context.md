# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend\e2e\stream-lifecycle.spec.ts >> Stream Lifecycle Flow >> should pause, resume, and cancel a stream
- Location: frontend\e2e\stream-lifecycle.spec.ts:121:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/dashboard
Call log:
  - navigating to "http://localhost:3000/dashboard", waiting until "load"

```

# Test source

```ts
  28  |               }
  29  |             };
  30  |           } else if (type === "SET_ALLOWED_STATUS") {
  31  |             responseData = { isAllowed: true };
  32  |           } else if (type === "REQUEST_ALLOWED_STATUS") {
  33  |             responseData = { isAllowed: true };
  34  |           } else if (type === "SIGN_TRANSACTION") {
  35  |             responseData = { 
  36  |               signedTransaction: "mock_signed_tx_xdr",
  37  |               signedTxXdr: "mock_signed_tx_xdr",
  38  |               signerAddress: addr
  39  |             };
  40  |           } else if (type === "REQUEST_ACCESS") {
  41  |              responseData = { publicKey: addr };
  42  |           }
  43  |           
  44  |           window.postMessage({
  45  |             source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
  46  |             messagedId: messageId,
  47  |             ...responseData
  48  |           }, "*");
  49  |         }
  50  |       });
  51  |       
  52  |       // Also set window.freighter just in case
  53  |       (window as any).freighter = true;
  54  |     }, MOCK_ADDRESS);
  55  | 
  56  |     // 2. Setup API interception routes
  57  |     // Note: use route.fulfill with JSON so the stream list can render deterministically.
  58  | 
  59  |     await page.route("**/v1/users/*/summary", async (route: Route) => {
  60  |       await route.fulfill({
  61  |         status: 200,
  62  |         contentType: "application/json",
  63  |         body: JSON.stringify({
  64  |           address: MOCK_ADDRESS,
  65  |           totalStreamsCreated: 1,
  66  |           totalStreamedOut: "100000000",
  67  |           totalStreamedIn: "0",
  68  |           currentClaimable: "0",
  69  |           activeOutgoingCount: 1,
  70  |           activeIncomingCount: 0,
  71  |         }),
  72  |       });
  73  |     });
  74  | 
  75  |     await page.route("**/v1/streams*", async (route: Route) => {
  76  |       await route.fulfill({
  77  |         status: 200,
  78  |         contentType: "application/json",
  79  |         body: JSON.stringify([
  80  |           {
  81  |             streamId: 101,
  82  |             sender: MOCK_ADDRESS,
  83  |             recipient: "G...RECEIVER",
  84  |             tokenAddress: "C...TOKEN",
  85  |             ratePerSecond: "100",
  86  |             depositedAmount: "1000000",
  87  |             withdrawnAmount: "0",
  88  |             startTime: Math.floor(Date.now() / 1000),
  89  |             lastUpdateTime: Math.floor(Date.now() / 1000),
  90  |             isActive: true,
  91  |             isPaused: false,
  92  |             status: "Active",
  93  |           },
  94  |         ]),
  95  |       });
  96  |     });
  97  | 
  98  |     // Mock individual stream endpoint since we navigate to details
  99  |     await page.route("**/v1/streams/101", async (route: Route) => {
  100 |       await route.fulfill({
  101 |         status: 200,
  102 |         contentType: "application/json",
  103 |         body: JSON.stringify({
  104 |           streamId: 101,
  105 |           sender: MOCK_ADDRESS,
  106 |           recipient: "G...RECEIVER",
  107 |           tokenAddress: "C...TOKEN",
  108 |           ratePerSecond: "100",
  109 |           depositedAmount: "1000000",
  110 |           withdrawnAmount: "0",
  111 |           startTime: Math.floor(Date.now() / 1000),
  112 |           lastUpdateTime: Math.floor(Date.now() / 1000),
  113 |           isActive: true,
  114 |           isPaused: false,
  115 |           status: "Active",
  116 |         }),
  117 |       });
  118 |     });
  119 |   });
  120 | 
  121 |   test("should pause, resume, and cancel a stream", async ({
  122 |     page,
  123 |   }: {
  124 |     page: Page;
  125 |   }) => {
  126 |     test.setTimeout(60000); // 60 seconds
  127 | 
> 128 |     await page.goto("http://localhost:3000/dashboard");
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/dashboard
  129 | 
  130 |     // On the dashboard without a wallet, the connect modal appears automatically.
  131 |     const connectModal = page.getByRole("dialog", {
  132 |       name: /connect a wallet/i,
  133 |     });
  134 |     await expect(connectModal).toBeVisible({ timeout: 7000 });
  135 | 
  136 |     // Select Freighter from the modal
  137 |     const freighterBtn = page.getByRole("button", { name: /connect freighter/i });
  138 |     await freighterBtn.waitFor({ state: "visible", timeout: 5000 });
  139 |     await freighterBtn.click();
  140 | 
  141 |     // Wait for modal to close indicating successful connection
  142 |     await expect(connectModal).toBeHidden({ timeout: 7000 });
  143 | 
  144 |     // Wait for the mocked stream list to mount
  145 |     await expect(page.getByRole("link", { name: /details/i }).first()).toBeVisible({ timeout: 30000 });
  146 |     
  147 |     // --- 2. Create a new stream ---
  148 |     await page.getByRole("link", { name: "Create Stream" }).click();
  149 |     await expect(page.getByRole("heading", { name: "Create New Stream" })).toBeVisible({ timeout: 30000 });
  150 | 
  151 |     await page.getByPlaceholder("G...").fill("GDOS6EZLJWBJIX7FUIC5EJ657T6MAFCADO524ZHFCKUIE3VZX23JRCY5");
  152 |     await page.getByPlaceholder("0.00").fill("100");
  153 |     await page.getByRole("button", { name: "Start Streaming" }).click();
  154 | 
  155 |     // Verify success and redirect
  156 |     await expect(page.getByText("Stream created successfully!")).toBeVisible({ timeout: 30000 });
  157 |     // Wait for the automatic redirect back to dashboard
  158 |     await expect(page.getByRole("heading", { name: /Streams/i })).toBeVisible({ timeout: 10000 });
  159 |     
  160 |     // --- 3. Pause and Resume the stream ---
  161 |     // Navigate directly to the details page to avoid click bubbling issues on the row
  162 |     await page.goto("http://localhost:3000/streams/101");
  163 |     
  164 |     await expect(page.getByRole("heading", { name: /Stream Details/i })).toBeVisible({ timeout: 30000 });
  165 | 
  166 |     // Click Pause
  167 |     await page.getByRole("button", { name: "Pause" }).click();
  168 |     await expect(page.getByText("Stream paused")).toBeVisible({ timeout: 30000 });
  169 | 
  170 |     // Mock update: change stream to paused for the UI update so Resume button appears
  171 |     await page.route("**/v1/streams/101", async (route: Route) => {
  172 |       await route.fulfill({
  173 |         status: 200,
  174 |         contentType: "application/json",
  175 |         body: JSON.stringify({
  176 |           streamId: 101,
  177 |           sender: "GCKSZH3YZR7BBA76LXI4RUKMVMSTJ67DIABZTQA2H3ISG5VZGLNU2NGP",
  178 |           recipient: "G...RECEIVER",
  179 |           tokenAddress: "C...TOKEN",
  180 |           ratePerSecond: "100",
  181 |           depositedAmount: "1000000",
  182 |           withdrawnAmount: "0",
  183 |           startTime: Math.floor(Date.now() / 1000),
  184 |           lastUpdateTime: Math.floor(Date.now() / 1000),
  185 |           isActive: true,
  186 |           isPaused: true,
  187 |           status: "Paused",
  188 |         }),
  189 |       });
  190 |     });
  191 | 
  192 |     // Wait for the UI to reflect the paused state
  193 |     await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 10000 });
  194 | 
  195 |     // Click Resume
  196 |     await page.getByRole("button", { name: "Resume" }).click();
  197 |     await expect(page.getByText("Stream resumed")).toBeVisible({ timeout: 30000 });
  198 | 
  199 |     // --- 4. Cancel Stream ---
  200 |     // The details page has a 'Cancel' button with an X icon
  201 |     await page.getByRole("button", { name: "Cancel", exact: true }).click();
  202 |       
  203 |     // This opens the CancelConfirmModal
  204 |     await page.getByRole("button", { name: "Yes, Cancel Stream" }).click();
  205 |     
  206 |     // Status should be verified by the success toast
  207 |     await expect(page.getByText("Stream cancelled")).toBeVisible({ timeout: 30000 });
  208 |   });
  209 | });
  210 | 
```