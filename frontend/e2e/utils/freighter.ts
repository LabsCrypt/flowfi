import type { Page } from "@playwright/test";

export const WALLET_PUBLIC_KEY =
  "GB5P5GY25PGHPN4DG2XSQLWCUHTFUK2GDZ75IWB7KZV3RKBVH33GZ32U";
export const RECIPIENT_PUBLIC_KEY =
  "GDBX55OJUOXRSTWICUESBZAHSMJNFWZ57NEEPVN74BXKH7OGZV23RYCG";
export const SESSION_STORAGE_KEY = "flowfi.wallet.session.v1";

/**
 * Injects a window-level mock for the Freighter browser extension using the
 * postMessage protocol implemented by @stellar/freighter-api v6
 * (FREIGHTER_EXTERNAL_MSG_REQUEST / FREIGHTER_EXTERNAL_MSG_RESPONSE).
 */
export function freighterInitScript(address: string): string {
  return `
    (() => {
      const address = ${JSON.stringify(address)};

      window.freighter = { version: "mock" };

      const respond = (messageId, payload) => {
        window.postMessage(
          {
            source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
            messagedId: messageId,
            extensionName: "FREIGHTER",
            apiVersion: 1,
            ...payload,
          },
          window.location.origin,
        );
      };

      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;

        switch (data.type) {
          case "REQUEST_ACCESS":
          case "REQUEST_PUBLIC_KEY":
            respond(data.messageId, { publicKey: address, error: undefined });
            break;
          case "REQUEST_CONNECTION_STATUS":
            respond(data.messageId, { isConnected: true });
            break;
          case "REQUEST_ALLOWED_STATUS":
          case "SET_ALLOWED_STATUS":
            respond(data.messageId, { isAllowed: true });
            break;
          case "REQUEST_NETWORK_DETAILS":
            respond(data.messageId, {
              networkDetails: {
                network: "TESTNET",
                networkName: "SDF Test Network",
                networkUrl: "https://horizon-testnet.stellar.org",
                networkPassphrase: "Test SDF Network ; September 2015",
                sorobanRpcUrl: "https://soroban-testnet.stellar.org",
              },
              error: undefined,
            });
            break;
          case "SUBMIT_TRANSACTION":
            respond(data.messageId, {
              signedTransaction: data.transactionXdr,
              signerAddress: address,
              error: undefined,
            });
            break;
          default:
            respond(data.messageId, {
              error: { code: -2, message: "Unsupported mock request: " + data.type },
            });
            break;
        }
      });
    })();
  `;
}

export async function installFreighterMock(
  page: Page,
  address: string = WALLET_PUBLIC_KEY,
): Promise<void> {
  await page.addInitScript(freighterInitScript(address));
}

/**
 * Seeds a persisted, non-mocked wallet session so pages hydrate straight into
 * the connected state without opening the connect modal.
 */
export async function seedWalletSession(
  page: Page,
  address: string = WALLET_PUBLIC_KEY,
): Promise<void> {
  await page.addInitScript(
    ({ key, storageKey }) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          walletId: "freighter",
          walletName: "Freighter",
          publicKey: key,
          connectedAt: new Date().toISOString(),
          network: "Testnet",
          mocked: false,
        }),
      );
    },
    { key: address, storageKey: SESSION_STORAGE_KEY },
  );
}

/** Sets up a mocked Freighter extension AND a persisted connected session. */
export async function mockConnectedWallet(
  page: Page,
  address: string = WALLET_PUBLIC_KEY,
): Promise<void> {
  await installFreighterMock(page, address);
  await seedWalletSession(page, address);
}