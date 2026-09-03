import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n?/gu, "\n");

const app = read("../../App.tsx");
const purchases = read("../Purchases.tsx");
const rootRouter = read("../../../../server/routers.ts");
const purchaseControls = read(
  "../../../../server/services/purchase/controls.ts",
);
const chargesPage = read("../PurchaseChargesGovernance.tsx");
const charges = read(
  "../../components/purchases/PurchaseChargesGovernanceWorkspace.tsx",
);
const supplierPaymentsPage = read("../SupplierPaymentsGovernance.tsx");
const supplierPayments = read(
  "../../components/purchases/SupplierPaymentsGovernanceWorkspace.tsx",
);

describe("شحن وتسوية فاتورة الشراء بعد إلغاء الاستلام المستقل", () => {
  it("يوجّه رابط الاستلام القديم إلى التفاصيل بلا شاشة أو mutation استلام", () => {
    expect(existsSync(new URL("../PurchaseReceive.tsx", import.meta.url))).toBe(
      false,
    );
    expect(app).toContain('path="/purchases/:id/receive"');
    expect(app).toContain("<Redirect to={`/purchases/${params.id}`} />");
    expect(purchases).not.toContain("trpc.purchases.receive");
    expect(purchases).not.toContain("href: `/purchases/${p.id}/receive`");
  });

  it("يحذف راوترات GRN/فاتورة المورد العامة ويرحّل عند الاعتماد النهائي", () => {
    expect(
      existsSync(
        new URL(
          "../../components/purchases/GoodsReceiptsWorkspace.tsx",
          import.meta.url,
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        new URL(
          "../../components/purchases/SupplierInvoicesWorkspace.tsx",
          import.meta.url,
        ),
      ),
    ).toBe(false);
    expect(rootRouter).not.toContain("goodsReceiptsRouter");
    expect(rootRouter).not.toContain("supplierInvoicesRouter");
    expect(purchaseControls).toContain(
      "const posting = await postApprovedPurchaseInvoiceInTx(",
    );
    expect(purchaseControls).toContain("automaticInvoicePosting: true");
    expect(purchaseControls).toContain(
      "goodsReceiptId: posting.goodsReceiptId",
    );
    expect(purchaseControls).toContain(
      "supplierInvoiceId: posting.supplierInvoiceId",
    );
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
