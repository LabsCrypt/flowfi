import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  registerUserSchema,
  STELLAR_PUBLIC_KEY_ERROR,
} from '../src/validators/user.validator.js';

const VALID_KEY = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';

describe('User Validator', () => {
  it('should accept a well-formed Stellar public key', () => {
    const result = registerUserSchema.safeParse({ publicKey: VALID_KEY });
    expect(result.success).toBe(true);
  });

  it('should reject a malformed public key with a descriptive message', () => {
    const result = registerUserSchema.safeParse({ publicKey: 'not-a-stellar-key' });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.path).toEqual(['publicKey']);
    expect(result.error?.issues[0]?.message).toBe(STELLAR_PUBLIC_KEY_ERROR);
  });

  it.each([
    ['too short', 'GD2XP6FNWL6IWULV'],
    ['too long', `${VALID_KEY}AAAA`],
    ['using a wrong version prefix', `S${VALID_KEY.slice(1)}`],
    ['lowercase', VALID_KEY.toLowerCase()],
    ['outside the base32 alphabet', `${VALID_KEY.slice(0, 55)}1`],
    ['an empty string', ''],
    ['whitespace padded', ` ${VALID_KEY} `],
  ])('should reject a key that is %s', (_label, publicKey) => {
    const result = registerUserSchema.safeParse({ publicKey });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(STELLAR_PUBLIC_KEY_ERROR);
  });

  it.each([
    ['missing', undefined],
    ['a number', 12345],
    ['null', null],
  ])('should reject a publicKey that is %s', (_label, publicKey) => {
    const result = registerUserSchema.safeParse({ publicKey });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'publicKey is required and must be a string',
    );
  });

  // `registerUser` calls `.parse`, so a malformed key throws before any Prisma
  // access. The global error middleware turns that ZodError into a 400 carrying
  // the message asserted above (see tests/error.middleware.test.ts).
  it('should throw a ZodError so the request fails before the controller body runs', () => {
    const parse = () => registerUserSchema.parse({ publicKey: 'not-a-stellar-key' });

    expect(parse).toThrow(ZodError);

    try {
      parse();
      expect.unreachable('parse should have thrown');
    } catch (error) {
      expect((error as ZodError).issues[0]?.message).toBe(STELLAR_PUBLIC_KEY_ERROR);
    }
  });
});
