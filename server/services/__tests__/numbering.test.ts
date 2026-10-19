import { describe, expect, it } from "vitest";
import { withTx } from "../tx";
import {
  formatDocumentNumber,
  nextCounterValue,
  nextInvoiceNumber,
  nextTransactionTrackingNumber,
} from "../numbering";

describe("Core Numbering & Atomic Counter (Milestone 1)", () => {
  it("nextTransactionTrackingNumber يبدأ من أرضية 100000 ويعطي 100001 وما يليها بتسلسل ذري", async () => {
    const num1 = await withTx(async (tx) => nextTransactionTrackingNumber(tx));
    const num2 = await withTx(async (tx) => nextTransactionTrackingNumber(tx));

    expect(Number(num1)).toBeGreaterThanOrEqual(100001);
    expect(Number(num2)).toBe(Number(num1) + 1);
  });

  it("formatDocumentNumber ينسق الرقم للمستندات المفردة والشقيقة", () => {
    expect(formatDocumentNumber("100001")).toBe("100001");
    expect(formatDocumentNumber("100001", 0)).toBe("100001");
    expect(formatDocumentNumber("100001", 1)).toBe("100001-1");
    expect(formatDocumentNumber("100001", 2)).toBe("100001-2");
  });

  it("حجز الأرقام المتزامن (Promise.all) لا يُنتج أي تصادم أو تكرار للأرقام", async () => {
    const results = await Promise.all([
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
    ]);

    const unique = new Set(results);
    expect(unique.size).toBe(5);
  });

  it("nextCounterValue يحترم أرضيات العدّادات المختلفة (invoice, workOrder, online_order)", async () => {
    const inv = await withTx(async (tx) => nextInvoiceNumber(tx, 1));
    expect(Number(inv)).toBeGreaterThanOrEqual(10001);

    const ord = await withTx(async (tx) => nextCounterValue(tx, "online_order"));
    expect(Number(ord)).toBeGreaterThanOrEqual(100001);
  });
});
