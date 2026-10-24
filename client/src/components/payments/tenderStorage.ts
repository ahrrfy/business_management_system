import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";
import type { TenderPart, TenderProof } from "./splitTender";
export function readTenderParts(key: string): TenderPart[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) &&
      value.length <= 10 &&
      value.every(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.amount === "string" &&
          typeof p.reference === "string" &&
          isPosPaymentMethodEnabled(p.method),
      )
      ? value
      : [];
  } catch {
    return [];
  }
}
export function readTenderProof(key: string): TenderProof | null {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "null");
    return p &&
      Number.isInteger(p.attemptId) &&
      p.attemptId > 0 &&
      typeof p.deviceId === "string" &&
      typeof p.requestId === "string" &&
      typeof p.fingerprint === "string" &&
      typeof p.confirmed === "boolean"
      ? p
      : null;
  } catch {
    return null;
  }
}
export function storeTender(key: string, value: unknown) {
  try {
    if (value == null || (Array.isArray(value) && value.length === 0))
      localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The live draft still works if browser storage is unavailable. */
  }
}
