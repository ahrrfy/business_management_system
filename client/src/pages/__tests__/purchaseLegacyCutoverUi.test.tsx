import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function page(name: string) {
  return fs.readFileSync(path.resolve(process.cwd(), "client/src/pages", name), "utf8");
}

describe("تحويل واجهات المشتريات القديمة إلى المسارات المحكومة", () => {
  it("يحوّل رابط الاستلام القديم إلى شاشة GRN ويحفظ رقم الأمر", () => {
    const source = page("PurchaseReceive.tsx");
    expect(source).toContain("/purchases/goods-receipts");
    expect(source).toContain("purchaseOrderId=");
    expect(source).not.toContain("trpc.purchases.receive");
  });

  it("يحوّل شاشة المرتجع القديم إلى حوكمة المرتجعات", () => {
    const source = page("PurchaseReturnNew.tsx");
    expect(source).toContain("/purchases/returns-governance");
    expect(source).not.toContain("trpc.purchaseReturns.create");
  });

  it("توجّه تفاصيل الأمر إلى GRN وتسديد فاتورة المورد ولا تستعمل pay القديم", () => {
    const source = page("PurchaseOrderDetail.tsx");
    expect(source).toContain("/purchases/goods-receipts?purchaseOrderId=");
    expect(source).toContain("/purchases/supplier-payments?supplierId=");
    expect(source).not.toContain("trpc.purchases.pay.useMutation");
    expect(source).not.toContain("href={`/purchases/${d.id}/receive");
  });
});
