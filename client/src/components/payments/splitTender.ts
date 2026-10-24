import { D, round2 } from "@/lib/money";
import { isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

export type TenderMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";
export type TenderProof = {
  attemptId: number | null;
  requestId: string;
  deviceId: string;
  fingerprint: string;
  confirmed: boolean;
};
export type TenderPart = {
  id: string;
  method: TenderMethod;
  amount: string;
  reference: string;
  proof: TenderProof | null;
};
export type TenderPayment = {
  method: TenderMethod;
  amount: string;
  externalPaymentAttemptId?: number;
  externalPaymentDeviceId?: string;
};

export function tenderAmount(value: string) {
  try {
    const amount = D(value || 0);
    return amount.isFinite() && amount.gte(0) ? round2(amount) : D(0);
  } catch {
    return D(0);
  }
}
export function tenderFingerprint(
  branchId: number,
  channel: "POS" | "RECEPTION",
  part: Pick<TenderPart, "method" | "amount" | "reference">,
) {
  return `${channel}|${branchId}|${part.method}|${tenderAmount(part.amount).toFixed(2)}|${part.reference.trim().toUpperCase()}`;
}
export function tenderTotals(parts: TenderPart[], due: string) {
  const tendered = parts.reduce(
    (sum, part) => sum.plus(tenderAmount(part.amount)),
    D(0),
  );
  const nonCash = parts
    .filter((p) => p.method !== "CASH")
    .reduce((sum, p) => sum.plus(tenderAmount(p.amount)), D(0));
  const expected = tenderAmount(due);
  return {
    tendered,
    nonCash,
    applied: tendered.gt(expected) ? expected : tendered,
    change: tendered.gt(expected) ? tendered.minus(expected) : D(0),
    remaining: expected.gt(tendered) ? expected.minus(tendered) : D(0),
  };
}
export function remainingTenderPart(
  parts: TenderPart[],
  due: string,
  id: string,
) {
  const others = parts
    .filter((p) => p.id !== id)
    .reduce((sum, p) => sum.plus(tenderAmount(p.amount)), D(0));
  const remaining = tenderAmount(due).minus(others);
  return remaining.gt(0) ? remaining.toFixed(2) : "0.00";
}
export function tenderProblem(
  parts: TenderPart[],
  due: string,
  branchId: number,
  channel: "POS" | "RECEPTION",
): string | null {
  if (!parts.length) return null;
  if (parts.length > 10) return "الحد الأقصى عشر دفعات للفاتورة.";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!isPosPaymentMethodEnabled(part.method))
      return "طريقة الدفع غير متاحة حالياً.";
    if (!tenderAmount(part.amount).gt(0))
      return `أدخل مبلغاً موجباً للدفعة ${index + 1}.`;
    if (
      part.method !== "CASH" &&
      (!part.reference.trim() ||
        !part.proof?.confirmed ||
        !Number.isInteger(part.proof.attemptId) ||
        (part.proof.attemptId ?? 0) <= 0 ||
        part.proof.fingerprint !== tenderFingerprint(branchId, channel, part))
    )
      return `أكّد نجاح الدفعة ${index + 1} بالمرجع والمبلغ الحاليين.`;
  }
  const total = tenderTotals(parts, due);
  const attempts = parts
    .filter((p) => p.method !== "CASH")
    .map((p) => p.proof!.attemptId);
  if (new Set(attempts).size !== attempts.length)
    return "كل دفعة غير نقدية تحتاج عملية مؤكدة مستقلة؛ لا تكرر العملية نفسها في دفعتين.";
  if (total.nonCash.gt(tenderAmount(due)))
    return "الدفعات غير النقدية تتجاوز المستحق؛ الفكة تخرج من النقد فقط.";
  return null;
}
export function tenderPayments(parts: TenderPart[]): TenderPayment[] {
  return parts.map((part) => ({
    method: part.method,
    amount: tenderAmount(part.amount).toFixed(2),
    ...(part.method !== "CASH"
      ? {
          externalPaymentAttemptId: part.proof?.attemptId ?? undefined,
          externalPaymentDeviceId: part.proof?.deviceId,
        }
      : {}),
  }));
}
