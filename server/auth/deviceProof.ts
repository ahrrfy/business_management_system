import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export const NATIVE_CLIENT_ID = "android-native";
export const NATIVE_CLIENT_VERSION = "2";
export const NATIVE_PROOF_VERSION = "1";
export const NATIVE_CHALLENGE_TTL_MS = 90_000;
export const NATIVE_REQUEST_CLOCK_SKEW_MS = 60_000;

const CHALLENGE_ISSUER = "alrueya-auth";
const CHALLENGE_AUDIENCE = "alrueya-native-device";
const SESSION_MARKER_PREFIX = "AlrueyaNativeProof/1;counter=";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type RequestLike = Pick<Request, "method" | "originalUrl" | "url" | "body"> & {
  headers?: Record<string, unknown>;
};

export type NativeDeviceChallenge = {
  ticket: string;
  expiresAt: number;
};

export type NativeDeviceRegistration = {
  keyThumbprint: string;
  sessionMarker: string;
};

export class NativeDeviceProofError extends Error {
  constructor(message = "Native device proof is invalid") {
    super(message);
    this.name = "NativeDeviceProofError";
  }
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for native device proof");
  return new TextEncoder().encode(secret);
}

function header(req: { headers?: Record<string, unknown> } | null | undefined, name: string): string {
  const value = req?.headers?.[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function boundedHeader(
  req: { headers?: Record<string, unknown> },
  name: string,
  maxLength: number,
): string {
  const value = header(req, name);
  if (!value || value.length > maxLength || /[\r\n]/.test(value)) throw new NativeDeviceProofError();
  return value;
}

export function isNativeClientRequest(req: { headers?: Record<string, unknown> } | null | undefined): boolean {
  return header(req, "x-alrueya-client") === NATIVE_CLIENT_ID;
}

export function isCurrentNativeClient(req: { headers?: Record<string, unknown> } | null | undefined): boolean {
  return isNativeClientRequest(req) &&
    header(req, "x-alrueya-client-version") === NATIVE_CLIENT_VERSION &&
    header(req, "x-alrueya-device-proof-version") === NATIVE_PROOF_VERSION;
}

function sha256Base64Url(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function parseP256PublicKey(encoded: string): { key: KeyObject; der: Buffer; thumbprint: string } {
  if (encoded.length > 512 || !BASE64URL_PATTERN.test(encoded)) throw new NativeDeviceProofError();
  let der: Buffer;
  try {
    der = Buffer.from(encoded, "base64url");
  } catch {
    throw new NativeDeviceProofError();
  }
  if (der.length < 80 || der.length > 160) throw new NativeDeviceProofError();

  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new NativeDeviceProofError();
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) {
    throw new NativeDeviceProofError();
  }
  return { key, der, thumbprint: sha256Base64Url(der) };
}

function decodeSignature(encoded: string): Buffer {
  if (encoded.length > 160 || !BASE64URL_PATTERN.test(encoded)) throw new NativeDeviceProofError();
  const signature = Buffer.from(encoded, "base64url");
  if (signature.length < 64 || signature.length > 80) throw new NativeDeviceProofError();
  return signature;
}

export function buildNativeRegistrationMessage(ticket: string, keyThumbprint: string): string {
  return [
    "ALRUEYA-NATIVE-REGISTER",
    NATIVE_PROOF_VERSION,
    sha256Base64Url(ticket),
    keyThumbprint,
  ].join("\n");
}

export async function issueNativeDeviceChallenge(nowMs = Date.now()): Promise<NativeDeviceChallenge> {
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = Math.floor((nowMs + NATIVE_CHALLENGE_TTL_MS) / 1000);
  const ticket = await new SignJWT({
    purpose: "native-device-register",
    version: NATIVE_PROOF_VERSION,
    nonce: randomBytes(32).toString("base64url"),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(CHALLENGE_ISSUER)
    .setAudience(CHALLENGE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(randomBytes(16).toString("base64url"))
    .sign(getSecret());
  return { ticket, expiresAt };
}

async function verifyChallenge(ticket: string, nowMs: number): Promise<void> {
  try {
    const { payload } = await jwtVerify(ticket, getSecret(), {
      algorithms: ["HS256"],
      issuer: CHALLENGE_ISSUER,
      audience: CHALLENGE_AUDIENCE,
      currentDate: new Date(nowMs),
      clockTolerance: 5,
    });
    if (payload.purpose !== "native-device-register" || payload.version !== NATIVE_PROOF_VERSION) {
      throw new NativeDeviceProofError();
    }
    if (typeof payload.nonce !== "string" || payload.nonce.length < 32 || !BASE64URL_PATTERN.test(payload.nonce)) {
      throw new NativeDeviceProofError();
    }
  } catch (error) {
    if (error instanceof NativeDeviceProofError) throw error;
    throw new NativeDeviceProofError();
  }
}

/** Verify possession of an EC P-256 private key only after the primary credentials succeeded. */
export async function verifyNativeDeviceRegistration(
  req: { headers?: Record<string, unknown> },
  nowMs = Date.now(),
): Promise<NativeDeviceRegistration | null> {
  if (!isNativeClientRequest(req)) return null;
  if (!isCurrentNativeClient(req)) throw new NativeDeviceProofError();

  const publicKey = boundedHeader(req, "x-alrueya-device-key", 512);
  const ticket = boundedHeader(req, "x-alrueya-device-challenge", 4096);
  const signature = decodeSignature(boundedHeader(req, "x-alrueya-device-signature", 160));
  await verifyChallenge(ticket, nowMs);
  const parsed = parseP256PublicKey(publicKey);
  const message = buildNativeRegistrationMessage(ticket, parsed.thumbprint);
  if (!verifySignature("sha256", Buffer.from(message, "utf8"), parsed.key, signature)) {
    throw new NativeDeviceProofError();
  }
  return { keyThumbprint: parsed.thumbprint, sessionMarker: createNativeSessionMarker(0) };
}

export function createNativeSessionMarker(counter: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new NativeDeviceProofError();
  return `${SESSION_MARKER_PREFIX}${counter}`;
}

export function parseNativeSessionMarker(marker: string | null | undefined): number | null {
  if (!marker?.startsWith(SESSION_MARKER_PREFIX)) return null;
  const raw = marker.slice(SESSION_MARKER_PREFIX.length);
  if (!/^\d{1,16}$/.test(raw)) return null;
  const counter = Number(raw);
  return Number.isSafeInteger(counter) && counter >= 0 ? counter : null;
}

export function nativeSessionDisplayName(marker: string | null | undefined): string | null {
  return parseNativeSessionMarker(marker) == null ? null : "Alrueya Android";
}

function bodyText(req: RequestLike): string {
  if (req.method?.toUpperCase() === "GET" || req.method?.toUpperCase() === "HEAD") return "";
  if (req.body == null) return "";
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return JSON.stringify(req.body);
}

export function buildNativeRequestMessage(input: {
  timestamp: number;
  counter: number;
  nonce: string;
  sessionToken: string;
  method: string;
  target: string;
  body: string;
}): string {
  return [
    "ALRUEYA-NATIVE-REQUEST",
    NATIVE_PROOF_VERSION,
    String(input.timestamp),
    String(input.counter),
    input.nonce,
    sha256Base64Url(input.sessionToken),
    input.method.toUpperCase(),
    input.target,
    sha256Base64Url(input.body),
  ].join("\n");
}

/**
 * Verify a signed request and return the marker to persist atomically. For state-changing requests
 * the caller must update the session row with `WHERE userAgent = currentMarker`; that
 * compare-and-swap is the replay barrier. Read-only requests need signature verification only.
 */
export function verifyNativeRequestProof(input: {
  req: RequestLike;
  sessionToken: string;
  expectedKeyThumbprint: string;
  currentMarker: string | null | undefined;
  nowMs?: number;
}): { counter: number; nextMarker: string } {
  const { req } = input;
  if (!isCurrentNativeClient(req)) throw new NativeDeviceProofError();
  const currentCounter = parseNativeSessionMarker(input.currentMarker);
  if (currentCounter == null) throw new NativeDeviceProofError();

  const timestampRaw = boundedHeader(req, "x-alrueya-device-timestamp", 16);
  const counterRaw = boundedHeader(req, "x-alrueya-device-counter", 16);
  const nonce = boundedHeader(req, "x-alrueya-device-nonce", 64);
  if (!/^\d{13,16}$/.test(timestampRaw) || !/^\d{1,16}$/.test(counterRaw)) {
    throw new NativeDeviceProofError();
  }
  if (nonce.length < 22 || !BASE64URL_PATTERN.test(nonce)) throw new NativeDeviceProofError();
  const timestamp = Number(timestampRaw);
  const counter = Number(counterRaw);
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(counter) || counter <= currentCounter) {
    throw new NativeDeviceProofError();
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestamp) > NATIVE_REQUEST_CLOCK_SKEW_MS) throw new NativeDeviceProofError();

  const publicKey = parseP256PublicKey(boundedHeader(req, "x-alrueya-device-key", 512));
  if (publicKey.thumbprint !== input.expectedKeyThumbprint) throw new NativeDeviceProofError();
  const signature = decodeSignature(boundedHeader(req, "x-alrueya-device-signature", 160));
  const target = req.originalUrl || req.url || "";
  if (!target.startsWith("/api/trpc/") || target.includes("\r") || target.includes("\n")) {
    throw new NativeDeviceProofError();
  }
  const message = buildNativeRequestMessage({
    timestamp,
    counter,
    nonce,
    sessionToken: input.sessionToken,
    method: req.method || "",
    target,
    body: bodyText(req),
  });
  if (!verifySignature("sha256", Buffer.from(message, "utf8"), publicKey.key, signature)) {
    throw new NativeDeviceProofError();
  }
  return { counter, nextMarker: createNativeSessionMarker(counter) };
}

/** A protected request was already verified, so its public-key header can be inherited safely. */
export function verifiedNativeKeyThumbprint(req: { headers?: Record<string, unknown> }): string | null {
  if (!isCurrentNativeClient(req)) return null;
  return parseP256PublicKey(boundedHeader(req, "x-alrueya-device-key", 512)).thumbprint;
}
