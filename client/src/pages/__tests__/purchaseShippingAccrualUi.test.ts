import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n?/gu, "\n");

const legacyReceive = read("../PurchaseReceive.tsx");
const goodsReceipts = read(
  "../../components/purchases/GoodsReceiptsWorkspace.tsx",
);
const chargesPage = read("../PurchaseChargesGovernance.tsx");
const charges = read(
  "../../components/purchases/PurchaseChargesGovernanceWorkspace.tsx",
);
const supplierPaymentsPage = read("../SupplierPaymentsGovernance.tsx");
const supplierPayments = read(
  "../../components/purchases/SupplierPaymentsGovernanceWorkspace.tsx",
);

describe("حوكمة استلام وشحن وتسوية المشتريات بعد القطع", () => {
  it("يوجّه رابط الاستلام القديم إلى GRN ويحفظ رقم أمر الشراء بلا كتابة قديمة", () => {
    expect(legacyReceive).toContain("const params = useParams();");
    expect(legacyReceive).toContain("?purchaseOrderId=${purchaseOrderId}");
    expect(legacyReceive).toContain(
      "<Redirect to={`/purchases/goods-receipts${query}`} />",
    );
    expect(legacyReceive).not.toContain("trpc.purchases.receive");
    expect(legacyReceive).not.toContain("shippingPaymentRequestReceiptId");
  });

  it("يحصر إذن GRN في الاستلام والعكس ولا يخلط به مصروفاً أو دفعة مورّد", () => {
    expect(goodsReceipts).toContain("trpc.goodsReceipts.create.useMutation");
    expect(goodsReceipts).toContain(
      "trpc.goodsReceipts.requestReversal.useMutation",
    );
    expect(goodsReceipts).toContain(
      "trpc.goodsReceipts.decideReversal.useMutation",
    );
    expect(goodsReceipts).not.toContain("trpc.purchaseCharges.");
    expect(goodsReceipts).not.toContain("trpc.supplierPayments.");
  });

  it("يفصل مسودة مصروف الشحن/الكمرك عن طلب ترحيله واعتماده", () => {
    expect(chargesPage).toContain("trpc.purchaseCharges.create.useMutation");
    expect(chargesPage).toContain(
      "trpc.purchaseCharges.requestControl.useMutation",
    );
    expect(chargesPage).toContain(
      "const result = await create.mutateAsync(input);",
    );
    expect(chargesPage).toContain("return requestControl.mutateAsync({");
    expect(charges).toContain(
      "إنشاء المصروف يحفظ مسودة وتوزيعاً فقط. الترحيل أو العكس يحتاج طلباً",
    );
    expect(charges).toContain(
      "واعتماداً مستقلاً؛ المصروف لا يُحمّل تكلفة المخزون.",
    );
  });

  it("يجمع مرجع أداة الدفع غير النقدية ودليل المصروف ولا يعرض الصك", () => {
    for (const method of ["CASH", "CARD", "TRANSFER", "WALLET"]) {
      expect(charges).toContain(`<option value="${method}">`);
    }
    expect(charges).toContain('method === "CASH" ||');
    expect(charges).toContain(
      "externalReference: externalReference.trim() || null",
    );
    expect(charges).toContain("evidenceReference: evidenceReference.trim()");
    expect(charges).toContain("مرجع الدفع");
    expect(charges).toContain("مرجع الدليل");
    expect(charges).not.toContain('"CHECK"');
    expect(charges).not.toContain("رقم الصك");
  });

  it("ينقل تسوية المورد إلى مساحة مستقلة بعقد يطابق الطرق المعروضة", () => {
    expect(supplierPaymentsPage).toContain(
      "trpc.supplierPayments.requestPayment.useMutation",
    );
    expect(supplierPaymentsPage).toContain(
      "trpc.supplierPayments.decidePayment.useMutation",
    );
    expect(supplierPayments).toContain(
      'type Method = "CASH" | "CARD" | "TRANSFER" | "WALLET";',
    );
    expect(supplierPayments).toContain(
      '(method === "CASH" || externalReference.trim().length > 0)',
    );
    expect(supplierPayments).not.toContain('"CHECK"');
  });
});
