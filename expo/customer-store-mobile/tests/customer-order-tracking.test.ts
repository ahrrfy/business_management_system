import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const readAppFile = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("customer order tracking guidance", () => {
  it("keeps staff confirmation and each customer-facing fulfillment stage explicit", () => {
    const orders = readAppFile("app/(tabs)/orders.tsx");
    const confirmation = readAppFile("app/order-confirmation.tsx");

    expect(orders).toContain('PENDING: "بانتظار تأكيد الموظف"');
    expect(orders).toContain('"تأكيد الموظف"');
    expect(orders).toContain('"التجهيز"');
    expect(orders).toContain('"قيد التوصيل"');
    expect(orders).toContain('"تم التسليم"');
    expect(confirmation).toContain(
      "استلام الطلب في التطبيق لا يعني أنه مؤكد بعد",
    );
  });

  it("offers the product-review next action only after delivery and a verified session", () => {
    const orders = readAppFile("app/(tabs)/orders.tsx");

    expect(orders).toContain(
      'tracking.status === "DELIVERED" && hasVerifiedCustomerSession',
    );
    expect(orders).toContain("اختيار منتج للتقييم");
    expect(orders).toContain("يتيح النظام المراجعة فقط للمنتجات التي استلمتها");
  });
});
