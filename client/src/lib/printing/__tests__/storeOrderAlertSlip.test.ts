import { describe, expect, it } from "vitest";
import { isStoreOrderAlertRecipientUser } from "@shared/permissions";
import { buildStoreOrderAlertHtml } from "../storeOrderAlertSlip";

describe("isStoreOrderAlertRecipientUser", () => {
  it("matches reception and customer-service roles only", () => {
    expect(
      isStoreOrderAlertRecipientUser({
        role: "cashier",
        customRoleKey: "role_zbxlc8thuv",
        customRoleLabel: "كاشير استقبال أوامر شغل",
      }),
    ).toBe(true);

    expect(
      isStoreOrderAlertRecipientUser({
        role: "cashier",
        customRoleKey: "reception_clerk",
        customRoleLabel: "موظف استقبال",
      }),
    ).toBe(true);

    expect(
      isStoreOrderAlertRecipientUser({
        role: "user",
        customRoleKey: "custom_cs",
        customRoleLabel: "خدمة الزبائن",
      }),
    ).toBe(true);

    // Excludes admin, manager, retail cashier, print cashier, print operator, and courier
    expect(isStoreOrderAlertRecipientUser({ role: "admin" })).toBe(false);
    expect(isStoreOrderAlertRecipientUser({ role: "manager" })).toBe(false);
    expect(
      isStoreOrderAlertRecipientUser({
        role: "cashier",
        customRoleKey: "retail_cashier",
        customRoleLabel: "كاشير تجزئة",
        permissionsOverride: { workorders: "NONE", pos: "NONE", sales: "FULL", store: "FULL" },
      }),
    ).toBe(false);
    expect(
      isStoreOrderAlertRecipientUser({
        role: "cashier",
        customRoleKey: "print_cashier",
        customRoleLabel: "كاشير طباعة",
        permissionsOverride: { workorders: "NONE", pos: "FULL", sales: "NONE", store: "FULL" },
      }),
    ).toBe(false);
    expect(isStoreOrderAlertRecipientUser({ role: "courier" })).toBe(false);
    expect(
      isStoreOrderAlertRecipientUser({
        role: "cashier",
        customRoleKey: "reception_clerk",
        roleLockedByInactiveCustomRole: true,
      }),
    ).toBe(false);
  });
});

describe("buildStoreOrderAlertHtml", () => {
  it("renders a 10cm big-font alert slip with table, direct barcode, and thick total", () => {
    const html = buildStoreOrderAlertHtml({
      orderNumber: "ORD-2026-1042",
      createdAt: "2026-11-24T19:42:00.000Z",
      itemsCount: 4,
      totalAmount: "48000.00",
    });

    expect(html).toContain("80mm 100mm");
    expect(html).toContain("طلب متجر جديد");
    expect(html).toContain("رقم الطلب");
    expect(html).toContain("التاريخ");
    expect(html).toContain("عدد الأصناف");
    expect(html).toContain("ORD-2026-1042");
    expect(html).toContain("4 أصناف");
    expect(html).toContain("<svg");
    expect(html).toContain("قيمة الطلب");
    expect(html).toContain("48,000 د.ع");
  });
});
