import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function page(name: string) {
  return fs.readFileSync(
    path.resolve(process.cwd(), "client/src/pages", name),
    "utf8",
  );
}

describe("تحويل واجهات المشتريات القديمة إلى المسارات المحكومة", () => {
  it("يحذف شاشات الاستلام ويحوّل الرابط القديم إلى تفاصيل الفاتورة", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/App.tsx"),
      "utf8",
    );
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "client/src/pages/PurchaseReceive.tsx"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.resolve(
          process.cwd(),
          "client/src/pages/PurchaseGoodsReceipts.tsx",
        ),
      ),
    ).toBe(false);
    expect(app).toContain('path="/purchases/:id/receive"');
    expect(app).toContain("<Redirect to={`/purchases/${params.id}`} />");
    expect(app).not.toContain('import("@/pages/PurchaseReceive")');
    expect(app).not.toContain('import("@/pages/PurchaseGoodsReceipts")');
  });

  it("يحوّل مسار المرتجع القديم في App.tsx إلى بوابة المرتجعات المركزية مع حذف الشاشة الميتة", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/App.tsx"),
      "utf8",
    );
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "client/src/pages/PurchaseReturnNew.tsx"),
      ),
    ).toBe(false);
    expect(app).toContain('<Route path="/purchase-returns/new"><Redirect to="/returns?tab=purchases" /></Route>');
  });

  it("يجعل التفاصيل وجهة العرض الوحيدة بلا رابط GRN أو استلام", () => {
    const detail = page("PurchaseOrderDetail.tsx");
    const list = page("Purchases.tsx");
    expect(detail).not.toContain("/purchases/goods-receipts");
    expect(detail).not.toContain("href={`/purchases/${d.id}/receive");
    expect(list).not.toContain("href: `/purchases/${p.id}/receive`");
    expect(list).toContain("href: `/purchases/${p.id}`");
    expect(list).toContain('label: "عرض التفاصيل"');
  });

  it("يحذف واجهة فاتورة المورد المستقلة وتبويبها", () => {
    const hub = page("PurchasesHub.tsx");
    expect(
      fs.existsSync(
        path.resolve(
          process.cwd(),
          "client/src/pages/PurchaseSupplierInvoices.tsx",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.resolve(
          process.cwd(),
          "client/src/components/purchases/SupplierInvoicesWorkspace.tsx",
        ),
      ),
    ).toBe(false);
    expect(hub).not.toContain("PurchaseSupplierInvoices");
    expect(hub).not.toContain('value: "supplier-invoices"');
  });
});
