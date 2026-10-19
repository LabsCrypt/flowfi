#!/usr/bin/env node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("FFIENC01", "ascii");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + NONCE_LENGTH;

function keyFromEnvironment() {
  const value = process.env.BACKUP_ENCRYPTION_KEY;
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("BACKUP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 bytes)");
  }
  return Buffer.from(value, "hex");
}

async function write(chunk) {
  if (!chunk?.length) return;
  if (!process.stdout.write(chunk)) {
    await new Promise((resolve, reject) => {
      process.stdout.once("drain", resolve);
      process.stdout.once("error", reject);
    });
  }
}

async function encrypt(key) {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  await write(Buffer.concat([MAGIC, nonce]));
  for await (const chunk of process.stdin) await write(cipher.update(chunk));
  await write(cipher.final());
  await write(cipher.getAuthTag());
}

async function decrypt(key) {
  let decipher;
  let header = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let initialized = false;

  for await (const chunk of process.stdin) {
    let data = chunk;
    if (!initialized) {
      const needed = HEADER_LENGTH - header.length;
      const take = Math.min(needed, data.length);
      header = Buffer.concat([header, data.subarray(0, take)]);
      data = data.subarray(take);
      if (header.length < HEADER_LENGTH) continue;
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unrecognized or unsupported backup format");
      const nonce = header.subarray(MAGIC.length);
      decipher = createDecipheriv("aes-256-gcm", key, nonce);
      initialized = true;
    }

    const combined = Buffer.concat([tail, data]);
    if (combined.length > TAG_LENGTH) {
      const ciphertext = combined.subarray(0, combined.length - TAG_LENGTH);
      tail = combined.subarray(combined.length - TAG_LENGTH);
      await write(decipher.update(ciphertext));
    } else {
      tail = combined;
    }
  }

  if (!initialized || tail.length !== TAG_LENGTH) throw new Error("Backup is truncated");
  decipher.setAuthTag(tail);
  await write(decipher.final());
}

try {
  const key = keyFromEnvironment();
  if (process.argv[2] === "encrypt") await encrypt(key);
  else if (process.argv[2] === "decrypt") await decrypt(key);
  else throw new Error("Usage: backup-crypto.mjs <encrypt|decrypt>");
} catch (error) {
  process.stderr.write(`backup-crypto: ${error.message}\n`);
  process.exitCode = 1;
}