import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nonNegMoneyString, percentString } from "../../lib/schemas";
import { computeInvoiceTotals } from "../billing";
import { TRPCError } from "@trpc/server";

describe("VULN-GRD-02: Money Schema & Decimal Validation", () => {
  describe("Zod API Contract Validation", () => {
    const saleCreateSchema = z.object({
      invoiceDiscount: nonNegMoneyString.optional(),
      taxRatePercent: percentString.optional(),
    });

    it("rejects non-numeric string for invoiceDiscount with 400 validation error", () => {
      const res = saleCreateSchema.safeParse({ invoiceDiscount: "abc" });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain("مبلغ غير صالح");
      }
    });

    it("rejects negative string for invoiceDiscount", () => {
      const res = saleCreateSchema.safeParse({ invoiceDiscount: "-50.00" });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain("مبلغ غير صالح");
      }
    });

    it("rejects invoiceDiscount with more than 2 decimal places", () => {
      const res = saleCreateSchema.safeParse({ invoiceDiscount: "10.555" });
      expect(res.success).toBe(false);
    });

    it("accepts valid invoiceDiscount strings and undefined", () => {
      expect(saleCreateSchema.safeParse({ invoiceDiscount: "10.50" }).success).toBe(true);
      expect(saleCreateSchema.safeParse({ invoiceDiscount: "0" }).success).toBe(true);
      expect(saleCreateSchema.safeParse({}).success).toBe(true);
    });

    it("rejects non-numeric string for taxRatePercent", () => {
      const res = saleCreateSchema.safeParse({ taxRatePercent: "invalid_tax" });
      expect(res.success).toBe(false);
    });

    it("rejects negative taxRatePercent", () => {
      const res = saleCreateSchema.safeParse({ taxRatePercent: "-5" });
      expect(res.success).toBe(false);
    });

    it("rejects taxRatePercent > 100", () => {
      const res = saleCreateSchema.safeParse({ taxRatePercent: "100.50" });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].message).toContain("١٠٠٪");
      }
    });

    it("accepts valid taxRatePercent strings and undefined", () => {
      expect(saleCreateSchema.safeParse({ taxRatePercent: "15" }).success).toBe(true);
      expect(saleCreateSchema.safeParse({ taxRatePercent: "0" }).success).toBe(true);
      expect(saleCreateSchema.safeParse({}).success).toBe(true);
    });
  });

  describe("Service Defensive Handling in computeInvoiceTotals", () => {
    it("throws TRPCError BAD_REQUEST (HTTP 400) on malformed invoiceDiscount rather than unhandled DecimalError", () => {
      expect(() =>
        computeInvoiceTotals({
          lineTotals: ["100.00"],
          invoiceDiscount: "not_a_number",
        }),
      ).toThrow(TRPCError);

      try {
        computeInvoiceTotals({
          lineTotals: ["100.00"],
          invoiceDiscount: "not_a_number",
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(TRPCError);
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("خصم الفاتورة");
      }
    });

    it("throws TRPCError BAD_REQUEST on malformed taxRatePercent", () => {
      try {
        computeInvoiceTotals({
          lineTotals: ["100.00"],
          taxRatePercent: "bad_rate",
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(TRPCError);
        expect(err.code).toBe("BAD_REQUEST");
        expect(err.message).toContain("نسبة الضريبة");
      }
    });
  });
});
