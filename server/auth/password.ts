import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

// Stored hashes are database input. Validate their cost before handing it to
// scrypt so a corrupt or tampered row cannot exhaust the worker pool or memory.
const STORED_HASH_MAX_LENGTH = 512;
const SCRYPT_LIMITS = {
  minN: 1 << 10,
  maxN: 1 << 15,
  maxR: 32,
  maxP: 16,
  minKeylen: 16,
  maxKeylen: 128,
  minSaltBytes: 8,
  maxSaltBytes: 64,
  maxWork: 1 << 19,
  maxMemory: SCRYPT_OPTIONS.maxmem / 2,
} as const;

type ScryptParams = { N: number; r: number; p: number; keylen: number };

function deriveKey(plain: string, salt: string, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_OPTIONS.maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function parseStoredInteger(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isValidHex(value: string, minBytes: number, maxBytes: number): boolean {
  return (
    value.length >= minBytes * 2 &&
    value.length <= maxBytes * 2 &&
    value.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value)
  );
}

function areSafeScryptParams({ N, r, p, keylen }: ScryptParams): boolean {
  if (![N, r, p, keylen].every(Number.isSafeInteger)) return false;
  if (N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > SCRYPT_LIMITS.maxR || p < 1 || p > SCRYPT_LIMITS.maxP) return false;
  if (keylen < SCRYPT_LIMITS.minKeylen || keylen > SCRYPT_LIMITS.maxKeylen) return false;

  const memoryCost = 128 * N * r;
  const workCost = N * r * p;
  return memoryCost <= SCRYPT_LIMITS.maxMemory && workCost <= SCRYPT_LIMITS.maxWork;
}

/**
 * Password hashing using Node's built-in asynchronous scrypt (no external dependency).
 * Stored format: "<N>:<r>:<p>:<keylen>:<saltHex>:<hashHex>". Keeping the
 * parameters in each row permits future upgrades without breaking old hashes.
 * The legacy "<saltHex>:<hashHex>" format remains verifiable with current params.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const { N, r, p } = SCRYPT_OPTIONS;
  const hash = await deriveKey(plain, salt, { N, r, p, keylen: SCRYPT_KEYLEN });
  return `${N}:${r}:${p}:${SCRYPT_KEYLEN}:${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored || stored.length > STORED_HASH_MAX_LENGTH) return false;
  const parts = stored.split(":");

  let salt: string;
  let hash: string;
  let params: ScryptParams;
  if (parts.length === 6) {
    const N = parseStoredInteger(parts[0]);
    const r = parseStoredInteger(parts[1]);
    const p = parseStoredInteger(parts[2]);
    const keylen = parseStoredInteger(parts[3]);
    if (N === null || r === null || p === null || keylen === null) return false;
    params = { N, r, p, keylen };
    salt = parts[4];
    hash = parts[5];
  } else if (parts.length === 2) {
    // Legacy rows did not persist their scrypt parameters.
    [salt, hash] = parts;
    const { N, r, p } = SCRYPT_OPTIONS;
    params = { N, r, p, keylen: SCRYPT_KEYLEN };
  } else {
    return false;
  }

  if (!areSafeScryptParams(params)) return false;
  if (!isValidHex(salt, SCRYPT_LIMITS.minSaltBytes, SCRYPT_LIMITS.maxSaltBytes)) return false;
  if (!isValidHex(hash, params.keylen, params.keylen)) return false;

  try {
    const hashBuf = Buffer.from(hash, "hex");
    const testBuf = await deriveKey(plain, salt, params);
    return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
  } catch {
    // Malformed or unsupported stored parameters are authentication failures,
    // never server errors.
    return false;
  }
}

/**
 * Fixed, non-secret dummy hash for equal-cost checks when an account is absent.
 * It avoids synchronous crypto during module loading while retaining full scrypt work.
 */
export const DUMMY_STORED =
  "16384:8:1:64:4d9f8b3c7a2610e5d4c8b7a6123f90ee:85a34ec349055eab8f8b9a602e09d533ee6897d6f631274c0394d7efb3f400e6e6e20077b070ecf42f8f16e7b80644881cf78067cced87d97a7ec240803bc128";
