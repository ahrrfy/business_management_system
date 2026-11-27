import { describe, expect, it, vi } from "vitest";
import { isStoreOrderAlertRecipientUser, resolvePermissions } from "@shared/permissions";
import { legacyOperationPolicy, resolveOperationPolicy } from "@shared/operationPermissions";
import {
  buildStoreOrderAlertHtml,
  computeStoreOrderAlertTimingPolicy,
  createStoreOrderAlertCoordinator,
  readStoreOrderAutoPrintStationSetting,
  setStoreOrderAutoPrintStationSetting,
  shouldRunStoreOrderAutoPrintOnRoute,
  STORE_ORDER_AUTOPRINT_STATION_KEY,
  subscribeServerBridgeAvailability,
} from "../storeOrderAlertSlip";
import { THERMAL_PRINTER_CHANGE_EVENT } from "../thermal";
import { RealtimeManager } from "@/lib/realtime/realtimeManager";
import { REALTIME_IDLE_TIMEOUT_MS } from "@shared/realtimeEvents";

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

  it("prioritizes visible foreground tabs (e.g. /pos) over hidden background tabs via dynamic head-starts, and releases active dialog leases on dispose()", async () => {
    let nowMs = 5_000;
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

    let claimedBy: string | null = null;
    const releaseTokens: Array<string | null | undefined> = [];

    const hiddenTabPrint = vi.fn().mockResolvedValue("dialog_opened" as const);
    const visiblePosPrint = vi.fn().mockResolvedValue("dialog_opened" as const);

    const hiddenDashboardTab = createStoreOrderAlertCoordinator({
      hasPrinter: async () => false,
      canBrowserFallback: () => true,
      browserFallbackHeadStartMs: () => 2_200,
      claim: async () => {
        if (claimedBy) return { claimed: false };
        claimedBy = "hidden";
        return { claimed: true, leaseToken: "lease-hidden", orderNumber: "ORD-POS-201", total: "18000", itemCount: 1 };
      },
      release: async (_id, token) => {
        claimedBy = null;
        releaseTokens.push(token);
      },
      print: hiddenTabPrint,
      onBrowserDialogOpened: () => {},
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const visiblePosTab = createStoreOrderAlertCoordinator({
      hasPrinter: async () => false,
      canBrowserFallback: () => true,
      browserFallbackHeadStartMs: () => 700,
      claim: async () => {
        if (claimedBy) return { claimed: false };
        claimedBy = "pos";
        return { claimed: true, leaseToken: "lease-pos", orderNumber: "ORD-POS-201", total: "18000", itemCount: 1 };
      },
      release: async (_id, token) => {
        claimedBy = null;
        releaseTokens.push(token);
      },
      print: visiblePosPrint,
      onBrowserDialogOpened: () => {},
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const pHidden = hiddenDashboardTab.handleEvent({ orderId: 201, orderNumber: "ORD-POS-201", totalAmount: "18000" });
    const pPos = visiblePosTab.handleEvent({ orderId: 201, orderNumber: "ORD-POS-201", totalAmount: "18000" });

    // At +800ms, visible POS tab (700ms) claims and opens print while hidden tab (2200ms) waits
    await advanceTo(5_800);
    await pPos;
    expect(claimedBy).toBe("pos");
    expect(visiblePosPrint).toHaveBeenCalledTimes(1);
    expect(hiddenTabPrint).not.toHaveBeenCalled();

    // Disposing visiblePosTab while awaiting OS dialog confirmation immediately releases lease-pos
    visiblePosTab.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(releaseTokens).toContain("lease-pos");
    expect(claimedBy).toBeNull();

    // Hidden tab then takes over at +2200ms and prints so order is never lost
    await advanceTo(7_500);
    await pHidden;
    expect(hiddenTabPrint).toHaveBeenCalledTimes(1);
    hiddenDashboardTab.dispose();
  });

  it("defers lease release until an in-flight physical print settles so committed USB/bridge prints confirm instead of double-printing", async () => {
    const confirmFn = vi.fn(async () => {});
    const releaseFn = vi.fn(async () => {});
    let resolveInFlightUsbTransfer!: (res: "printed" | "lease_lost") => void;

    const station = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      claim: async () => ({
        claimed: true,
        leaseToken: "lease-usb-inflight",
        orderNumber: "ORD-INFLIGHT-301",
        total: "29000",
        itemCount: 2,
      }),
      confirm: confirmFn,
      release: releaseFn,
      print: () =>
        new Promise<"printed" | "lease_lost">((resolve) => {
          resolveInFlightUsbTransfer = resolve;
        }),
    });

    const handlePromise = station.handleEvent({
      orderId: 301,
      orderNumber: "ORD-INFLIGHT-301",
      totalAmount: "29000",
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Navigating to a public route (/price-checker) calls dispose() while USB transferOut is already in-flight
    station.dispose();
    // Must NOT release the lease while physical USB bytes are still transmitting!
    expect(releaseFn).not.toHaveBeenCalled();

    // Physical USB transmission completes -> confirms completion, zero duplicate print handoff!
    resolveInFlightUsbTransfer("printed");
    await handlePromise;
    expect(confirmFn).toHaveBeenCalledWith(301, "lease-usb-inflight");
    expect(releaseFn).not.toHaveBeenCalled();
  });
});

describe("Global Store Order Auto-Print — route coverage & root architecture", () => {
  it("enables auto-print on POS (all modes), reception, print-studio, dashboard, and internal hubs while blocking public/CFD/kiosk routes", () => {
    const internalHost = "srv1548487.hstgr.cloud";
    const devHost = "localhost";
    const publicHost = "alarabiya.online";

    // Active employee workstations (including full-screen POS outside AppLayout)
    expect(shouldRunStoreOrderAutoPrintOnRoute("/", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/", devHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/pos", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/pos?mode=RETAIL", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/pos?mode=PRINT_SERVICES", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/pos?mode=RECEPTION", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/pos?workspace=reservations", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/print-pos", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/reception", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/print-studio", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/store-admin", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/invoices", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/delivery", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/work-orders", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/reception/orders", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/inventory", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/crm", internalHost)).toBe(true);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/my-stocktake", internalHost)).toBe(true);

    // Blocked public, customer-facing, kiosk, login, and courier routes
    expect(shouldRunStoreOrderAutoPrintOnRoute("/", publicHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/pos", publicHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/login", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/cfd", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/kiosk", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/price-checker", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/shelf-lookup", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/price-check", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/store", devHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/store/product/42", devHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/legal/privacy", devHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/apply", devHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/count/XYZ", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/verify/INV-1", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/mobile-design-preview", internalHost)).toBe(false);
    expect(shouldRunStoreOrderAutoPrintOnRoute("/my-deliveries", internalHost)).toBe(false);
  });

  it("enforces root-level GlobalStoreOrderAutoPrint outside Switch/AppLayout, POS quick toggle, and SPA realtime route reconciliation", async () => {
    const fs = await import("node:fs");
    const appSource = fs.readFileSync("client/src/App.tsx", "utf8");
    const layoutSource = fs.readFileSync("client/src/components/AppLayout.tsx", "utf8");
    const posSource = fs.readFileSync("client/src/pages/PointOfSale.tsx", "utf8");
    const mainSource = fs.readFileSync("client/src/main.tsx", "utf8");
    const globalAutoPrintSource = fs.readFileSync(
      "client/src/components/store-admin/GlobalStoreOrderAutoPrint.tsx",
      "utf8",
    );

    // 1. App.tsx mounts GlobalStoreOrderAutoPrint once BEFORE <Switch> so navigating across routes or into /pos never unmounts it
    const globalMountIdx = appSource.indexOf("<GlobalStoreOrderAutoPrint />");
    const switchIdx = appSource.indexOf("<Switch>");
    expect(globalMountIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(globalMountIdx);

    // 2. AppLayout no longer duplicates or tears down createStoreOrderAlertCoordinator on route changes
    expect(layoutSource).not.toContain("createStoreOrderAlertCoordinator");

    // 3. PointOfSale header includes StoreOrderAutoPrintQuickToggle supervisory badge + silent USB connect
    expect(posSource).toContain("<StoreOrderAutoPrintQuickToggle");

    // 4. main.tsx reconciles realtime route eligibility on SPA transitions (e.g. /login -> /pos)
    expect(mainSource).toContain("reconcileRealtimeRouteFn?.()");

    // 5. GlobalStoreOrderAutoPrint keeps background polling & SSE exemption active on dedicated print stations
    expect(globalAutoPrintSource).toContain("refetchIntervalInBackground: true");
    expect(globalAutoPrintSource).toContain("retainRealtimeIdleExemption()");
  });

  it("keeps RealtimeManager connected past 15-minute hidden idle timeout while an active print station holds retainPreventIdleDisconnect()", () => {
    vi.useFakeTimers();
    const prevDoc = (globalThis as { document?: unknown }).document;
    try {
      const listeners = new Map<string, Set<() => void>>();
      const mockDoc = {
        visibilityState: "hidden",
        addEventListener: (ev: string, fn: () => void) => {
          if (!listeners.has(ev)) listeners.set(ev, new Set());
          listeners.get(ev)!.add(fn);
        },
        removeEventListener: (ev: string, fn: () => void) => {
          listeners.get(ev)?.delete(fn);
        },
      };
      (globalThis as { document?: unknown }).document = mockDoc;

      const mgr = new RealtimeManager("tab_autoprint_station");
      const releaseExemption = mgr.retainPreventIdleDisconnect();
      mgr.start();

      vi.advanceTimersByTime(REALTIME_IDLE_TIMEOUT_MS + 5_000);
      expect(mgr.getStatus()).not.toBe("idle_disconnected");

      // Releasing exemption while still hidden arms the standard 15-minute battery saver
      releaseExemption();
      vi.advanceTimersByTime(REALTIME_IDLE_TIMEOUT_MS + 1_000);
      expect(mgr.getStatus()).toBe("idle_disconnected");

      mgr.stop();
    } finally {
      (globalThis as { document?: unknown }).document = prevDoc;
      vi.useRealTimers();
    }
  });
});

describe("Always-On Store Order Auto-Print — tiered priority, anti-hijack & supervisory UI contracts", () => {
  it("computes deterministic 4-tier timing policy for reception, backup thermal, OS fallback, and printer-less/owner sessions", () => {
    // Tier 1: Reception/CS + thermal printer gets immediate priority (0ms visible / 150ms hidden)
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: true,
        isOwner: false,
        hasThermalPrinter: true,
        isHiddenTab: false,
        hasDocument: true,
      }),
    ).toEqual({
      canBrowserFallback: true,
      claimHeadStartMs: 0,
      browserFallbackHeadStartMs: 2_500,
    });
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: true,
        isOwner: false,
        hasThermalPrinter: true,
        isHiddenTab: true,
        hasDocument: true,
      }).claimHeadStartMs,
    ).toBe(150);

    // Tier 2: Non-reception authorized staff (or owner WITH thermal printer) waits behind Reception (1200ms / 1600ms)
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: false,
        isOwner: false,
        hasThermalPrinter: true,
        isHiddenTab: false,
        hasDocument: true,
      }),
    ).toEqual({
      canBrowserFallback: false,
      claimHeadStartMs: 1_200,
      browserFallbackHeadStartMs: 2_500,
    });
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: false,
        isOwner: true,
        hasThermalPrinter: true,
        isHiddenTab: true,
        hasDocument: true,
      }),
    ).toEqual({
      canBrowserFallback: false,
      claimHeadStartMs: 1_600,
      browserFallbackHeadStartMs: 3_500,
    });

    // Tier 3: Reception/CS (!isOwner) without thermal printer falls back to OS print after thermal tiers (2500ms / 3500ms)
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: true,
        isOwner: false,
        hasThermalPrinter: false,
        isHiddenTab: false,
        hasDocument: true,
      }),
    ).toEqual({
      canBrowserFallback: true,
      claimHeadStartMs: 0,
      browserFallbackHeadStartMs: 2_500,
    });
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: true,
        isOwner: false,
        hasThermalPrinter: false,
        isHiddenTab: true,
        hasDocument: true,
      }).browserFallbackHeadStartMs,
    ).toBe(3_500);

    // Tier 4: Owner personal device or unlinked non-reception browser NEVER uses browser fallback
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: true,
        isStoreAlertRecipient: false,
        isOwner: true,
        hasThermalPrinter: false,
        isHiddenTab: false,
        hasDocument: true,
      }).canBrowserFallback,
    ).toBe(false);
    expect(
      computeStoreOrderAlertTimingPolicy({
        isAutoPrintActive: false,
        isStoreAlertRecipient: true,
        isOwner: false,
        hasThermalPrinter: false,
        isHiddenTab: false,
        hasDocument: true,
      }).canBrowserFallback,
    ).toBe(false);
  });

  it("ignores legacy localStorage '0' disable setting and purges it on write", () => {
    const store = new Map<string, string>([[STORE_ORDER_AUTOPRINT_STATION_KEY, "0"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
      dispatchEvent: vi.fn(),
    });
    try {
      expect(readStoreOrderAutoPrintStationSetting()).toBe(true);
      setStoreOrderAutoPrintStationSetting(false);
      expect(store.has(STORE_ORDER_AUTOPRINT_STATION_KEY)).toBe(false);
      expect(readStoreOrderAutoPrintStationSetting()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives Reception+thermal immediate priority over Cashier+thermal, fails over on error, and prevents printer-less/owner sessions from claiming", async () => {
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

    const orderPayload = { orderId: 404, orderNumber: "ORD-PRIO-404", totalAmount: "45000" };

    // Part A: Reception+thermal beats Cashier+thermal even if Cashier event arrives slightly earlier
    let orderClaimed = false;
    let orderConfirmed = false;
    const claimOrder = async () => {
      if (orderConfirmed) return { claimed: false, alreadyPrinted: true };
      if (orderClaimed) return { claimed: false, alreadyPrinted: false };
      orderClaimed = true;
      return { claimed: true, leaseToken: "lease-404", orderNumber: "ORD-PRIO-404", total: "45000", itemCount: 2 };
    };
    const receptionPrint = vi.fn().mockResolvedValue("printed" as const);
    const cashierPrint = vi.fn().mockResolvedValue("printed" as const);
    const ownerNoPrinterClaim = vi.fn(async () => ({ claimed: true }));
    const ownerNoPrinterPrint = vi.fn().mockResolvedValue("printed" as const);

    const receptionPolicy = computeStoreOrderAlertTimingPolicy({
      isAutoPrintActive: true,
      isStoreAlertRecipient: true,
      isOwner: false,
      hasThermalPrinter: true,
      isHiddenTab: false,
      hasDocument: true,
    });
    const cashierPolicy = computeStoreOrderAlertTimingPolicy({
      isAutoPrintActive: true,
      isStoreAlertRecipient: false,
      isOwner: false,
      hasThermalPrinter: true,
      isHiddenTab: false,
      hasDocument: true,
    });
    const ownerNoPrinterPolicy = computeStoreOrderAlertTimingPolicy({
      isAutoPrintActive: true,
      isStoreAlertRecipient: false,
      isOwner: true,
      hasThermalPrinter: false,
      isHiddenTab: false,
      hasDocument: true,
    });

    const receptionStation = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      canBrowserFallback: () => receptionPolicy.canBrowserFallback,
      claimHeadStartMs: receptionPolicy.claimHeadStartMs,
      browserFallbackHeadStartMs: receptionPolicy.browserFallbackHeadStartMs,
      claim: claimOrder,
      confirm: async () => { orderConfirmed = true; },
      release: async () => { orderClaimed = false; },
      print: receptionPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const cashierStation = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      canBrowserFallback: () => cashierPolicy.canBrowserFallback,
      claimHeadStartMs: cashierPolicy.claimHeadStartMs,
      browserFallbackHeadStartMs: cashierPolicy.browserFallbackHeadStartMs,
      claim: claimOrder,
      confirm: async () => { orderConfirmed = true; },
      release: async () => { orderClaimed = false; },
      print: cashierPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const ownerPersonalDevice = createStoreOrderAlertCoordinator({
      hasPrinter: async () => false,
      canBrowserFallback: () => ownerNoPrinterPolicy.canBrowserFallback,
      claimHeadStartMs: ownerNoPrinterPolicy.claimHeadStartMs,
      browserFallbackHeadStartMs: ownerNoPrinterPolicy.browserFallbackHeadStartMs,
      claim: ownerNoPrinterClaim,
      release: async () => {},
      print: ownerNoPrinterPrint,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const pOwner = ownerPersonalDevice.handleEvent(orderPayload);
    const pCashier = cashierStation.handleEvent(orderPayload);
    const pReception = receptionStation.handleEvent(orderPayload);

    await advanceTo(5_000);
    await Promise.all([pOwner, pCashier, pReception]);

    expect(receptionPrint).toHaveBeenCalledTimes(1);
    expect(cashierPrint).not.toHaveBeenCalled();
    expect(ownerNoPrinterClaim).not.toHaveBeenCalled();
    expect(ownerNoPrinterPrint).not.toHaveBeenCalled();

    // Part B: Reception hardware fails and releases -> Cashier backup claims and prints; Owner personal device still NEVER claims
    let order2Claimed = false;
    let order2Confirmed = false;
    const order2Payload = { orderId: 405, orderNumber: "ORD-PRIO-405", totalAmount: "18000" };
    let cashierStation2!: ReturnType<typeof createStoreOrderAlertCoordinator>;
    const receptionPrintFail = vi.fn().mockResolvedValue("hardware_error" as const);
    const cashierPrintOk = vi.fn().mockResolvedValue("printed" as const);

    const claimOrder2 = async () => {
      if (order2Confirmed) return { claimed: false, alreadyPrinted: true };
      if (order2Claimed) return { claimed: false, alreadyPrinted: false };
      order2Claimed = true;
      return { claimed: true, leaseToken: "lease-405", orderNumber: "ORD-PRIO-405", total: "18000", itemCount: 1 };
    };
    const releaseOrder2 = async (orderId: number) => {
      order2Claimed = false;
      void cashierStation2.handleEvent({ ...order2Payload, orderId, alertPrintHandoff: true });
    };

    const receptionStation2 = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      canBrowserFallback: () => receptionPolicy.canBrowserFallback,
      claimHeadStartMs: receptionPolicy.claimHeadStartMs,
      claim: claimOrder2,
      release: releaseOrder2,
      print: receptionPrintFail,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });
    cashierStation2 = createStoreOrderAlertCoordinator({
      hasPrinter: async () => true,
      canBrowserFallback: () => cashierPolicy.canBrowserFallback,
      claimHeadStartMs: cashierPolicy.claimHeadStartMs,
      claim: claimOrder2,
      confirm: async () => { order2Confirmed = true; },
      release: async () => { order2Claimed = false; },
      print: cashierPrintOk,
      now: () => nowMs,
      scheduleRetry: scheduleFn,
      cancelRetry: cancelFn,
    });

    const pOwner2 = ownerPersonalDevice.handleEvent(order2Payload);
    const pRec2 = receptionStation2.handleEvent(order2Payload);
    const pCash2 = cashierStation2.handleEvent(order2Payload);
    await advanceTo(10_000);
    await Promise.all([pOwner2, pRec2, pCash2]);

    expect(receptionPrintFail).toHaveBeenCalledTimes(1);
    expect(cashierPrintOk).toHaveBeenCalledTimes(1);
    expect(ownerNoPrinterClaim).not.toHaveBeenCalled();

    receptionStation.dispose();
    cashierStation.dispose();
    receptionStation2.dispose();
    cashierStation2.dispose();
    ownerPersonalDevice.dispose();
  });

  it("enforces Always-On server/client contracts, no disable toggle in UI, and reactive USB change notifications", async () => {
    const fs = await import("node:fs");
    const globalSource = fs.readFileSync("client/src/components/store-admin/GlobalStoreOrderAutoPrint.tsx", "utf8");
    const barSource = fs.readFileSync("client/src/components/store-admin/StoreOrderAutoPrintBar.tsx", "utf8");
    const fulfillmentSource = fs.readFileSync("client/src/pages/OrderFulfillment.tsx", "utf8");
    const routerSource = fs.readFileSync("server/routers/storeAdminRouter.ts", "utf8");
    const thermalSource = fs.readFileSync("client/src/lib/printing/thermal.ts", "utf8");
    const hookSource = fs.readFileSync("client/src/hooks/usePrinterConnection.ts", "utf8");

    // 1. UI components have NO off-toggle and use non-disableable supervisory status badges
    for (const ui of [globalSource, barSource]) {
      expect(ui).not.toContain("إيقاف التلقائي");
      expect(ui).not.toContain("تفعيل الطباعة التلقائية هنا");
      expect(ui).not.toContain("setStoreOrderAutoPrintStationSetting");
      expect(ui).not.toContain("aria-pressed");
      expect(ui).toContain('role="status"');
    }

    // 2. StoreOrderAutoPrintBar retains silent USB connect & test slip buttons
    expect(barSource).toContain("ربط USB صامت");
    expect(barSource).toContain("اختبار القصاصة");
    expect(globalSource).toContain("ربط USB");

    // 3. GlobalStoreOrderAutoPrint clears legacy '0', gates polling/SSE idle exemption on canExecuteAutoPrint, and uses computeStoreOrderAlertTimingPolicy
    expect(globalSource).toContain("STORE_ORDER_AUTOPRINT_STATION_KEY");
    expect(globalSource).toContain("computeStoreOrderAlertTimingPolicy");
    expect(globalSource).toContain("canExecuteAutoPrint");
    expect(globalSource).toContain("const isAutoPrintStationActive = canAutoPrint");

    // 4. OrderFulfillment aligns its gate with canUserAutoPrintStoreOrders
    expect(fulfillmentSource).toContain("canUserAutoPrintStoreOrders(me.data)");

    // 5. Server router allows all storeFulfillProcedure users without requiring stationOptIn === true
    expect(routerSource).not.toContain("!isStoreOrderAlertRecipientUser(ctx.user)");
    expect(routerSource).toContain("pendingNotificationPrint: storeFulfillProcedure");
    expect(routerSource).toContain("claimNotificationPrint: storeFulfillProcedure");
    expect(routerSource).toContain("releaseNotificationPrint: storeFulfillProcedure");

    // 6. WebUSB slot changes notify all mounted usePrinterConnection listeners
    expect(thermalSource).toContain("THERMAL_PRINTER_CHANGE_EVENT");
    expect(hookSource).toContain("THERMAL_PRINTER_CHANGE_EVENT");

    // 7. Server bridge availability recovers after transient initial failure via reconnect + periodic probe
    expect(globalSource).toContain("subscribeServerBridgeAvailability");
    expect(globalSource).toContain("REALTIME_EVENT_TYPES.CONNECTED");
    expect(barSource).toContain("useServerBridgeAvailable");
  });

  it("recovers server bridge availability after a failed initial probe via reconnect, visibility, and periodic checks", async () => {
    const windowTarget = new EventTarget();
    const docTarget = new EventTarget() as EventTarget & { visibilityState: string };
    docTarget.visibilityState = "visible";

    const intervalCallbacks: Array<() => void> = [];
    const clearIntervalFn = vi.fn();
    const setIntervalFn = vi.fn((cb: () => void) => {
      intervalCallbacks.push(cb);
      return 42 as unknown as ReturnType<typeof setInterval>;
    });

    const probeResults = [false, true, false, true, true];
    const probe = vi.fn(async (_force?: boolean) => probeResults.shift() ?? true);
    const states: boolean[] = [];

    const controller = subscribeServerBridgeAvailability({
      probe,
      onChange: (enabled) => states.push(enabled),
      intervalMs: 30_000,
      eventTarget: windowTarget,
      visibilityTarget: docTarget,
      setIntervalFn,
      clearIntervalFn,
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(probe).toHaveBeenNthCalledWith(1, false);
    expect(states).toEqual([false]);

    // Network online reconnect forces fresh probe -> recovers to true
    windowTarget.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 0));
    expect(probe).toHaveBeenNthCalledWith(2, true);
    expect(states).toEqual([false, true]);

    // Periodic timer tick forces fresh probe even when no browser/USB events occur
    expect(intervalCallbacks).toHaveLength(1);
    intervalCallbacks[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(probe).toHaveBeenNthCalledWith(3, true);
    expect(states).toEqual([false, true, false]);

    // Explicit refresh(true) (e.g. SSE CONNECTED) recovers immediately
    controller.refresh(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(probe).toHaveBeenNthCalledWith(4, true);
    expect(states).toEqual([false, true, false, true]);

    // THERMAL_PRINTER_CHANGE_EVENT + visibility/focus events work while active and stop after dispose()
    windowTarget.dispatchEvent(new Event(THERMAL_PRINTER_CHANGE_EVENT));
    await new Promise((r) => setTimeout(r, 0));
    expect(probe).toHaveBeenCalledTimes(5);

    controller.dispose();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    windowTarget.dispatchEvent(new Event("online"));
    docTarget.dispatchEvent(new Event("visibilitychange"));
    controller.refresh(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(probe).toHaveBeenCalledTimes(5);
  });
});
