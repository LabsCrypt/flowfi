/**
 * scripts/seed-mock-data.ts
 *
 * Mock seed script for the one-click local development sandbox.
 * Populates the database with:
 *   - 5 mock users (Stellar G-addresses)
 *   - 20 diverse streams (Active, Paused, Completed, Cancelled, Vesting)
 *   - Rich event histories with timestamps spanning the last 30 days
 *
 * Usage (standalone, run from repo root):
 *   npx tsx scripts/seed-mock-data.ts
 *
 * Or via the convenience script:
 *   npm run dev:mock
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../backend/src/generated/prisma/index.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Database connection (mirrors backend/prisma/seed.ts)
// ---------------------------------------------------------------------------
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://flowfi:flowfi_dev_password@localhost:5433/flowfi';

const pool = new Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as never);

// ---------------------------------------------------------------------------
// Mock users (5 distinct Stellar public keys)
// ---------------------------------------------------------------------------
const MOCK_USERS = [
  {
    id: 'user-alice',
    publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    label: 'Alice (DAO Treasury)',
  },
  {
    id: 'user-bob',
    publicKey: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGEWODO1A5BBER3S3FN7T',
    label: 'Bob (Protocol Dev)',
  },
  {
    id: 'user-carol',
    publicKey: 'GBDEVU63Y6NTHJQQZIKVTC23NWLQKP3WJ4184LPZ4L5DNXPGZKLIS4Z',
    label: 'Carol (Frontend Dev)',
  },
  {
    id: 'user-dave',
    publicKey: 'GDQERENWDDSQZS7R7WKHZI3BSOYMV3FSWR7TFUYFTKQ447PIX6NREOJM',
    label: 'Dave (Security Auditor)',
  },
  {
    id: 'user-eve',
    publicKey: 'GCVW5GBIANS67UMXPCHU2J4IOP5EDA5IKCZ4BGQNWRM6EBRXHBKGXM5',
    label: 'Eve (Investor)',
  },
];

// ---------------------------------------------------------------------------
// Mock token addresses
// ---------------------------------------------------------------------------
const TOKENS = {
  USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  EURC: 'CDTKPWPLOURQA2SGTKTU66TTPKBKNTXD72KLGY5UCJWWQAC2BGKGXM5',
  XLM: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCTP',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

/** Returns a unix timestamp N days ago */
function daysAgo(n: number): number {
  return now - n * DAY;
}

/** Generates a deterministic-looking fake tx hash */
function fakeTxHash(seed: string): string {
  const chars = '0123456789abcdef';
  let hash = '';
  let s = seed;
  for (let i = 0; i < 64; i++) {
    const code = s.charCodeAt(i % s.length) + i;
    hash += chars[code % 16];
    s = s + String(code);
  }
  return hash;
}

/** Generates a fake Soroban event ID */
function fakeEventId(streamId: number, seq: number): string {
  return `${(streamId * 1000 + seq).toString().padStart(19, '0')}-${seq.toString().padStart(10, '0')}`;
}

// ---------------------------------------------------------------------------
// Stream definitions
// ---------------------------------------------------------------------------
interface MockStream {
  streamId: number;
  senderIdx: number;
  recipientIdx: number;
  token: keyof typeof TOKENS;
  ratePerSecond: string;       // i128 as string
  depositedAmount: string;     // i128 as string
  withdrawnAmount: string;     // i128 as string
  startDaysAgo: number;
  endDaysFromStart?: number;   // undefined = open-ended
  isActive: boolean;
  isPaused: boolean;
  pausedAtDaysAgo?: number;
  label: string;
  events: Array<{
    eventType: string;
    daysAgo: number;
    amount?: string;
    note?: string;
  }>;
}

