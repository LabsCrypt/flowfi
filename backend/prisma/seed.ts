import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/index.js';

const connectionString = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    console.log('Seeding database...');

    // Create example users
    const user1 = await prisma.user.upsert({
        where: { publicKey: 'GBRPYH6QC6WGLH473XI3CL4B3I754SFSULN5K3X7G3X4I6SGRH3V3U12' },
        update: {},
        create: {
            publicKey: 'GBRPYH6QC6WGLH473XI3CL4B3I754SFSULN5K3X7G3X4I6SGRH3V3U12',
        },
    });

    const user2 = await prisma.user.upsert({
        where: { publicKey: 'GDRS6N3K7DQ6GKH47O6E5K5G7B7H7I7J7K7L7M7N7O7P7Q7R7S7T7U7V' },
        update: {},
        create: {
            publicKey: 'GDRS6N3K7DQ6GKH47O6E5K5G7B7H7I7J7K7L7M7N7O7P7Q7R7S7T7U7V',
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
            tokenAddress: 'CBTM5D262F6VQY4A6E4F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X',
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
