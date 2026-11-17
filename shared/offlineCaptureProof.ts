// WebCrypto / Node-crypto compatible canonical HMAC-SHA256 proof binding an uncommitted
// offline outbox item to the authenticated shift owner AND server-signed grant window (v4).
// Zero external dependencies so both Vite SPA and Node server bundle it identically.

export const OFFLINE_GRANT_DURATION_MS = 48 * 60 * 60 * 1000;

export interface OfflineShiftCaptureGrant {
  version: 4;
  keyId: string;
  grantId: string;
  userId: number;
  branchId: number;
  shiftId: number;
  issuedAt: string;
  issuedAtServerMs: number;
  expiresAtServerMs: number;
  captureKeyHex: string;
  grantToken: string;
}

export interface OfflineCaptureProofFields {
  kind: "SALE" | "PRINT_SALE" | "RECEPTION" | "RETURN";
  keyId: string;
  grantId: string;
  grantIssuedAtMs: number;
  grantExpiresAtMs: number;
  grantToken: string;
  clientRequestId: string;
  offlineReceiptNumber: string;
  capturedAt: string;
  branchId: number;
  capturedShiftId: number;
  capturedByUserId: number;
  payload: unknown;
}

function canonicalizeJsonValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") {
    return Number.isFinite(v as number) || typeof v === "boolean"
      ? JSON.stringify(v)
      : "null";
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((el) => canonicalizeJsonValue(el)).join(",") + "]";
  }
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalizeJsonValue(rec[k]))
        .join(",") +
      "}"
    );
  }
  return "null";
}

function normalizeMoneyStr(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val);
  return n.toFixed(2);
}

function normalizeQtyStr(val: unknown): string {
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val ?? "");
  return n.toFixed(3);
}

export function normalizeSalePayloadForCaptureProof(rawPayload: unknown): unknown {
  if (!rawPayload || typeof rawPayload !== "object") return rawPayload;
  const p = rawPayload as Record<string, unknown>;
  if (!Array.isArray(p.lines) || !p.payment || typeof p.payment !== "object") {
    return rawPayload;
  }
  const pay = p.payment as Record<string, unknown>;
  const attr =
    p.attribution && typeof p.attribution === "object"
      ? (p.attribution as Record<string, unknown>)
      : null;
  return {
    customerId: p.customerId != null ? Number(p.customerId) : null,
    priceTier: typeof p.priceTier === "string" ? p.priceTier : null,
    lines: p.lines.map((rawLine) => {
      const l = (rawLine ?? {}) as Record<string, unknown>;
      return {
        variantId: Number(l.variantId),
        productUnitId: Number(l.productUnitId),
        quantity: normalizeQtyStr(l.quantity),
        unitPriceOverride: normalizeMoneyStr(l.unitPriceOverride),
        discountPercent: normalizeMoneyStr(l.discountPercent),
        discountAmount: normalizeMoneyStr(l.discountAmount),
        promotionId: l.promotionId != null ? Number(l.promotionId) : null,
        promotionDiscount: normalizeMoneyStr(l.promotionDiscount),
        cashierDiscountAmount: normalizeMoneyStr(l.cashierDiscountAmount),
      };
    }),
    invoiceDiscount: normalizeMoneyStr(p.invoiceDiscount),
    payment: {
      amount: normalizeMoneyStr(pay.amount),
      method: String(pay.method ?? ""),
    },
    cashRoundIQD: Boolean(p.cashRoundIQD),
    notes: typeof p.notes === "string" && p.notes.trim() ? p.notes.trim() : null,
    salesRepId: p.salesRepId != null ? Number(p.salesRepId) : null,
    attribution: attr
      ? {
          repId: attr.repId != null ? Number(attr.repId) : null,
          mode: typeof attr.mode === "string" ? attr.mode : null,
        }
      : null,
  };
}

export function buildGrantEnvelopeSigningString(params: {
  keyId: string;
  grantId: string;
  userId: number;
  branchId: number;
  shiftId: number;
  issuedAtServerMs: number;
  expiresAtServerMs: number;
}): string {
  return `alroya.offline.grant_token.v4|${params.keyId}|${params.grantId}|${Number(params.userId)}|${Number(params.branchId)}|${Number(params.shiftId)}|${Number(params.issuedAtServerMs)}|${Number(params.expiresAtServerMs)}`;
}

export function buildOfflineCaptureProofPreimage(
  fields: OfflineCaptureProofFields,
): string {
  const normalizedPayload =
    fields.kind === "SALE"
      ? normalizeSalePayloadForCaptureProof(fields.payload)
      : fields.payload;
  const doc = {
    v: 4,
    kind: fields.kind,
    keyId: String(fields.keyId),
    grantId: String(fields.grantId),
    grantIssuedAtMs: Number(fields.grantIssuedAtMs),
    grantExpiresAtMs: Number(fields.grantExpiresAtMs),
    grantToken: String(fields.grantToken),
    clientRequestId: String(fields.clientRequestId),
    offlineReceiptNumber: String(fields.offlineReceiptNumber),
    capturedAt: String(fields.capturedAt),
    branchId: Number(fields.branchId),
    capturedShiftId: Number(fields.capturedShiftId),
    capturedByUserId: Number(fields.capturedByUserId),
    payload: normalizedPayload,
  };
  return "alroya.offline.capture.row.v4|" + canonicalizeJsonValue(doc);
}

