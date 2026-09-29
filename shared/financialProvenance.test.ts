import { describe, expect, it } from "vitest";
import {
  computeProvenanceReconciliation,
  type FinancialCellProvenancePayload,
  type ProvenanceMovementType,
  type ProvenanceParty,
  type ProvenanceDocumentRef,
  type ProvenanceSubItem,
  type ProvenanceReconciliationSummary,
} from "./financialProvenance";

describe("financialProvenance contracts & mathematical reconciliation", () => {
  it("should reconcile 100% when sub-items sum equals total amount", () => {
    const subItems: ProvenanceSubItem[] = [
      { id: 1, label: "بند أول", amount: "50000.00" },
      { id: 2, label: "بند ثاني", amount: "25000.00" },
      { id: 3, label: "بند ثالث", amount: "25000.00" },
    ];
    const recon = computeProvenanceReconciliation("100000.00", subItems);

    expect(recon.expectedTotal).toBe("100000.00");
    expect(recon.subItemsSum).toBe("100000.00");
    expect(recon.discrepancy).toBe("0.00");
    expect(recon.isFullyReconciled).toBe(true);
    expect(recon.subItemsCount).toBe(3);
  });

  it("should detect discrepancy when sub-items do not sum to total", () => {
    const subItems: ProvenanceSubItem[] = [
      { id: 1, label: "بند أ", amount: "15000.00" },
      { id: 2, label: "بند ب", amount: "20000.00" },
    ];
    const recon = computeProvenanceReconciliation("40000.00", subItems);

    expect(recon.expectedTotal).toBe("40000.00");
    expect(recon.subItemsSum).toBe("35000.00");
    expect(recon.discrepancy).toBe("5000.00");
    expect(recon.isFullyReconciled).toBe(false);
    expect(recon.subItemsCount).toBe(2);
  });

  it("should handle empty sub-items gracefully as atomic cell", () => {
    const recon = computeProvenanceReconciliation("75000.00");

    expect(recon.expectedTotal).toBe("75000.00");
    expect(recon.subItemsSum).toBe("0.00");
    expect(recon.discrepancy).toBe("0.00");
    expect(recon.isFullyReconciled).toBe(true);
    expect(recon.subItemsCount).toBe(0);
  });

  it("should handle numbers with commas, currency text and whitespace cleanly", () => {
    const subItems: ProvenanceSubItem[] = [
      { id: "s1", label: "دفعة نقدية", amount: "1,250.50 د.ع" },
      { id: "s2", label: "أجرة خدمة", amount: 749.5 },
    ];
    const recon = computeProvenanceReconciliation("2,000.00", subItems);

    expect(recon.expectedTotal).toBe("2000.00");
    expect(recon.subItemsSum).toBe("2000.00");
    expect(recon.discrepancy).toBe("0.00");
    expect(recon.isFullyReconciled).toBe(true);
  });

  it("should handle negative balances and differences correctly", () => {
    const subItems: ProvenanceSubItem[] = [
      { id: "d1", label: "عجز درج", amount: -2500 },
      { id: "d2", label: "فرق جرد", amount: "-1500.00" },
    ];
    const recon = computeProvenanceReconciliation("-4000", subItems);

    expect(recon.expectedTotal).toBe("-4000.00");
    expect(recon.subItemsSum).toBe("-4000.00");
    expect(recon.discrepancy).toBe("0.00");
    expect(recon.isFullyReconciled).toBe(true);
  });

  it("should validate full payload type structure", () => {
    const party: ProvenanceParty = {
      name: "شركة النور للطباعة",
      type: "supplier",
      id: 42,
      phone: "07701234567",
    };

    const docRef: ProvenanceDocumentRef = {
      docType: "purchase_order",
      docNumber: "PO-2026-089",
      id: 89,
      date: "2026-09-27",
    };

    const payload: FinancialCellProvenancePayload = {
      movementType: "delivery",
      title: "سداد دفعة أمر شراء",
      totalAmount: "150000.00",
      formattedAmount: "150,000 د.ع",
      party,
      documentRef: docRef,
      category: "مشتريات خامات",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      actorName: "محمد المحاسب",
      subItems: [
        { label: "ورق كوشيه 300 غم", amount: "100000.00", quantity: 5, unitPrice: "20000.00" },
        { label: "أحبار رقمية", amount: "50000.00", quantity: 2, unitPrice: "25000.00" },
      ],
      reconciliation: computeProvenanceReconciliation("150000.00", [
        { label: "ورق كوشيه 300 غم", amount: "100000.00" },
        { label: "أحبار رقمية", amount: "50000.00" },
      ]),
    };

    expect(payload.movementType).toBe("delivery");
    expect(payload.party?.name).toBe("شركة النور للطباعة");
    expect(payload.reconciliation?.isFullyReconciled).toBe(true);
  });
});
