import { describe, expect, it, vi } from "vitest";
import { isStoreOrderAlertRecipientUser } from "@shared/permissions";
import {
  buildStoreOrderAlertHtml,
  createStoreOrderAlertCoordinator,
} from "../storeOrderAlertSlip";

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

describe("createStoreOrderAlertCoordinator — multi-station failover", () => {
  it("transfers printing to a standby station when the winning station encounters a printer failure and releases the claim", async () => {
    let dbClaimed = false;
    let currentTime = 1_000;
    const broadcasts: Array<{
      orderId: number;
      orderNumber: string;
      totalAmount: string;
      alertPrintHandoff?: boolean;
    }> = [];

    const stationANotifications: string[] = [];
    const stationBNotifications: string[] = [];
    const stationAPrints = vi.fn().mockResolvedValue("hardware_error" as const);
    const stationBPrints = vi.fn().mockResolvedValue("printed" as const);

    const claimDb = async () => {
      if (dbClaimed) return { claimed: false };
      dbClaimed = true;
      return {
        claimed: true,
        orderNumber: "ORD-FAILOVER-77",
        total: "25000.00",
        itemCount: 3,
      };
    };

    let stationA!: ReturnType<typeof createStoreOrderAlertCoordinator>;
    let stationB!: ReturnType<typeof createStoreOrderAlertCoordinator>;

    const releaseDb = async (orderId: number) => {
      dbClaimed = false;
      const handoff = {
        orderId,
        orderNumber: "ORD-FAILOVER-77",
        totalAmount: "25000.00",
        alertPrintHandoff: true,
      };
      broadcasts.push(handoff);
      await Promise.all([
        stationA.handleEvent(handoff),
        stationB.handleEvent(handoff),
      ]);
    };

    stationA = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimDb,
      release: releaseDb,
      print: stationAPrints,
      onNotify: (p) => stationANotifications.push(p.orderNumber),
      now: () => currentTime,
      scheduleRetry: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelRetry: () => {},
    });

    stationB = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimDb,
      release: releaseDb,
      print: stationBPrints,
      onNotify: (p) => stationBNotifications.push(p.orderNumber),
      now: () => currentTime,
      scheduleRetry: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelRetry: () => {},
    });

    const initialPayload = {
      orderId: 77,
      orderNumber: "ORD-FAILOVER-77",
      totalAmount: "25000.00",
      itemsCount: 3,
    };

    // Station A arrives slightly earlier, claims, fails hardware, releases -> handoff broadcast lets Station B print!
    const pA = stationA.handleEvent(initialPayload);
    const pB = stationB.handleEvent(initialPayload);
    await Promise.all([pA, pB]);

    expect(stationAPrints).toHaveBeenCalledTimes(1);
    expect(stationBPrints).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1);
    // Neither station double-notifies during silent handoff
    expect(stationANotifications).toEqual(["ORD-FAILOVER-77"]);
    expect(stationBNotifications).toEqual(["ORD-FAILOVER-77"]);

    // Subsequent duplicate events do not re-print on Station B
    currentTime += 20_000;
    await stationB.handleEvent(initialPayload);
    expect(stationBPrints).toHaveBeenCalledTimes(1);
  });
});
