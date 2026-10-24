import { describe, expect, it } from "vitest";
import {
  tenderFingerprint,
  tenderProblem,
  tenderTotals,
  tenderAmount,
  remainingTenderPart,
  type TenderPart,
} from "./splitTender";
const part = (
  id: string,
  method: TenderPart["method"],
  amount: string,
  reference = "",
): TenderPart => ({ id, method, amount, reference, proof: null });
const confirmed = (
  id: string,
  amount: string,
  reference: string,
  attemptId = 11,
) => {
  const row = part(id, "CARD", amount, reference);
  row.proof = {
    attemptId,
    deviceId: "device",
    requestId: id,
    fingerprint: tenderFingerprint(2, "RECEPTION", row),
    confirmed: true,
  };
  return row;
};
describe("split tender arithmetic and independent proofs", () => {
  it("keeps cash change out of card allocations", () => {
    const rows = [
      part("cash", "CASH", "70"),
      confirmed("card", "50", "000123"),
    ];
    const totals = tenderTotals(rows, "100");
    expect(totals.tendered.toFixed(2)).toBe("120.00");
    expect(totals.applied.toFixed(2)).toBe("100.00");
    expect(totals.change.toFixed(2)).toBe("20.00");
    expect(totals.nonCash.toFixed(2)).toBe("50.00");
    expect(tenderProblem(rows, "100", 2, "RECEPTION")).toBeNull();
  });
  it("rejects noncash overpayment, including mixed cash/card", () => {
    expect(
      tenderProblem(
        [part("cash", "CASH", "1"), confirmed("card", "101", "ref")],
        "100",
        2,
        "RECEPTION",
      ),
    ).toContain("غير النقدية");
  });
  it("does not reuse one confirmed card transaction for two legs", () => {
    expect(
      tenderProblem(
        [confirmed("one", "20", "A"), confirmed("two", "30", "B")],
        "100",
        2,
        "RECEPTION",
      ),
    ).toContain("مستقلة");
  });
  it("invalidates proof when amount, branch or channel changes", () => {
    const row = confirmed("card", "50", "A");
    expect(
      tenderProblem([{ ...row, amount: "60" }], "100", 2, "RECEPTION"),
    ).toContain("أكّد");
    expect(tenderProblem([row], "100", 3, "RECEPTION")).toContain("أكّد");
    expect(tenderProblem([row], "100", 2, "POS")).toContain("أكّد");
  });
  it("preserves a confirmed reference when only its surrounding spaces or case change", () => {
    const row = confirmed("card", "50", "ab12");
    expect(
      tenderProblem([{ ...row, reference: " AB12 " }], "100", 2, "RECEPTION"),
    ).toBeNull();
  });
  it.each([".", "-1", "NaN", "Infinity", "invalid"])(
    "treats incomplete or invalid input %s as unready without crashing",
    (value) => {
      expect(tenderAmount(value).toFixed(2)).toBe("0.00");
      expect(
        tenderProblem([part("cash", "CASH", value)], "100", 2, "RECEPTION"),
      ).toContain("موجباً");
    },
  );
  it("fills only the remaining share, even while another amount is incomplete", () => {
    expect(
      remainingTenderPart(
        [part("cash", "CASH", "120"), part("card", "CARD", "70")],
        "100",
        "cash",
      ),
    ).toBe("30.00");
    expect(
      remainingTenderPart(
        [part("cash", "CASH", "."), part("card", "CARD", "40")],
        "100",
        "cash",
      ),
    ).toBe("60.00");
  });
});
