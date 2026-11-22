import type * as StellarSdkModule from "@stellar/stellar-sdk";

/**
 * The type of the whole `@stellar/stellar-sdk` module as resolved at runtime.
 *
 * `import type * as` keeps this a type-only import: nothing from the SDK is
 * included in the initial bundle, but every caller of {@link loadStellarSdk}
 * still gets the SDK's real classes and enums instead of `any`.
 */
export type StellarSdk = typeof StellarSdkModule;

let sdkPromise: Promise<StellarSdk> | null = null;

/**
 * Loads `@stellar/stellar-sdk` lazily, once per session.
 *
 * The single cached promise both deduplicates the dynamic import and gives the
 * module's real types to `soroban.ts` and `amount.ts`, so a misspelled RPC
 * method or a wrong ScVal is a compile error rather than a runtime failure.
 */
export function loadStellarSdk(): Promise<StellarSdk> {
  sdkPromise ??= import("@stellar/stellar-sdk");
  return sdkPromise;
}

/**
 * The error-bearing subset of a failed simulation response.
 *
 * Small enough to destructure without importing the SDK's RPC types, while the
 * real `Api.SimulateTransactionResponse` still satisfies it structurally.
 */
export interface RpcErrorShape {
  error?: string | { message?: string };
}
