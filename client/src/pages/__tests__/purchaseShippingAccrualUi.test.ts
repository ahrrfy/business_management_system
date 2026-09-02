import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const createSource = readFileSync(new URL("../PurchaseNew.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("../PurchaseOrderDetail.tsx", import.meta.url), "utf8");
const routerSource = readFileSync(
  new URL("../../../../server/routers/purchaseRouter.ts", import.meta.url),
  "utf8",
);

describe("واجهة اعتماد فاتورة الشراء والترحيل الآلي", () => {
  it("لا تحمّل شاشة استلام مستقلة وتحوّل رابطها التاريخي إلى تفاصيل الفاتورة", () => {
    expect(appSource).not.toMatch(/import\(["'][^"']*PurchaseReceive["']\)/);
    expect(appSource).toContain('<Route path="/purchases/:id/receive">');
    expect(appSource).toContain('<Redirect to={`/purchases/${params.id}`} />');
  });

  it("تشرح أن اعتماد الفاتورة يضيف كامل الكميات إلى المخزون", () => {
    expect(createSource).toContain("تم اعتماد فاتورة الشراء وإضافة كامل كمياتها إلى المخزون");
    expect(createSource).toContain("اعتماد الفاتورة");
    expect(createSource).not.toContain("تسجيل استلام");
  });

  it("تبقي التسديد والبونص في صفحة التفاصيل من دون إعادة إدخال كميات الفاتورة", () => {
    expect(detailSource).toContain("تسديد للمورّد");
    expect(detailSource).toContain("بونص مجاني من المورّد");
    expect(detailSource).not.toContain("purchases.receive.useMutation");
    expect(routerSource).not.toMatch(/^\s*receive:\s*purchasesWarehouseProcedure/m);
  });
});
