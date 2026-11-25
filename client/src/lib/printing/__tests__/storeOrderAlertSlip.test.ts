import { describe, expect, it, vi } from "vitest";
import { isStoreOrderAlertRecipientUser, resolvePermissions } from "@shared/permissions";
import { legacyOperationPolicy, resolveOperationPolicy } from "@shared/operationPermissions";
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

    // Matches customer-service / reception jobTitle when store module is permitted
    expect(
      isStoreOrderAlertRecipientUser({
        role: "user",
        jobTitle: "موظف خدمة العملاء",
        permissionsOverride: { store: "FULL" },
      }),
    ).toBe(true);
    expect(
      isStoreOrderAlertRecipientUser({
        role: "user",
        jobTitle: "موظف خدمة العملاء",
        permissionsOverride: { store: "NONE" },
      }),
    ).toBe(false);
    expect(
      isStoreOrderAlertRecipientUser({
        role: "admin",
        isOwner: true,
        jobTitle: "استقبال",
      }),
    ).toBe(false);
  });

  it("grants pendingNotificationPrint, claimNotificationPrint, and releaseNotificationPrint via stationCompanions on saved reception role policies", () => {
    const legacyModules = resolvePermissions("cashier", {
      workorders: "FULL",
      pos: "FULL",
      sales: "FULL",
      store: "FULL",
    });
    const savedRoleSnapshot = legacyOperationPolicy("cashier", legacyModules, {
      workorders: "FULL",
      pos: "FULL",
      sales: "FULL",
      store: "FULL",
    });
    // Simulate a saved role snapshot created before notification print procedures existed
    delete savedRoleSnapshot.grants["operation.storeAdmin.orders.pendingNotificationPrint"];
    delete savedRoleSnapshot.grants["operation.storeAdmin.orders.claimNotificationPrint"];
    delete savedRoleSnapshot.grants["operation.storeAdmin.orders.releaseNotificationPrint"];

    const resolved = resolveOperationPolicy(
      "cashier",
      legacyModules,
      savedRoleSnapshot,
      null,
    );
    expect(resolved.grants["operation.storeAdmin.orders.pendingNotificationPrint"]).toBe(true);
    expect(resolved.grants["operation.storeAdmin.orders.claimNotificationPrint"]).toBe(true);
    expect(resolved.grants["operation.storeAdmin.orders.releaseNotificationPrint"]).toBe(true);
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

  it("recovers via expiring lease when claim commits on DB but response is lost or winning tab closes before printing", async () => {
    let nowMs = 10_000;
    let leaseExpiresAt: number | null = null;
    let confirmedPrinted = false;
    const scheduled: Array<{ runAt: number; fn: () => void; cancelled: boolean }> = [];

    const scheduleFn = (fn: () => void, delayMs: number) => {
      const item = { runAt: nowMs + delayMs, fn, cancelled: false };
      scheduled.push(item);
      return item as unknown as ReturnType<typeof setTimeout>;
    };
    const cancelFn = (handle: ReturnType<typeof setTimeout>) => {
      (handle as unknown as { cancelled: boolean }).cancelled = true;
    };
    const advanceTo = async (targetMs: number) => {
      nowMs = targetMs;
      const due = scheduled.filter((t) => !t.cancelled && t.runAt <= nowMs);
      for (const t of due) {
        t.cancelled = true;
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    };

    let dropFirstClaimResponse = true;
    const claimServer = async () => {
      if (confirmedPrinted) return { claimed: false, alreadyPrinted: true };
      if (leaseExpiresAt !== null && nowMs <= leaseExpiresAt) {
        return { claimed: false, alreadyPrinted: false };
      }
      leaseExpiresAt = nowMs + 20_000;
      const token = String(leaseExpiresAt);
      if (dropFirstClaimResponse) {
        dropFirstClaimResponse = false;
        throw new Error("network socket hang up after DB commit");
      }
      return {
        claimed: true,
        alreadyPrinted: false,
        leaseToken: token,
        orderNumber: "ORD-LEASE-88",
        total: "19000.00",
        itemCount: 2,
      };
    };
    const confirmServer = vi.fn(async () => {
      confirmedPrinted = true;
    });

    const stationAPrint = vi.fn().mockResolvedValue("printed" as const);
    const stationBPrint = vi.fn().mockResolvedValue("printed" as const);

    const stationA = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimServer,
      confirm: confirmServer,
      release: async () => {},
      print: stationAPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });
    const stationB = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimServer,
      confirm: confirmServer,
      release: async () => {},
      print: stationBPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const payload = { orderId: 88, orderNumber: "ORD-LEASE-88", totalAmount: "19000.00" };
    // Station A commits DB lease, loses response; Station B sees active lease -> neither prints yet
    await stationA.handleEvent(payload);
    await stationB.handleEvent(payload);
    expect(stationAPrint).not.toHaveBeenCalled();
    expect(stationBPrint).not.toHaveBeenCalled();

    // Simulate Station A tab closing before recovery
    stationA.dispose();

    // At +2.5s lease is still active (expires at 30_000ms)
    await advanceTo(12_600);
    expect(stationBPrint).not.toHaveBeenCalled();

    // At +21.5s after 12_600 -> lease has expired, Station B reclaims, prints once, and confirms completion!
    await advanceTo(35_000);
    expect(stationBPrint).toHaveBeenCalledTimes(1);
    expect(confirmServer).toHaveBeenCalledTimes(1);
    expect(confirmedPrinted).toBe(true);
  });

  it("renews the lease during a slow (>28s) active print so standby never double-prints, and aborts before submit if lease expires unrenewed", async () => {
    let nowMs = 1_000;
    let leaseDeadline: number | null = null;
    let currentToken: string | null = null;
    let confirmed = false;
    let tokenSeq = 0;
    const scheduled: Array<{ runAt: number; fn: () => void; cancelled: boolean }> = [];

    const scheduleFn = (fn: () => void, delayMs: number) => {
      const item = { runAt: nowMs + delayMs, fn, cancelled: false };
      scheduled.push(item);
      return item as unknown as ReturnType<typeof setTimeout>;
    };
    const cancelFn = (handle: ReturnType<typeof setTimeout>) => {
      (handle as unknown as { cancelled: boolean }).cancelled = true;
    };
    const advanceTo = async (targetMs: number) => {
      while (true) {
        const next = scheduled
          .filter((t) => !t.cancelled && t.runAt <= targetMs)
          .sort((a, b) => a.runAt - b.runAt)[0];
        if (!next) break;
        nowMs = next.runAt;
        next.cancelled = true;
        next.fn();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      }
      nowMs = targetMs;
      await new Promise((r) => setTimeout(r, 0));
    };

    const claimServer = async () => {
      if (confirmed) return { claimed: false, alreadyPrinted: true };
      if (leaseDeadline !== null && nowMs <= leaseDeadline) {
        return { claimed: false, alreadyPrinted: false };
      }
      tokenSeq += 1;
      currentToken = `lease-${tokenSeq}`;
      leaseDeadline = nowMs + 20_000;
      return { claimed: true, alreadyPrinted: false, leaseToken: currentToken, orderNumber: "ORD-SLOW-99", total: "32000", itemCount: 2 };
    };
    const renewServer = vi.fn(async (_id: number, token?: string | null) => {
      if (confirmed || !token || token !== currentToken || leaseDeadline === null || nowMs > leaseDeadline) {
        return { renewed: false, leaseToken: null };
      }
      tokenSeq += 1;
      currentToken = `lease-${tokenSeq}`;
      leaseDeadline = nowMs + 20_000;
      return { renewed: true, leaseToken: currentToken };
    });
    const confirmServer = vi.fn(async () => {
      confirmed = true;
    });

    let stationAHardwareSubmissions = 0;
    let finishStationAPrint!: () => void;
    const stationAPrint = vi.fn((_data, opts?: { signal?: AbortSignal }) =>
      new Promise<"printed" | "lease_lost">((resolve) => {
        finishStationAPrint = () => {
          if (opts?.signal?.aborted) {
            resolve("lease_lost");
            return;
          }
          stationAHardwareSubmissions += 1;
          resolve("printed");
        };
      }),
    );
    const stationBPrint = vi.fn().mockResolvedValue("printed" as const);

    const stationA = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimServer,
      renew: renewServer,
      confirm: confirmServer,
      release: async () => {},
      print: stationAPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });
    const stationB = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimServer,
      renew: renewServer,
      confirm: confirmServer,
      release: async () => {},
      print: stationBPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const payload = { orderId: 99, orderNumber: "ORD-SLOW-99", totalAmount: "32000" };
    const pA = stationA.handleEvent(payload);
    await new Promise((r) => setTimeout(r, 0));
    const pB = stationB.handleEvent(payload);
    await new Promise((r) => setTimeout(r, 0));

    await advanceTo(31_000);
    expect(renewServer.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(stationBPrint).not.toHaveBeenCalled();

    finishStationAPrint();
    await Promise.all([pA, pB]);
    await advanceTo(55_000);
    expect(stationAHardwareSubmissions).toBe(1);
    expect(stationBPrint).not.toHaveBeenCalled();
    expect(confirmed).toBe(true);
  });

  it("gives silent WebUSB stations a head start over OS browser-print stations, and falls back to OS print when no WebUSB station claims", async () => {
    let nowMs = 1_000;
    const scheduled: Array<{ runAt: number; fn: () => void; cancelled: boolean }> = [];
    const scheduleFn = (fn: () => void, delayMs: number) => {
      const item = { runAt: nowMs + delayMs, fn, cancelled: false };
      scheduled.push(item);
      return item as unknown as ReturnType<typeof setTimeout>;
    };
    const cancelFn = (handle: ReturnType<typeof setTimeout>) => {
      (handle as unknown as { cancelled: boolean }).cancelled = true;
    };
    const advanceTo = async (targetMs: number) => {
      await new Promise((r) => setTimeout(r, 0));
      while (true) {
        const next = scheduled
          .filter((t) => !t.cancelled && t.runAt <= targetMs)
          .sort((a, b) => a.runAt - b.runAt)[0];
        if (!next) break;
        nowMs = next.runAt;
        next.cancelled = true;
        next.fn();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      }
      nowMs = targetMs;
      await new Promise((r) => setTimeout(r, 0));
    };

    // Case 1: OS-only reception station (no WebUSB) opens dialog after head-start and requires explicit confirmation before marking printed
    let order101Claimed = false;
    let order101Confirmed = false;
    let order101Released = false;
    let pendingAck: {
      confirmPrinted: () => Promise<void>;
      retryOrRelease: () => Promise<void>;
    } | null = null;
    const osOnlyPrint = vi.fn().mockResolvedValue("dialog_opened" as const);
    const osOnlyStation = createStoreOrderAlertCoordinator({
      hasPrinter: async () => false,
      canBrowserFallback: () => true,
      browserFallbackHeadStartMs: 700,
      claim: async () => {
        if (order101Confirmed) return { claimed: false, alreadyPrinted: true };
        if (order101Claimed) return { claimed: false, alreadyPrinted: false };
        order101Claimed = true;
        return { claimed: true, leaseToken: "t-101", orderNumber: "ORD-OS-101", total: "15000", itemCount: 1 };
      },
      confirm: async () => {
        order101Confirmed = true;
      },
      release: async () => {
        order101Claimed = false;
        order101Released = true;
      },
      print: osOnlyPrint,
      onBrowserDialogOpened: (ctx) => {
        pendingAck = ctx;
      },
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const pOs = osOnlyStation.handleEvent({ orderId: 101, orderNumber: "ORD-OS-101", totalAmount: "15000" });
    await advanceTo(1_500);
    expect(osOnlyPrint).not.toHaveBeenCalled();
    await advanceTo(2_000);
    await pOs;
    expect(osOnlyPrint).toHaveBeenCalledTimes(1);
    expect(osOnlyPrint.mock.calls[0]?.[1]?.allowBrowserFallback).toBe(true);
    // Unconfirmed browser dialog must NOT auto-confirm alertPrintedAt
    expect(order101Confirmed).toBe(false);
    expect(order101Released).toBe(false);
    expect(pendingAck).not.toBeNull();
    await pendingAck!.confirmPrinted();
    expect(order101Confirmed).toBe(true);

    // Case 2: Both a WebUSB station and an OS-only station receive Order 102 -> WebUSB wins at 0ms!
    let order102Claimed = false;
    let order102Confirmed = false;
    const claimOrder102 = async () => {
      if (order102Confirmed) return { claimed: false, alreadyPrinted: true };
      if (order102Claimed) return { claimed: false, alreadyPrinted: false };
      order102Claimed = true;
      return { claimed: true, leaseToken: "t-102", orderNumber: "ORD-USB-102", total: "22000", itemCount: 2 };
    };
    const usbPrint = vi.fn().mockResolvedValue("printed" as const);
    const fallbackPrint = vi.fn().mockResolvedValue("printed" as const);

    const usbStation = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: claimOrder102,
      confirm: async () => { order102Confirmed = true; },
      release: async () => {},
      print: usbPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });
    const fallbackStation = createStoreOrderAlertCoordinator({
      hasPrinter: async () => false,
      canBrowserFallback: () => true,
      browserFallbackHeadStartMs: 700,
      claim: claimOrder102,
      confirm: async () => { order102Confirmed = true; },
      release: async () => {},
      print: fallbackPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const pFallback = fallbackStation.handleEvent({ orderId: 102, orderNumber: "ORD-USB-102", totalAmount: "22000" });
    const pUsb = usbStation.handleEvent({ orderId: 102, orderNumber: "ORD-USB-102", totalAmount: "22000" });
    await advanceTo(3_000);
    await Promise.all([pFallback, pUsb]);
    expect(usbPrint).toHaveBeenCalledTimes(1);
    expect(usbPrint.mock.calls[0]?.[1]?.allowBrowserFallback).toBe(false);
    expect(fallbackPrint).not.toHaveBeenCalled();
  });
});