const MOCK_STREAMS: MockStream[] = [
  // ── Active streams ────────────────────────────────────────────────────────
  {
    streamId: 1001,
    senderIdx: 0, // Alice → Bob
    recipientIdx: 1,
    token: 'USDC',
    ratePerSecond: '115741',     // ~10 USDC/day (6 decimals)
    depositedAmount: '30000000000', // 30,000 USDC
    withdrawnAmount: '1200000000',
    startDaysAgo: 28,
    isActive: true,
    isPaused: false,
    label: 'DAO → Dev salary (USDC)',
    events: [
      { eventType: 'CREATED', daysAgo: 28, amount: '30000000000', note: 'Stream opened' },
      { eventType: 'TOPPED_UP', daysAgo: 20, amount: '5000000000', note: 'Top-up' },
      { eventType: 'WITHDRAWN', daysAgo: 14, amount: '700000000', note: 'Mid-month withdrawal' },
      { eventType: 'WITHDRAWN', daysAgo: 1, amount: '500000000', note: 'Recent withdrawal' },
    ],
  },
  {
    streamId: 1002,
    senderIdx: 4, // Eve → Carol
    recipientIdx: 2,
    token: 'USDC',
    ratePerSecond: '57870',      // ~5 USDC/day
    depositedAmount: '15000000000',
    withdrawnAmount: '0',
    startDaysAgo: 10,
    isActive: true,
    isPaused: false,
    label: 'Investor → Frontend grant (USDC)',
    events: [
      { eventType: 'CREATED', daysAgo: 10, amount: '15000000000' },
    ],
  },
  {
    streamId: 1003,
    senderIdx: 0, // Alice → Dave
    recipientIdx: 3,
    token: 'EURC',
    ratePerSecond: '231481',     // ~20 EURC/day
    depositedAmount: '60000000000',
    withdrawnAmount: '3000000000',
    startDaysAgo: 30,
    isActive: true,
    isPaused: false,
    label: 'DAO → Auditor retainer (EURC)',
    events: [
      { eventType: 'CREATED', daysAgo: 30, amount: '60000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 15, amount: '3000000000', note: 'Milestone payout' },
    ],
  },
  {
    streamId: 1004,
    senderIdx: 1, // Bob → Carol
    recipientIdx: 2,
    token: 'XLM',
    ratePerSecond: '1157407',    // ~100 XLM/day (7 decimals)
    depositedAmount: '30000000000',
    withdrawnAmount: '500000000',
    startDaysAgo: 5,
    isActive: true,
    isPaused: false,
    label: 'Dev → Contractor sub-grant (XLM)',
    events: [
      { eventType: 'CREATED', daysAgo: 5, amount: '30000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 2, amount: '500000000' },
    ],
  },
  {
    streamId: 1005,
    senderIdx: 4, // Eve → Alice (protocol fee stream)
    recipientIdx: 0,
    token: 'USDC',
    ratePerSecond: '11574',      // ~1 USDC/day
    depositedAmount: '3650000000', // 3650 USDC (~1 year)
    withdrawnAmount: '0',
    startDaysAgo: 3,
    isActive: true,
    isPaused: false,
    label: 'Investor → DAO protocol fee (USDC)',
    events: [
      { eventType: 'CREATED', daysAgo: 3, amount: '3650000000' },
    ],
  },
  {
    streamId: 1006,
    senderIdx: 3, // Dave → Bob
    recipientIdx: 1,
    token: 'EURC',
    ratePerSecond: '46296',      // ~4 EURC/day
    depositedAmount: '12000000000',
    withdrawnAmount: '800000000',
    startDaysAgo: 22,
    isActive: true,
    isPaused: false,
    label: 'Auditor → Dev bounty (EURC)',
    events: [
      { eventType: 'CREATED', daysAgo: 22, amount: '12000000000' },
      { eventType: 'TOPPED_UP', daysAgo: 18, amount: '2000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 10, amount: '800000000' },
    ],
  },
  {
    streamId: 1007,
    senderIdx: 2, // Carol → Eve (revenue share)
    recipientIdx: 4,
    token: 'USDC',
    ratePerSecond: '23148',      // ~2 USDC/day
    depositedAmount: '6000000000',
    withdrawnAmount: '0',
    startDaysAgo: 7,
    isActive: true,
    isPaused: false,
    label: 'Frontend → Investor rev-share (USDC)',
    events: [
      { eventType: 'CREATED', daysAgo: 7, amount: '6000000000' },
    ],
  },

  // ── Paused streams ────────────────────────────────────────────────────────
  {
    streamId: 1008,
    senderIdx: 0, // Alice → Carol
    recipientIdx: 2,
    token: 'USDC',
    ratePerSecond: '69444',      // ~6 USDC/day
    depositedAmount: '20000000000',
    withdrawnAmount: '1000000000',
    startDaysAgo: 25,
    isActive: true,
    isPaused: true,
    pausedAtDaysAgo: 3,
    label: 'DAO → Frontend grant (PAUSED)',
    events: [
      { eventType: 'CREATED', daysAgo: 25, amount: '20000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 12, amount: '1000000000' },
      { eventType: 'PAUSED', daysAgo: 3, note: 'Pending milestone review' },
    ],
  },
  {
    streamId: 1009,
    senderIdx: 4, // Eve → Dave
    recipientIdx: 3,
    token: 'EURC',
    ratePerSecond: '115741',     // ~10 EURC/day
    depositedAmount: '25000000000',
    withdrawnAmount: '2000000000',
    startDaysAgo: 20,
    isActive: true,
    isPaused: true,
    pausedAtDaysAgo: 8,
    label: 'Investor → Auditor (PAUSED)',
    events: [
      { eventType: 'CREATED', daysAgo: 20, amount: '25000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 16, amount: '2000000000' },
      { eventType: 'PAUSED', daysAgo: 8, note: 'Scope change in progress' },
    ],
  },
  {
    streamId: 1010,
    senderIdx: 1, // Bob → Eve (vesting, paused)
    recipientIdx: 4,
    token: 'XLM',
    ratePerSecond: '578703',     // ~50 XLM/day
    depositedAmount: '15000000000',
    withdrawnAmount: '0',
    startDaysAgo: 15,
    isActive: true,
    isPaused: true,
    pausedAtDaysAgo: 5,
    label: 'Dev → Investor advisor tokens (PAUSED)',
    events: [
      { eventType: 'CREATED', daysAgo: 15, amount: '15000000000' },
      { eventType: 'PAUSED', daysAgo: 5, note: 'Advisor agreement under review' },
    ],
  },

  // ── Completed streams ─────────────────────────────────────────────────────
  {
    streamId: 1011,
    senderIdx: 0, // Alice → Bob (completed)
    recipientIdx: 1,
    token: 'USDC',
    ratePerSecond: '0',
    depositedAmount: '5000000000',
    withdrawnAmount: '5000000000',
    startDaysAgo: 29,
    endDaysFromStart: 20,
    isActive: false,
    isPaused: false,
    label: 'DAO → Dev sprint #1 (COMPLETED)',
    events: [
      { eventType: 'CREATED', daysAgo: 29, amount: '5000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 22, amount: '2500000000' },
      { eventType: 'WITHDRAWN', daysAgo: 9, amount: '2500000000' },
      { eventType: 'COMPLETED', daysAgo: 9, note: 'Stream fully drained' },
    ],
  },
  {
    streamId: 1012,
    senderIdx: 4, // Eve → Carol (completed)
    recipientIdx: 2,
    token: 'EURC',
    ratePerSecond: '0',
    depositedAmount: '8000000000',
    withdrawnAmount: '8000000000',
    startDaysAgo: 30,
    endDaysFromStart: 25,
    isActive: false,
    isPaused: false,
    label: 'Investor → Frontend design sprint (COMPLETED)',
    events: [
      { eventType: 'CREATED', daysAgo: 30, amount: '8000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 20, amount: '4000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 5, amount: '4000000000' },
      { eventType: 'COMPLETED', daysAgo: 5 },
    ],
  },
  {
    streamId: 1013,
    senderIdx: 3, // Dave → Alice (bug bounty, completed)
    recipientIdx: 0,
    token: 'USDC',
    ratePerSecond: '0',
    depositedAmount: '2000000000',
    withdrawnAmount: '2000000000',
    startDaysAgo: 27,
    endDaysFromStart: 10,
    isActive: false,
    isPaused: false,
    label: 'Auditor → DAO bug-bounty (COMPLETED)',
    events: [
      { eventType: 'CREATED', daysAgo: 27, amount: '2000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 17, amount: '2000000000' },
      { eventType: 'COMPLETED', daysAgo: 17 },
    ],
  },

  // ── Cancelled streams ─────────────────────────────────────────────────────
  {
    streamId: 1014,
    senderIdx: 2, // Carol → Dave (cancelled)
    recipientIdx: 3,
    token: 'XLM',
    ratePerSecond: '0',
    depositedAmount: '10000000000',
    withdrawnAmount: '1500000000',
    startDaysAgo: 26,
    isActive: false,
    isPaused: false,
    label: 'Frontend → Auditor security review (CANCELLED)',
    events: [
      { eventType: 'CREATED', daysAgo: 26, amount: '10000000000' },
      { eventType: 'WITHDRAWN', daysAgo: 20, amount: '1500000000' },
      { eventType: 'CANCELLED', daysAgo: 18, note: 'Project scope reduced' },
    ],
  },
  {
    streamId: 1015,
    senderIdx: 1, // Bob → Alice (cancelled early)
    recipientIdx: 0,
    token: 'USDC',
    ratePerSecond: '0',
    depositedAmount: '3000000000',
    withdrawnAmount: '0',
    startDaysAgo: 21,
    isActive: false,
    isPaused: false,
    label: 'Dev → DAO refund stream (CANCELLED)',
    events: [
      { eventType: 'CREATED', daysAgo: 21, amount: '3000000000' },
      { eventType: 'CANCELLED', daysAgo: 19, note: 'Cancelled before first withdrawal' },
    ],
  },
  {
    streamId: 1016,
    senderIdx: 4, // Eve → Bob (cancelled)
    recipientIdx: 1,
    token: 'EURC',
    ratePerSecond: '0',
    depositedAmount: '7500000000',
    withdrawnAmount: '2500000000',
    startDaysAgo: 24,
    isActive: false,
    isPaused: false,
    label: 'Investor → Dev seed vesting (CANCELLED)',
    events: [
      { eventType: 'CREATED', daysAgo: 24, amount: '7500000000' },
      { eventType: 'WITHDRAWN', daysAgo: 18, amount: '2500000000' },
      { eventType: 'CANCELLED', daysAgo: 11, note: 'Vesting terms renegotiated' },
    ],
  },

  // ── Vesting cliff streams ─────────────────────────────────────────────────
  {
    streamId: 1017,
    senderIdx: 0, // Alice → Eve (vesting, cliff not reached)
    recipientIdx: 4,
    token: 'USDC',
    ratePerSecond: '34722',      // ~3 USDC/day
    depositedAmount: '100000000000', // 100,000 USDC over ~3 years
    withdrawnAmount: '0',
    startDaysAgo: 1,
    isActive: true,
    isPaused: false,
    label: 'DAO → Investor vesting (cliff: 90 days)',
    events: [
      { eventType: 'CREATED', daysAgo: 1, amount: '100000000000', note: '1-year cliff vesting stream' },
    ],
  },
  {
    streamId: 1018,
    senderIdx: 0, // Alice → Carol (vesting)
    recipientIdx: 2,
    token: 'XLM',
    ratePerSecond: '578703',     // ~50 XLM/day
    depositedAmount: '50000000000',
    withdrawnAmount: '0',
    startDaysAgo: 2,
    isActive: true,
    isPaused: false,
    label: 'DAO → Frontend vesting (cliff: 180 days)',
    events: [
      { eventType: 'CREATED', daysAgo: 2, amount: '50000000000', note: '6-month cliff vesting' },
    ],
  },
  {
    streamId: 1019,
    senderIdx: 0, // Alice → Bob (vesting, active + resumed)
    recipientIdx: 1,
    token: 'EURC',
    ratePerSecond: '231481',     // ~20 EURC/day
    depositedAmount: '80000000000',
    withdrawnAmount: '500000000',
    startDaysAgo: 18,
    isActive: true,
    isPaused: false,
    label: 'DAO → Dev 4-year token vesting',
    events: [
      { eventType: 'CREATED', daysAgo: 18, amount: '80000000000' },
      { eventType: 'PAUSED', daysAgo: 12, note: 'Paused for re-evaluation' },
      { eventType: 'RESUMED', daysAgo: 9, note: 'Resumed after board review' },
      { eventType: 'WITHDRAWN', daysAgo: 4, amount: '500000000' },
    ],
  },
  {
    streamId: 1020,
    senderIdx: 4, // Eve → Dave (vesting with top-ups)
    recipientIdx: 3,
    token: 'USDC',
    ratePerSecond: '115741',     // ~10 USDC/day
    depositedAmount: '40000000000',
    withdrawnAmount: '300000000',
    startDaysAgo: 16,
    isActive: true,
    isPaused: false,
    label: 'Investor → Auditor long-term vesting',
    events: [
      { eventType: 'CREATED', daysAgo: 16, amount: '35000000000' },
      { eventType: 'TOPPED_UP', daysAgo: 8, amount: '5000000000', note: 'Additional vesting tranche' },
      { eventType: 'WITHDRAWN', daysAgo: 3, amount: '300000000' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeding logic
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('\n🌱  FlowFi mock seed — starting\n');

  // ── Users ──────────────────────────────────────────────────────────────────
  console.log('  → Seeding 5 mock users…');
  const createdUsers: Array<{ publicKey: string }> = [];

  for (const u of MOCK_USERS) {
    const user = await prisma.user.upsert({
      where: { publicKey: u.publicKey },
      update: {},
      create: { publicKey: u.publicKey },
    });
    createdUsers.push(user);
    console.log(`     ✓ ${u.label} (${u.publicKey.slice(0, 10)}…)`);
  }

  // ── Streams + Events ───────────────────────────────────────────────────────
  console.log('\n  → Seeding 20 mock streams with event histories…\n');

  for (const s of MOCK_STREAMS) {
    const sender = MOCK_USERS[s.senderIdx]!.publicKey;
    const recipient = MOCK_USERS[s.recipientIdx]!.publicKey;
    const tokenAddress = TOKENS[s.token];
    const startTime = daysAgo(s.startDaysAgo);
    const endTime = s.endDaysFromStart
      ? startTime + s.endDaysFromStart * DAY
      : null;
    const pausedAt = s.pausedAtDaysAgo ? daysAgo(s.pausedAtDaysAgo) : null;

    const stream = await prisma.stream.upsert({
      where: { streamId: s.streamId },
      update: {
        withdrawnAmount: s.withdrawnAmount,
        lastUpdateTime: now,
        isActive: s.isActive,
        isPaused: s.isPaused,
        pausedAt: pausedAt ?? undefined,
      },
      create: {
        streamId: s.streamId,
        sender,
        recipient,
        tokenAddress,
        ratePerSecond: s.ratePerSecond,
        depositedAmount: s.depositedAmount,
        withdrawnAmount: s.withdrawnAmount,
        startTime,
        lastUpdateTime: now,
        endTime: endTime ?? undefined,
        isActive: s.isActive,
        isPaused: s.isPaused,
        pausedAt: pausedAt ?? undefined,
        totalPausedDuration: 0,
      },
    });

    console.log(`     ✓ Stream #${s.streamId} — ${s.label}`);

    // Seed events for this stream
    for (let i = 0; i < s.events.length; i++) {
      const ev = s.events[i]!;
      const txHash = fakeTxHash(`stream-${s.streamId}-event-${i}-${ev.eventType}`);
      const timestamp = daysAgo(ev.daysAgo);
      const ledger = 5000000 + s.streamId * 100 + i;

      await prisma.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: txHash,
            eventType: ev.eventType,
          },
        },
        update: {},
        create: {
          streamId: stream.streamId,
          eventType: ev.eventType,
          amount: ev.amount ?? null,
          transactionHash: txHash,
          ledgerSequence: ledger,
          timestamp,
          metadata: ev.note ? JSON.stringify({ note: ev.note }) : null,
        },
      });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const streamCount = await prisma.stream.count();
  const eventCount = await prisma.streamEvent.count();
  const userCount = await prisma.user.count();

  console.log('\n  ✅  Mock seed complete!\n');
  console.log(`     Users:        ${userCount}`);
  console.log(`     Streams:      ${streamCount}`);
  console.log(`     Events:       ${eventCount}`);
  console.log('\n     Distribution:');
  console.log('       Active    — 7 streams');
  console.log('       Paused    — 3 streams');
  console.log('       Completed — 3 streams');
  console.log('       Cancelled — 3 streams');
  console.log('       Vesting   — 4 streams');
  console.log('\n  🚀  Backend: http://localhost:3001');
  console.log('  🖥️   Frontend: http://localhost:3000\n');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
