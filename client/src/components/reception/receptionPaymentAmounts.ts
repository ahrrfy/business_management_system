import { D } from "@/lib/money";

/** New goods/deposit collection only. Held delivery fees are allocated separately. */
export function receptionPaymentAmounts(input: {
  paid: string;
  expectedNow: string;
  hasExplicitAmount: boolean;
  directNet: string;
  deferred: boolean;
  quickFullPay: boolean;
  isReservation: boolean;
  method: string;
}) {
  const paid = D(input.paid);
  const expected = D(input.expectedNow);
  const inputPaidD = input.isReservation
    ? paid.gt(0) ? paid : D(0)
    : input.quickFullPay || (!input.hasExplicitAmount && !input.deferred && D(input.directNet).gt(0))
      ? expected : paid;
  const appliedPaidD = input.method === "CASH" && inputPaidD.gt(expected) ? expected : inputPaidD;
  return { inputPaidD, appliedPaidD };
}
