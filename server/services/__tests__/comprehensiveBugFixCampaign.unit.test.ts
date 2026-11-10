import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeSessionsSummary, buildDefaultSplitSessions } from "@shared/attendanceHours";
import { OPERATION_PERMISSIONS } from "@shared/operationPermissions";
import {
  computePartyExposure,
  deriveCashInHandFromLedger,
  deriveShortfallOwedFromLedger,
} from "@shared/partyExposure";
import { canSeeGate } from "@/lib/navVisibility";
import {
  buildCourierAddressUpdateMessage,
  buildCourierAssignmentMessage,
  buildCourierUrgentDispatchMessage,
} from "@/lib/whatsapp";
import {
  DEFAULT_FORM,
  storefrontCheckoutFingerprint,
} from "@/components/storefront/storefrontPersistence";
import { type CartLine } from "@/components/storefront/storefrontCartMath";
import {
  computeAttendancePay,
  DEFAULT_WORK_SCHEDULE,
} from "../hr/attendancePay";
import { assertBundleEditShape } from "../catalog/productUpdateGuards";

describe("Comprehensive Multi-Wave Bug-Fix Campaign Regressions (BUG-001..BUG-050)", () => {
  describe("Wave 1 — HR Attendance Statement, Hourly Pay Parity & Night Split-Shift", () => {
    it("BUG-001 / BUG-002 / BUG-025: caps live current-month attendance at asOfDate, surfaces Friday restDay, and treats active today check-in as inProgress", () => {
      const attended = new Map<string, Decimal>([
        ["2026-11-01", new Decimal(8)],
        ["2026-11-02", new Decimal("8.68")],
        ["2026-11-03", new Decimal("11.36")],
        ["2026-11-04", new Decimal("9.11")],
        ["2026-11-05", new Decimal("10.14")],
      ]);

      const res = computeAttendancePay({
        salary: new Decimal(600000),
        employmentStart: "2026-11-01",
        employmentEnd: "2026-11-30",
        monthStart: "2026-11-01",
        monthEnd: "2026-11-30",
        schedule: DEFAULT_WORK_SCHEDULE,
        attendedHoursByDate: attended,
        paidLeaveDates: new Set<string>(),
        unpaidLeaveDates: new Set<string>(),
        openDates: new Set<string>(["2026-11-07"]),
        inProgressDates: new Set<string>(["2026-11-07"]),
        payFrom: "2026-08-01",
        asOfDate: "2026-11-07",
        includeRestDays: true,
      });

      expect(res.isPartialMonth).toBe(true);
      expect(res.absentDays).toBe(0);
      expect(res.openDays).toBe(0);
      expect(res.scheduledHours).toBe("208.00");
      expect(res.scheduledHoursToDate).toBe("48.00");

      const fridayRow = res.days.find((d) => d.date === "2026-11-06");
      expect(fridayRow?.state).toBe("restDay");
      expect(fridayRow?.scheduledHours).toBe("0.00");

      const todayRow = res.days.find((d) => d.date === "2026-11-07");
      expect(todayRow?.state).toBe("inProgress");

      expect(res.days.some((d) => d.date > "2026-11-07")).toBe(false);
    });

    it("BUG-003: hourly payType computes all worked hours at 1.0x without 1.5x overtime split", () => {
      const res = computeAttendancePay({
        salary: new Decimal(0),
        payType: "hourly",
        dayRates: { الأحد: 5000 },
        employmentStart: "2026-11-01",
        employmentEnd: "2026-11-01",
        monthStart: "2026-11-01",
        monthEnd: "2026-11-30",
        schedule: DEFAULT_WORK_SCHEDULE,
        attendedHoursByDate: new Map([["2026-11-01", new Decimal(10)]]),
        paidLeaveDates: new Set(),
        unpaidLeaveDates: new Set(),
        payFrom: "2026-08-01",
      });

      expect(res.overtimeHours).toBe("0.00");
      expect(res.overtimePay).toBe("0.00");
      expect(res.basePay).toBe("50000.00");
      expect(res.days[0]?.totalAmount).toBe("50000.00");
    });

    it("BUG-026: night split shift whose break crosses midnight validates cleanly without false overlap", () => {
      const split = buildDefaultSplitSessions("20:00", "03:00", { crossMidnight: true });
      const summary = computeSessionsSummary(split);
      expect(summary.violation).toBeNull();
      expect(summary.sessions).toHaveLength(2);
      expect(summary.totalHours).toBeGreaterThan(0);
    });
  });

  describe("Wave 2 — Operation Policy Module Level & Manager Gates", () => {
    it("BUG-008: canSeeGate enforces FULL mutation level on module gates and managerOnly when module/operations are omitted", () => {
      const readProductOp = OPERATION_PERMISSIONS.find(
        (op) =>
          op.delegable &&
          (op.navigationModule ?? op.module)?.split("|").includes("products") &&
          op.kind === "query" &&
          op.level === "READ",
      );
      const writeProductOp = OPERATION_PERMISSIONS.find(
        (op) =>
          op.delegable &&
          (op.navigationModule ?? op.module)?.split("|").includes("products") &&
          op.kind === "mutation",
      );
      expect(readProductOp).toBeDefined();
      expect(writeProductOp).toBeDefined();

      const readOnlyPolicy = {
        grants: {
          [readProductOp!.key]: true,
        },
        dataVisibility: { purchaseCost: true, profitMargin: true },
      };
      const writePolicy = {
        grants: {
          [readProductOp!.key]: true,
          [writeProductOp!.key]: true,
        },
        dataVisibility: { purchaseCost: true, profitMargin: true },
      };

      expect(
        canSeeGate(
          { module: "products", level: "READ" },
          "cashier",
          null,
          readOnlyPolicy as any,
        ),
      ).toBe(true);

      expect(
        canSeeGate(
          { module: "products", level: "FULL" },
          "cashier",
          null,
          readOnlyPolicy as any,
        ),
      ).toBe(false);

      expect(
        canSeeGate(
          { module: "products", level: "FULL" },
          "cashier",
          null,
          writePolicy as any,
        ),
      ).toBe(true);

      expect(
        canSeeGate(
          { managerOnly: true },
          "cashier",
          null,
          writePolicy as any,
        ),
      ).toBe(false);

      expect(
        canSeeGate(
          { managerOnly: true },
          "manager",
          null,
          writePolicy as any,
        ),
      ).toBe(true);
    });
  });

  describe("Wave 3B — Bundle Shape Invariants", () => {
    it("BUG-017: assertBundleEditShape rejects setting isService or showInPrintPos on bundle products", () => {
      expect(() =>
        assertBundleEditShape({ isBundle: true }, 1, 1, { isService: true }),
      ).toThrow();
      expect(() =>
        assertBundleEditShape({ isBundle: true }, 1, 1, { showInPrintPos: true }),
      ).toThrow();
      expect(() =>
        assertBundleEditShape({ isBundle: true }, 1, 1, {
          isService: false,
          showInPrintPos: false,
        }),
      ).not.toThrow();
    });
  });

  describe("Wave 4 — Storefront Coordinates, Courier WhatsApp Maps Links & Delivery Shortfall Ledger", () => {
    it("BUG-020 / BUG-039: storefrontCheckoutFingerprint distinguishes delivery pin coordinates and notes", () => {
      const cart = new Map<string, CartLine>([
        [
          "101",
          {
            cartKey: "101",
            productUnitId: 101,
            productId: 10,
            name: "دفتر جامعي",
            unitName: "قطعة",
            price: "2500.00",
            qty: 2,
            stockLimit: 20,
            imageUrl: null,
          },
        ],
      ]);

      const fpWithoutCoords = storefrontCheckoutFingerprint(cart, {
        ...DEFAULT_FORM,
        name: "علي محمد",
        phone: "+9647701234567",
        address: "بغداد - الكرادة",
        notes: "",
        latitude: null,
        longitude: null,
      });

      const fpWithCoords = storefrontCheckoutFingerprint(cart, {
        ...DEFAULT_FORM,
        name: "علي محمد",
        phone: "+9647701234567",
        address: "بغداد - الكرادة",
        notes: "",
        latitude: 33.3152,
        longitude: 44.3661,
      });

      const fpWithUpdatedNotes = storefrontCheckoutFingerprint(cart, {
        ...DEFAULT_FORM,
        name: "علي محمد",
        phone: "+9647701234567",
        address: "بغداد - الكرادة",
        notes: "قرب التقاطع",
        latitude: 33.3152,
        longitude: 44.3661,
      });

      expect(fpWithoutCoords).not.toBe(fpWithCoords);
      expect(fpWithCoords).not.toBe(fpWithUpdatedNotes);
    });

    it("BUG-020 / BUG-050: courier WhatsApp builders embed Google Maps URL when valid coordinates exist and omit (0, 0)", () => {
      const assignMsg = buildCourierAssignmentMessage({
        consignmentNumber: "CN-101",
        orderNumber: "ON-55",
        customerName: "أحمد",
        deliveryAddress: "الكرادة الشرقية",
        latitude: 33.3152,
        longitude: 44.3661,
        codAmount: 25000,
      });
      expect(assignMsg).toContain(
        "موقع الخريطة: https://www.google.com/maps/search/?api=1&query=33.3152,44.3661",
      );

      const urgentZeroMsg = buildCourierUrgentDispatchMessage({
        consignmentNumber: "CN-102",
        deliveryAddress: "المنصور",
        latitude: 0,
        longitude: 0,
        codAmount: 15000,
      });
      expect(urgentZeroMsg).not.toContain("موقع الخريطة:");

      const updateMsg = buildCourierAddressUpdateMessage({
        consignmentNumber: "CN-103",
        newAddress: "زيونة محلة 710",
        latitude: "33.3265",
        longitude: "44.4541",
      });
      expect(updateMsg).toContain(
        "موقع الخريطة: https://www.google.com/maps/search/?api=1&query=33.3265,44.4541",
      );
    });

    it("BUG-021: splitting loose shortfall + cash remittance keeps ledger cash and shortfallOwed reconciled 1:1", () => {
      const ledger = [
        { entryType: "COD_COLLECTED", amount: "30000.00" },
        { entryType: "SHORTFALL_ASSIGNED", amount: "10000.00" },
        // Courier remits 25,000 loose: 10,000 closes shortfall, 15,000 remits physical cash
        { entryType: "SHORTFALL_SETTLED", amount: "10000.00" },
        { entryType: "COD_REMITTED", amount: "15000.00" },
      ];

      const totalCustodyFromLedger = deriveCashInHandFromLedger(ledger);
      const shortfallOwed = deriveShortfallOwedFromLedger(ledger);
      expect(totalCustodyFromLedger).toBe("15000.00");
      expect(shortfallOwed).toBe("0.00");

      const exposure = computePartyExposure({
        cashInHand: "15000.00",
        parcels: [],
        ledger,
      });
      expect(exposure.shortfallOwed).toBe("0.00");
      expect(exposure.cashInHand).toBe("15000.00");
      expect(exposure.netResponsibility).toBe("15000.00");
    });
  });
});
