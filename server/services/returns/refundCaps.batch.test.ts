import { describe, expect, it, vi } from "vitest";
import { loadRefundCapsByInvoiceIds } from "./refundCaps";

describe("لقطات سقوف الاسترداد المجمعة", () => {
  it("تقرأ الروافد بثلاثة استعلامات ثابتة وتفصل وعاء كل فاتورة", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[
        { invoiceId: 11, rail: "CARD", direction: "IN", amount: "60.00" },
        { invoiceId: 11, rail: "CASH", direction: "OUT", amount: "10.00" },
        { invoiceId: 12, rail: "TELECOM", direction: "IN", amount: "15.00" },
      ]])
      .mockResolvedValueOnce([[
        { invoiceId: 11, rail: "TRANSFER", amount: "20.00" },
      ]])
      .mockResolvedValueOnce([[
        { invoiceId: 12, amount: "5.00" },
      ]]);

    const result = await loadRefundCapsByInvoiceIds({ execute }, [11, 12, 11]);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(2);
    expect(result.get(11)?.grossIn.toFixed(2)).toBe("80.00");
    expect(result.get(11)?.grossOut.toFixed(2)).toBe("10.00");
    expect(result.get(11)?.pool.toFixed(2)).toBe("70.00");
    expect(result.get(12)?.pool.toFixed(2)).toBe("20.00");
    expect(result.get(12)?.netByMethod.get("CASH")?.toFixed(2)).toBe("20.00");
  });
});
