declare module '@stellar/freighter-api' {
  export function requestAccess(): Promise<{ address?: string; error?: string }>;
  export function signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string },
  ): Promise<string | { signedTxXdr?: string }>;
}
