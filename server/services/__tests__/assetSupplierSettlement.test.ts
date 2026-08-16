import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isCanonicalSystemPaymentRequest,
  type SystemPaymentRequest,
} from "../voucher/create";

const serviceSource = readFileSync(
  new URL("../assets/supplierSettlement.ts", import.meta.url),
  "utf8",
);

function request(overrides: Partial<Extract<SystemPaymentRequest, { kind: "ASSET_SUPPLIER_SETTLEMENT" }>> = {}) {
  return {
    kind: "ASSET_SUPPLIER_SETTLEMENT" as const,
    assetId: 12,
    supplierId: 4,
    expectedAmount: "800000.00",
    obligationId: 91,
    obligationSourceHash: "a".repeat(64),
    beneficiaryType: "SUPPLIER" as const,
    beneficiaryId: 4,
    beneficiaryNameSnapshot: "شركة التجهيز العراقية",
    sourceEvidenceReference: "INV-FA-17",
    ...overrides,
  };
}

describe("supplier-financed asset settlement contract", () => {
  it("accepts only the exact asset/supplier/obligation canonical reference", () => {
    const signed = request();
    expect(isCanonicalSystemPaymentRequest(signed, "ASSET-SUP-SETTLE-12-91")).toBe(true);
    expect(isCanonicalSystemPaymentRequest(signed, "ASSET-SUP-SETTLE-12-92")).toBe(false);
    expect(isCanonicalSystemPaymentRequest(request({ beneficiaryId: 5 }), "ASSET-SUP-SETTLE-12-91")).toBe(false);
    expect(isCanonicalSystemPaymentRequest(request({ expectedAmount: "0.00" }), "ASSET-SUP-SETTLE-12-91")).toBe(false);
  });

  it("creates only a pending supplier request and records its immutable event link", () => {
    expect(serviceSource).toContain('paymentMethod: "CASH"');
    expect(serviceSource).toContain('partyType: "SUPPLIER"');
    expect(serviceSource).toContain("counterpartyName: supplier.name");
    expect(serviceSource).toContain('expectedStatus: "PAYABLE_UNSETTLED"');
    expect(serviceSource).toContain('nextStatus: "PAYMENT_PENDING"');
    expect(serviceSource).toContain('eventType: "PAYMENT_REQUESTED"');
    expect(serviceSource).not.toContain("adjustSupplierBalance");
    expect(serviceSource).not.toContain("postEntry(");
  });
});
