import type { OfflineShiftCaptureGrant } from "@shared/offlineCaptureProof";

export interface PersistedShiftGrantPlaintextV4 {
  __shiftGrantV4: 1;
  grant: OfflineShiftCaptureGrant;
  savedAtClientMs: number;
  expiresAtClientMs: number;
}

export interface SerializedMetaCipherV4 {
  __metaCipherV4: 1;
  userId: number;
  branchId: number;
  shiftId: number;
  ivHex: string;
  dataHex: string;
}

export function buildShiftGrantAad(
  userId: number,
  branchId: number,
  shiftId: number,
): Uint8Array {
  return new TextEncoder().encode(
    `alroya.shift_grant.v4|${Number(userId)}|${Number(branchId)}|${Number(shiftId)}`,
  );
}

export function buildPreflightIntentAad(
  clientRequestId: string,
  capturedByUserId: number,
  branchId: number,
): Uint8Array {
  return new TextEncoder().encode(
    `alroya.preflight_intent.v4|${clientRequestId}|${Number(capturedByUserId)}|${Number(branchId)}`,
  );
}

export function buildOutboxItemAad(params: {
  clientRequestId: string;
  kind: string;
  capturedByUserId: number;
  branchId: number;
  capturedShiftId: number | null;
}): Uint8Array {
  return new TextEncoder().encode(
    `alroya.outbox_item.v4|${params.clientRequestId}|${params.kind}|${Number(params.capturedByUserId)}|${Number(params.branchId)}|${params.capturedShiftId ?? 0}`,
  );
}

export function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytesLocal(hex: string): Uint8Array | null {
  if (
    typeof hex !== "string" ||
    hex.length === 0 ||
    hex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(hex)
  ) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isValidShiftCaptureGrant(
  grant: OfflineShiftCaptureGrant | null | undefined,
): grant is OfflineShiftCaptureGrant {
  if (!grant || grant.version !== 4) return false;
  if (!Number.isSafeInteger(grant.userId) || grant.userId <= 0) return false;
  if (!Number.isSafeInteger(grant.branchId) || grant.branchId <= 0)
    return false;
  if (!Number.isSafeInteger(grant.shiftId) || grant.shiftId <= 0) return false;
  if (typeof grant.keyId !== "string" || !/^[a-zA-Z0-9_-]{1,24}$/.test(grant.keyId))
    return false;
  if (typeof grant.grantId !== "string" || !/^[0-9a-f]{16,64}$/i.test(grant.grantId))
    return false;
  if (
    !Number.isSafeInteger(grant.issuedAtServerMs) ||
    !Number.isSafeInteger(grant.expiresAtServerMs)
  )
    return false;
  if (grant.expiresAtServerMs <= grant.issuedAtServerMs) return false;
  if (
    typeof grant.captureKeyHex !== "string" ||
    !/^[0-9a-f]{64}$/i.test(grant.captureKeyHex)
  )
    return false;
  if (
    typeof grant.grantToken !== "string" ||
    !/^[0-9a-f]{64}$/i.test(grant.grantToken)
  )
    return false;
  return true;
}
