/** Parse a raw base-unit amount string into a JS number. */
export function formatUnits(raw: string | number | bigint | null | undefined, decimals: number): number {
  if (raw === null || raw === undefined) return 0;
  const value = typeof raw === 'bigint' ? raw : BigInt(String(raw).split('.')[0] || '0');
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = value / base;
  const fraction = value % base;
  return Number(whole) + Number(fraction) / Number(base);
}

/** Real-time claimable at `nowMs`, accounting for cliff + pause. */
export function computeClaimable(stream: {
  depositedAmount: string;
  withdrawnAmount: string;
  startTimestamp: number;
  endTimestamp: number;
  cliffTimestamp: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  token: { decimals: number };
}, nowMs: number): number {
  const decimals = stream.token?.decimals ?? 18;
  const deposited = formatUnits(stream.depositedAmount, decimals);
  const withdrawn = formatUnits(stream.withdrawnAmount, decimals);
  const nowSec = Math.floor(nowMs / 1000);

  if (stream.status === 'cancelled') return 0;
  if (nowSec < stream.cliffTimestamp) return 0;

  const duration = Math.max(0, stream.endTimestamp - stream.startTimestamp);
  if (duration === 0) return Math.max(0, deposited - withdrawn);

  const elapsed = Math.min(Math.max(0, nowSec - stream.startTimestamp), duration);
  const vested = (deposited * elapsed) / duration;
  return Math.max(0, vested - withdrawn);
}
