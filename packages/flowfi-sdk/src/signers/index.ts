/**
 * Modular signer adapters for FlowFi client-side signing.
 *
 * The `FlowFiClient` never holds private keys itself. Instead it delegates
 * signing to a `Signer`, so the same client works in browsers (Freighter),
 * Node.js daemons (raw secret key), and custom setups (WalletConnect /
 * hardware wallets).
 */

export interface Signer {
  /** Public key (G...) that will appear as the transaction source / invoker. */
  getPublicKey(): Promise<string> | string;
  /**
   * Sign a base64 transaction envelope and return the signed envelope XDR.
   *
   * Implementations must NOT submit the transaction — submission is handled
   * by `FlowFiClient` so simulation/assembly stays in one place.
   */
  signTransaction(envelopeXdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
}

/** Generic callback-based signer for WalletConnect / hardware wallets. */
export class CustomSigner implements Signer {
  private publicKey: string;
  private signFn: (envelopeXdr: string) => Promise<string>;

  constructor(publicKey: string, signFn: (envelopeXdr: string) => Promise<string>) {
    this.publicKey = publicKey;
    this.signFn = signFn;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async signTransaction(envelopeXdr: string): Promise<string> {
    return this.signFn(envelopeXdr);
  }
}

/**
 * Node.js signer backed by a raw Stellar secret key (S...).
 *
 * Intended for automated payroll daemons and backend bots. Do NOT bundle a
 * production secret into frontend code.
 */
export class KeypairSigner implements Signer {
  private secret: string;

  constructor(secret: string) {
    if (!secret.startsWith('S')) {
      throw new Error('KeypairSigner expects a Stellar secret key starting with "S"');
    }
    this.secret = secret;
  }

  async getPublicKey(): Promise<string> {
    const { Keypair } = await import('@stellar/stellar-sdk');
    return Keypair.fromSecret(this.secret).publicKey();
  }

  async signTransaction(envelopeXdr: string, opts?: { networkPassphrase?: string }): Promise<string> {
    const { Keypair, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const networkPassphrase =
      opts?.networkPassphrase ?? 'Test SDF Network ; September 2015';
    const keypair = Keypair.fromSecret(this.secret);
    const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    if (typeof tx !== 'object' || tx === null || !('sign' in tx)) {
      throw new Error('KeypairSigner: envelope XDR is not a signable transaction');
    }
    (tx as { sign: (kp: unknown) => void }).sign(keypair);
    return (tx as { toXDR: () => string }).toXDR();
  }
}

/**
 * In-browser signer backed by the Freighter extension.
 *
 * Lazily imports `@stellar/freighter-api` so Node.js consumers never pay the
 * browser-only dependency cost unless they instantiate this class.
 */
export class FreighterSigner implements Signer {
  async getPublicKey(): Promise<string> {
    const freighter = await import('@stellar/freighter-api');
    const { address } = await freighter.requestAccess();
    if (!address) {
      throw new Error('FreighterSigner: no address returned — is Freighter installed and unlocked?');
    }
    return address;
  }

  async signTransaction(envelopeXdr: string, opts?: { networkPassphrase?: string }): Promise<string> {
    const freighter = await import('@stellar/freighter-api');
    const signed = await freighter.signTransaction(envelopeXdr, {
      networkPassphrase: opts?.networkPassphrase,
    });
    if (typeof signed === 'string') return signed;
    // Newer freighter-api returns `{ signedTxXdr }`.
    const maybe = signed as unknown as { signedTxXdr?: string };
    if (maybe.signedTxXdr) return maybe.signedTxXdr;
    throw new Error('FreighterSigner: unexpected signTransaction response shape');
  }
}