function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length < 32 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Invalid hex key for offline capture proof");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Pure-TypeScript FIPS 180-4 SHA-256 over UTF-8 bytes (always 64 lowercase hex chars).
 * Works identically in Node, browser with WebCrypto, and environments without `crypto.subtle`
 * (eliminating any non-cryptographic short hash fallback).
 */
export function computeSha256HexDeterministic(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLenHi = Math.floor((msg.length * 8) / 0x100000000) >>> 0;
  const bitLenLo = ((msg.length * 8) >>> 0);
  const paddedLen = (((msg.length + 9 + 63) >>> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi, false);
  dv.setUint32(paddedLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ ((~e) & g)) >>> 0;
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, h0, false);
  outDv.setUint32(4, h1, false);
  outDv.setUint32(8, h2, false);
  outDv.setUint32(12, h3, false);
  outDv.setUint32(16, h4, false);
  outDv.setUint32(20, h5, false);
  outDv.setUint32(24, h6, false);
  outDv.setUint32(28, h7, false);
  return bytesToHex(out);
}

if (
  computeSha256HexDeterministic("abc") !==
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
) {
  throw new Error("CRITICAL: FIPS 180-4 SHA-256 self-test failed");
}

export function normalizeSaleSemanticContract(rawPayload: unknown): Record<string, unknown> {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { invalidPayload: true };
  }
  const p = rawPayload as Record<string, unknown>;
  const rawLines = Array.isArray(p.lines) ? p.lines : [];
  const rawLegs =
    Array.isArray(p.payments) && p.payments.length > 0
      ? p.payments
      : p.payment && typeof p.payment === "object"
        ? [p.payment]
        : [];
  const attr =
    p.attribution && typeof p.attribution === "object"
      ? (p.attribution as Record<string, unknown>)
      : null;
  return {
    branchId: p.branchId != null ? Number(p.branchId) : null,
    customerId: p.customerId != null ? Number(p.customerId) : null,
    priceTier: typeof p.priceTier === "string" ? p.priceTier : null,
    lines: rawLines.map((rawLine) => {
      const l = (rawLine ?? {}) as Record<string, unknown>;
      return {
        variantId: Number(l.variantId),
        productUnitId: l.productUnitId != null ? Number(l.productUnitId) : null,
        quantity: normalizeQtyStr(l.quantity),
        unitPriceOverride: normalizeMoneyStr(l.unitPriceOverride),
        discountPercent: normalizeMoneyStr(l.discountPercent),
        discountAmount: normalizeMoneyStr(l.discountAmount),
        promotionId: l.promotionId != null ? Number(l.promotionId) : null,
        promotionDiscount: normalizeMoneyStr(l.promotionDiscount),
        cashierDiscountAmount: normalizeMoneyStr(l.cashierDiscountAmount),
        isGift: Boolean(l.isGift),
      };
    }),
    invoiceDiscount: normalizeMoneyStr(p.invoiceDiscount),
    paymentLegs: rawLegs.map((rawLeg) => {
      const leg = (rawLeg ?? {}) as Record<string, unknown>;
      return {
        amount: normalizeMoneyStr(leg.amount),
        method: String(leg.method ?? ""),
        reference:
          typeof leg.reference === "string" && leg.reference.trim()
            ? leg.reference.trim()
            : null,
      };
    }),
    cashRoundIQD: Boolean(p.cashRoundIQD),
    couponCode:
      typeof p.couponCode === "string" && p.couponCode.trim() ? p.couponCode.trim() : null,
    notes: typeof p.notes === "string" && p.notes.trim() ? p.notes.trim() : null,
    salesRepId: p.salesRepId != null ? Number(p.salesRepId) : null,
    attribution: attr
      ? {
          repId: attr.repId != null ? Number(attr.repId) : null,
          mode: typeof attr.mode === "string" ? attr.mode : null,
        }
      : null,
  };
}

export function computeSaleSemanticPayloadSha256(rawPayload: unknown): string {
  const canonical =
    "alroya.sale.semantic.v4|" +
    canonicalizeJsonValue(normalizeSaleSemanticContract(rawPayload));
  return computeSha256HexDeterministic(canonical);
}

export async function computeOfflineCaptureProofHex(
  captureKeyHex: string,
  fields: OfflineCaptureProofFields,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto subtle API required for offline capture proof");
  }
  const keyBytes = hexToBytes(captureKeyHex);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const preimageBytes = new TextEncoder().encode(
    buildOfflineCaptureProofPreimage(fields),
  );
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    preimageBytes as BufferSource,
  );
  return bytesToHex(new Uint8Array(sig));
}
