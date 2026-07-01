import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { createPgPool } from '../src/lib/pg-pool.js';

const pool = createPgPool();
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Use stable, checksum-valid Stellar testnet/demo addresses so seeded rows
// render correctly in the frontend and resolve against TOKEN_ADDRESSES.
const DEMO_SENDER_PUBLIC_KEY = 'GCM5WPR4DDR24FSAX5LIEM4J7AI3KOWJYANSXEPKYXCSZOTAYXE75AFN';
const DEMO_RECIPIENT_PUBLIC_KEY = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3XKSOLXAUJSD56C4LHND5TWUC';
const DEMO_TOKEN_ADDRESS = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

async function main() {
    console.log('Seeding database...');

    // Create example users
    const user1 = await prisma.user.upsert({
        where: { publicKey: DEMO_SENDER_PUBLIC_KEY },
        update: {},
        create: {
            publicKey: DEMO_SENDER_PUBLIC_KEY,
        },
    });

    const user2 = await prisma.user.upsert({
        where: { publicKey: DEMO_RECIPIENT_PUBLIC_KEY },
        update: {},
        create: {
            publicKey: DEMO_RECIPIENT_PUBLIC_KEY,
        },
    });

    console.log({ user1, user2 });

    // Create an example stream
    const stream1 = await prisma.stream.upsert({
        where: { streamId: 101 },
        update: {},
        create: {
            streamId: 101,
            sender: user1.publicKey,
            recipient: user2.publicKey,
            tokenAddress: DEMO_TOKEN_ADDRESS,
            ratePerSecond: '100000000', // 10 XLM/sec if decimals=7
            depositedAmount: '1000000000000',
            withdrawnAmount: '0',
            startTime: Math.floor(Date.now() / 1000),
            lastUpdateTime: Math.floor(Date.now() / 1000),
            isActive: true,
        },
    });

    console.log({ stream1 });

    // Create an example event
    const event1 = await prisma.streamEvent.create({
        data: {
            streamId: stream1.streamId,
            eventType: 'CREATED',
            amount: '1000000000000',
            transactionHash: '6f7e8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r',
            ledgerSequence: 123456,
            timestamp: Math.floor(Date.now() / 1000),
            metadata: JSON.stringify({ memo: 'Seed data' }),
        },
    });

    console.log({ event1 });

    console.log('Seeding finished.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
