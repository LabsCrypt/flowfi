import { Prisma } from '../generated/prisma/index.js';
import prisma from '../lib/prisma.js';

// ---------------------------------------------------------------------------
// Return type – never expose the hashed password to callers
// ---------------------------------------------------------------------------
export type SafeUser = {
    id: string;
    email: string | null;
    name: string | null;
    publicKey: string;
    createdAt: Date;
    updatedAt: Date;
};

/** Fields that callers are allowed to pass when creating a user. */
export type CreateUserData = {
    email: string;
    hashedPassword: string;
    name?: string;
    /** Stellar public key – required by the existing schema */
    publicKey: string;
};

/** Fields that callers are allowed to pass when updating a user. */
export type UpdateUserData = {
    email?: string;
    name?: string;
};

// Prisma `select` clause that omits the `hashedPassword` column.
const SAFE_SELECT = {
    id: true,
    email: true,
    name: true,
    publicKey: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.UserSelect;

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------
/**
 * Fetch a user by their primary-key UUID.
 *
 * @returns The user (without `hashedPassword`) or `null` when not found.
 */
export async function getById(id: string): Promise<SafeUser | null> {
    try {
        const user = await prisma.user.findUnique({
            where: { id },
            select: SAFE_SELECT,
        }) as SafeUser | null;
        return user;
    } catch (err: any) {
        if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2023'
        ) {
            // Malformed UUID – treat as "not found" rather than an internal error.
            return null;
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
/**
 * Persist a new user record.
 *
 * @throws `Prisma.PrismaClientKnownRequestError` (code P2002) when the email
 *   or publicKey is already taken – callers / error middleware can map this
 *   to a 409 response.
 * @returns The newly-created user (without `hashedPassword`).
 */
export async function create(data: CreateUserData): Promise<SafeUser> {
    const user = await prisma.user.create({
        data: {
            email: data.email,
            hashedPassword: data.hashedPassword,
            name: data.name ?? null,
            publicKey: data.publicKey,
        },
        select: SAFE_SELECT,
    }) as SafeUser;
    return user;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------
/**
 * Update mutable profile fields for the given user.
 *
 * @throws `Prisma.PrismaClientKnownRequestError` (code P2025) when no record
 *   with that `id` exists – callers / error middleware can map this to a 404.
 * @returns The updated user (without `hashedPassword`).
 */
export async function update(
    id: string,
    data: UpdateUserData
): Promise<SafeUser> {
    const user = await prisma.user.update({
        where: { id },
        data: {
            ...(data.email !== undefined && { email: data.email }),
            ...(data.name !== undefined && { name: data.name }),
        },
        select: SAFE_SELECT,
    });
    return user;
}
