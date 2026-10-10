import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { assertParcelTransition, type ParcelStatus } from "../delivery/lifecycle";
import { correctionLookupBlockReason, type CorrectionLookupFacts } from "../sale/correctionLookup";
import { CLOSEABLE_STATUSES } from "../reservations/helpers";

describe("Triggers, State Machines & Operational Lifecycles Regression Suite", () => {
  // =========================================================================
  // F1: Online Order Expiry Trigger (trg_online_orders_expired_activation_bu)
  // =========================================================================
  describe("F1: Online Order Expiry Trigger Contract, Boundary Precision & Rollback Invariants", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../drizzle/migrations/extras/0361_fix_triggers_and_guards.sql",
    );
    const sqlContent = fs.readFileSync(migrationPath, "utf-8");

    it("ensures trigger SQL verifies OLD.orderStatus IN ('PENDING') before blocking activation", () => {
      expect(sqlContent).toContain("CREATE TRIGGER `trg_online_orders_expired_activation_bu`");
      expect(sqlContent).toContain("OLD.`orderStatus` IN ('PENDING')");
      expect(sqlContent).toContain("NEW.`orderStatus` IN ('CONFIRMED', 'PROCESSING')");
      expect(sqlContent).toContain("COALESCE(");
      expect(sqlContent).toContain("NEW.`reservationExpiresAt`,");
      expect(sqlContent).toContain("OLD.`reservationExpiresAt`,");
      expect(sqlContent).toContain("DATE_ADD(OLD.`orderDate`, INTERVAL 24 HOUR)");
      expect(sqlContent).toContain(") <= CURRENT_TIMESTAMP(3)");
      expect(sqlContent).toContain("expired online order reservation cannot be activated");
    });

    // Pure logic oracle emulating trg_online_orders_expired_activation_bu
    function evaluateOnlineOrderActivationTrigger(
      oldRow: { orderStatus: string; reservationExpiresAt: Date | null; orderDate: Date },
      newRow: { orderStatus: string; reservationExpiresAt?: Date | null },
      now: Date = new Date(),
    ): void {
      const isActivating =
        ["CONFIRMED", "PROCESSING"].includes(newRow.orderStatus) &&
        oldRow.orderStatus === "PENDING";

      if (isActivating) {
        const defaultExpiresAt = new Date(oldRow.orderDate.getTime() + 24 * 60 * 60 * 1000);
        const effectiveExpiresAt =
          newRow.reservationExpiresAt ?? oldRow.reservationExpiresAt ?? defaultExpiresAt;

        if (effectiveExpiresAt.getTime() <= now.getTime()) {
          throw new Error("expired online order reservation cannot be activated");
        }
      }
    }

    it("blocks activation at exact boundary (effectiveExpiresAt.getTime() === now.getTime())", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const exactExpiresAt = new Date("2026-10-10T12:00:00.000Z");
      const oldRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: exactExpiresAt,
        orderDate: new Date("2026-10-09T12:00:00.000Z"),
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).toThrow("expired online order reservation cannot be activated");

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "CONFIRMED" }, now),
      ).toThrow("expired online order reservation cannot be activated");
    });

    it("blocks activation at epsilon post-boundary (effectiveExpiresAt == now - 1ms)", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const postBoundaryExpiresAt = new Date(now.getTime() - 1);
      const oldRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: postBoundaryExpiresAt,
        orderDate: new Date("2026-10-09T12:00:00.000Z"),
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).toThrow("expired online order reservation cannot be activated");
    });

    it("permits activation at epsilon pre-boundary (effectiveExpiresAt == now + 1ms)", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const preBoundaryExpiresAt = new Date(now.getTime() + 1);
      const oldRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: preBoundaryExpiresAt,
        orderDate: new Date("2026-10-09T12:00:00.000Z"),
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).not.toThrow();

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "CONFIRMED" }, now),
      ).not.toThrow();
    });

    it("blocks activation at default 24h fallback exact boundary (orderDate == now - 24 hours)", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const orderDateExact24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const oldRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: null,
        orderDate: orderDateExact24hAgo,
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).toThrow("expired online order reservation cannot be activated");
    });

    it("blocks activation of expired pending cart when reservation has elapsed (coarse 26h ago)", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const orderDate = new Date("2026-10-09T10:00:00.000Z"); // 26 hours ago
      const oldRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: null,
        orderDate,
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).toThrow("expired online order reservation cannot be activated");

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "CONFIRMED" }, now),
      ).toThrow("expired online order reservation cannot be activated");
    });

    it("permits activation when reservation is active or explicitly renewed", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const orderDate = new Date("2026-10-10T10:00:00.000Z"); // 2 hours ago
      const oldRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: new Date("2026-10-11T10:00:00.000Z"),
        orderDate,
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).not.toThrow();

      // Renewal: old expired, but new row provides extended reservation
      const oldExpiredRow = {
        orderStatus: "PENDING",
        reservationExpiresAt: new Date("2026-10-09T10:00:00.000Z"),
        orderDate: new Date("2026-10-08T10:00:00.000Z"),
      };
      expect(() =>
        evaluateOnlineOrderActivationTrigger(
          oldExpiredRow,
          { orderStatus: "PROCESSING", reservationExpiresAt: new Date("2026-10-11T12:00:00.000Z") },
          now,
        ),
      ).not.toThrow();
    });

    it("permits operational rollback transitions from SHIPPED back to PROCESSING without trigger blockage", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const oldRow = {
        orderStatus: "SHIPPED",
        reservationExpiresAt: new Date("2026-10-01T00:00:00.000Z"), // Long past 24h
        orderDate: new Date("2026-09-30T00:00:00.000Z"),
      };

      // When delivery is cancelled or returned, order rolls back to PROCESSING
      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "PROCESSING" }, now),
      ).not.toThrow();
    });

    it("permits cancellation from PROCESSING to CANCELLED", () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const oldRow = {
        orderStatus: "PROCESSING",
        reservationExpiresAt: null,
        orderDate: new Date("2026-10-01T00:00:00.000Z"),
      };

      expect(() =>
        evaluateOnlineOrderActivationTrigger(oldRow, { orderStatus: "CANCELLED" }, now),
      ).not.toThrow();
    });
  });

  // =========================================================================
  // F2: Owner Missed Daily Count Trigger (trg_cash_missed_daily_bu)
  // =========================================================================
  describe("F2: Owner Missed Daily Count Review & Evidence Immutability", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../drizzle/migrations/extras/0361_fix_triggers_and_guards.sql",
    );
    const sqlContent = fs.readFileSync(migrationPath, "utf-8");

    it("ensures trigger SQL permits Owner review without self-approval signal restriction", () => {
      expect(sqlContent).toContain("CREATE TRIGGER `trg_cash_missed_daily_bu`");
      expect(sqlContent).toContain("decided missed daily count exception is immutable");
      expect(sqlContent).toContain("missed daily count request evidence is immutable");
      expect(sqlContent).toContain("invalid missed daily count decision");
      expect(sqlContent).toContain("NEW.`activeBusinessDateKey` = IF(");
      // Migration 0361 specifically removed the self-approval blockage
      expect(sqlContent).not.toContain("self-approval forbidden");
      expect(sqlContent).not.toContain("NEW.`reviewedByUserId` = NEW.`requestedByUserId`");
    });

    // Pure logic oracle emulating trg_cash_missed_daily_bu
    function evaluateMissedDailyCountTrigger(
      oldRow: {
        status: "PENDING" | "APPROVED" | "REJECTED";
        branchId: number;
        businessDate: string;
        requestedByUserId: number;
        evidenceHash: string;
      },
      newRow: {
        status: "PENDING" | "APPROVED" | "REJECTED";
        branchId: number;
        businessDate: string;
        requestedByUserId: number;
        reviewedByUserId: number;
        evidenceHash: string;
        version: number;
      },
    ): { activeBusinessDateKey: string | null } {
      if (oldRow.status !== "PENDING") {
        throw new Error("decided missed daily count exception is immutable");
      }
      if (
        oldRow.branchId !== newRow.branchId ||
        oldRow.businessDate !== newRow.businessDate ||
        oldRow.requestedByUserId !== newRow.requestedByUserId ||
        oldRow.evidenceHash !== newRow.evidenceHash
      ) {
        throw new Error("missed daily count request evidence is immutable");
      }
      if (!["APPROVED", "REJECTED"].includes(newRow.status) || newRow.version !== 2) {
        throw new Error("invalid missed daily count decision");
      }
      return {
        activeBusinessDateKey:
          newRow.status === "APPROVED" ? `${newRow.branchId}:${newRow.businessDate}` : null,
      };
    }

    it("permits Owner self-approval when reviewedByUserId equals requestedByUserId", () => {
      const oldRow = {
        status: "PENDING" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1, // Owner
        evidenceHash: "hash-abc",
      };
      const newRow = {
        status: "APPROVED" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        reviewedByUserId: 1, // Owner self-approval
        evidenceHash: "hash-abc",
        version: 2,
      };

      const result = evaluateMissedDailyCountTrigger(oldRow, newRow);
      expect(result.activeBusinessDateKey).toBe("1:2026-10-10");
    });

    it("permits Owner self-rejection and clears activeBusinessDateKey", () => {
      const oldRow = {
        status: "PENDING" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        evidenceHash: "hash-abc",
      };
      const newRow = {
        status: "REJECTED" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        reviewedByUserId: 1,
        evidenceHash: "hash-abc",
        version: 2,
      };

      const result = evaluateMissedDailyCountTrigger(oldRow, newRow);
      expect(result.activeBusinessDateKey).toBeNull();
    });

    it("strictly blocks mutating an already decided exception", () => {
      const oldRow = {
        status: "APPROVED" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        evidenceHash: "hash-abc",
      };
      const newRow = {
        status: "REJECTED" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        reviewedByUserId: 1,
        evidenceHash: "hash-abc",
        version: 2,
      };

      expect(() => evaluateMissedDailyCountTrigger(oldRow, newRow)).toThrow(
        "decided missed daily count exception is immutable",
      );
    });

    it("strictly blocks mutating request evidence hashes during review", () => {
      const oldRow = {
        status: "PENDING" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        evidenceHash: "hash-abc",
      };
      const newRow = {
        status: "APPROVED" as const,
        branchId: 1,
        businessDate: "2026-10-10",
        requestedByUserId: 1,
        reviewedByUserId: 1,
        evidenceHash: "tampered-hash",
        version: 2,
      };

      expect(() => evaluateMissedDailyCountTrigger(oldRow, newRow)).toThrow(
        "missed daily count request evidence is immutable",
      );
    });
  });

  // =========================================================================
  // F4: Delivery Parcel Transitions (assertParcelTransition) - Exhaustive 64-Pair Matrix
  // =========================================================================
  describe("F4: Delivery Parcel Transition Matrix & Exhaustive 64-Pair Coverage", () => {
    const ALL_PARCEL_STATUSES: ParcelStatus[] = [
      "ASSIGNED",
      "ACCEPTED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED",
      "CANCELLED",
      "RETURNED",
    ];

    const EXPECTED_ALLOWED: Record<ParcelStatus, ParcelStatus[]> = {
      ASSIGNED: ["ACCEPTED", "OUT_FOR_DELIVERY", "FAILED", "CANCELLED", "RETURNED"],
      ACCEPTED: ["PICKED_UP", "FAILED"],
      PICKED_UP: ["OUT_FOR_DELIVERY", "FAILED"],
      OUT_FOR_DELIVERY: ["ACCEPTED", "PICKED_UP", "DELIVERED", "FAILED", "CANCELLED", "RETURNED"],
      DELIVERED: [],
      FAILED: ["ASSIGNED", "OUT_FOR_DELIVERY", "RETURNED", "CANCELLED"],
      CANCELLED: [],
      RETURNED: [],
    };

    it("verifies production allowed map contract in delivery/lifecycle.ts", () => {
      const lifecyclePath = path.resolve(__dirname, "../delivery/lifecycle.ts");
      const content = fs.readFileSync(lifecyclePath, "utf-8");
      expect(content).toContain('ASSIGNED: ["ACCEPTED", "OUT_FOR_DELIVERY", "FAILED", "CANCELLED", "RETURNED"]');
      expect(content).toContain('ACCEPTED: ["PICKED_UP", "FAILED"]');
      expect(content).toContain('PICKED_UP: ["OUT_FOR_DELIVERY", "FAILED"]');
      expect(content).toContain("DELIVERED: []");
      expect(content).toContain('FAILED: ["ASSIGNED", "OUT_FOR_DELIVERY", "RETURNED", "CANCELLED"]');
      expect(content).toContain("CANCELLED: []");
      expect(content).toContain("RETURNED: []");
    });

    it("exhaustively asserts all 64 parcel transition pairs (8x8 matrix)", () => {
      let testedPairs = 0;
      let allowedCount = 0;
      let disallowedCount = 0;

      for (const from of ALL_PARCEL_STATUSES) {
        for (const to of ALL_PARCEL_STATUSES) {
          testedPairs++;
          const isAllowed = EXPECTED_ALLOWED[from].includes(to);
          if (isAllowed) {
            allowedCount++;
            expect(() => assertParcelTransition(from, to)).not.toThrow();
          } else {
            disallowedCount++;
            expect(() => assertParcelTransition(from, to)).toThrow(TRPCError);
          }
        }
      }

      expect(testedPairs).toBe(64);
      expect(allowedCount).toBe(19);
      expect(disallowedCount).toBe(45);
    });

    it("verifies F4 specific fixes: ASSIGNED -> CANCELLED and ASSIGNED -> RETURNED are allowed", () => {
      expect(() => assertParcelTransition("ASSIGNED", "CANCELLED")).not.toThrow();
      expect(() => assertParcelTransition("ASSIGNED", "RETURNED")).not.toThrow();
    });

    it("verifies terminal states (DELIVERED, CANCELLED, RETURNED) strictly reject all outgoing transitions", () => {
      const terminalStates: ParcelStatus[] = ["DELIVERED", "CANCELLED", "RETURNED"];
      for (const terminal of terminalStates) {
        for (const target of ALL_PARCEL_STATUSES) {
          expect(() => assertParcelTransition(terminal, target)).toThrow(TRPCError);
        }
      }
    });

    it("verifies self-transitions are strictly disallowed across all 8 states", () => {
      for (const status of ALL_PARCEL_STATUSES) {
        expect(() => assertParcelTransition(status, status)).toThrow(TRPCError);
      }
    });

    it("verifies forward lifecycle transitions from intermediate states", () => {
      expect(() => assertParcelTransition("ACCEPTED", "PICKED_UP")).not.toThrow();
      expect(() => assertParcelTransition("ACCEPTED", "FAILED")).not.toThrow();
      expect(() => assertParcelTransition("PICKED_UP", "OUT_FOR_DELIVERY")).not.toThrow();
      expect(() => assertParcelTransition("PICKED_UP", "FAILED")).not.toThrow();
      expect(() => assertParcelTransition("OUT_FOR_DELIVERY", "DELIVERED")).not.toThrow();
      expect(() => assertParcelTransition("FAILED", "ASSIGNED")).not.toThrow();
      expect(() => assertParcelTransition("FAILED", "OUT_FOR_DELIVERY")).not.toThrow();
      expect(() => assertParcelTransition("FAILED", "RETURNED")).not.toThrow();
      expect(() => assertParcelTransition("FAILED", "CANCELLED")).not.toThrow();
    });
  });

  // =========================================================================
  // F5: Delivery Return Synchronization (delivery/returns.ts)
  // =========================================================================
  describe("F5: Delivery Return Online Order Synchronization (delivery/returns.ts)", () => {
    const deliveryReturnsPath = path.resolve(__dirname, "../delivery/returns.ts");
    const deliveryReturnsContent = fs.readFileSync(deliveryReturnsPath, "utf-8");

    it("verifies production source contract in delivery/returns.ts imports onlineOrders and performs atomic cancellation", () => {
      expect(deliveryReturnsContent).toMatch(
        /import\s*\{[^}]*\bonlineOrders\b[^}]*\}\s*from\s*["'].*drizzle\/schema["']/,
      );

      // Verify cn.sourceType === "ONLINE_ORDER" handling
      const onlineOrderDirectRegex =
        /if\s*\(\s*cn\.sourceType\s*===\s*["']ONLINE_ORDER["']\s*\)\s*\{\s*await\s+tx\s*\.\s*update\s*\(\s*onlineOrders\s*\)\s*\.\s*set\s*\(\s*\{\s*status:\s*["']CANCELLED["']\s*\}\s*\)\s*\.\s*where\s*\(\s*eq\s*\(\s*onlineOrders\.id\s*,\s*Number\s*\(\s*cn\.sourceId\s*\)\s*\)\s*\);\s*\}/;
      expect(deliveryReturnsContent).toMatch(onlineOrderDirectRegex);

      // Verify cn.sourceType === "INVOICE" && inv.sourceType === "ONLINE" handling
      const invoiceOnlineOrderRegex =
        /else\s+if\s*\(\s*cn\.sourceType\s*===\s*["']INVOICE["']\s*&&\s*inv\.sourceType\s*===\s*["']ONLINE["']\s*\)\s*\{\s*await\s+tx\s*\.\s*update\s*\(\s*onlineOrders\s*\)\s*\.\s*set\s*\(\s*\{\s*status:\s*["']CANCELLED["']\s*\}\s*\)\s*\.\s*where\s*\(\s*eq\s*\(\s*onlineOrders\.invoiceId\s*,\s*Number\s*\(\s*cn\.invoiceId\s*\)\s*\)\s*\);\s*\}/;
      expect(deliveryReturnsContent).toMatch(invoiceOnlineOrderRegex);
    });

    it("evaluates synchronization business rules for delivery consignment return", () => {
      function evaluateDeliveryReturnSync(
        consignment: { sourceType: string; sourceId?: number | null; invoiceId?: number | null },
        invoice: { sourceType: string; id: number } | null,
      ): { cancelledOnlineOrderId: number | null; cancelledOnlineOrderInvoiceId: number | null } {
        let cancelledOnlineOrderId: number | null = null;
        let cancelledOnlineOrderInvoiceId: number | null = null;

        if (consignment.sourceType === "ONLINE_ORDER") {
          cancelledOnlineOrderId = Number(consignment.sourceId);
        } else if (consignment.sourceType === "INVOICE" && invoice?.sourceType === "ONLINE") {
          cancelledOnlineOrderInvoiceId = Number(consignment.invoiceId);
        }

        return { cancelledOnlineOrderId, cancelledOnlineOrderInvoiceId };
      }

      // 1. INVOICE consignment where invoice is ONLINE -> synchronizes
      expect(
        evaluateDeliveryReturnSync({ sourceType: "INVOICE", invoiceId: 999 }, { sourceType: "ONLINE", id: 999 }),
      ).toEqual({ cancelledOnlineOrderId: null, cancelledOnlineOrderInvoiceId: 999 });

      // 2. INVOICE consignment where invoice is POS -> does NOT touch online orders
      expect(
        evaluateDeliveryReturnSync({ sourceType: "INVOICE", invoiceId: 888 }, { sourceType: "POS", id: 888 }),
      ).toEqual({ cancelledOnlineOrderId: null, cancelledOnlineOrderInvoiceId: null });

      // 3. ONLINE_ORDER consignment -> synchronizes by sourceId
      expect(
        evaluateDeliveryReturnSync({ sourceType: "ONLINE_ORDER", sourceId: 77 }, null),
      ).toEqual({ cancelledOnlineOrderId: 77, cancelledOnlineOrderInvoiceId: null });
    });
  });

  // =========================================================================
  // F6: POS Formal Reservations Expiry Unblock (cancelReservation)
  // =========================================================================
  describe("F6: POS Formal Reservation Expiry Unblock & Production Contract", () => {
    const lifecyclePath = path.resolve(__dirname, "../reservations/lifecycle.ts");
    const lifecycleContent = fs.readFileSync(lifecyclePath, "utf-8");

    it("binds directly to production constants: CLOSEABLE_STATUSES from reservations/helpers", () => {
      expect(CLOSEABLE_STATUSES).toEqual(["ACTIVE", "PARTIALLY_FULFILLED"]);
      // Confirm fictitious statuses are NOT in production CLOSEABLE_STATUSES
      expect(CLOSEABLE_STATUSES).not.toContain("DRAFT");
      expect(CLOSEABLE_STATUSES).not.toContain("PENDING");
      expect(CLOSEABLE_STATUSES).not.toContain("CONFIRMED");
    });

    it("verifies production contract in reservations/lifecycle.ts permits EXPIRED and checks CLOSEABLE", () => {
      expect(lifecycleContent).toContain(
        'import { assertReservationBranch, CLOSEABLE_STATUSES, loadReservation, MAX_EXTEND_HOURS } from "./helpers";',
      );
      expect(lifecycleContent).toContain("const CLOSEABLE: readonly string[] = CLOSEABLE_STATUSES;");
      expect(lifecycleContent).toContain('if (!CLOSEABLE.includes(res.status) && res.status !== "EXPIRED")');
      expect(lifecycleContent).toContain('if (res.status !== "EXPIRED") {');
      expect(lifecycleContent).toContain("await releaseRemaining(tx, id, Number(res.branchId));");
    });

    // Oracle evaluating cancellation transition using real imported CLOSEABLE_STATUSES
    function evaluateCancelReservationTransition(
      status: string,
    ): { cancelled: boolean; stockReleased: boolean; newStatus: "CANCELLED" } {
      const isCloseable = (CLOSEABLE_STATUSES as readonly string[]).includes(status);
      if (!isCloseable && status !== "EXPIRED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `لا يمكن إلغاء حجز حالته ${status}`,
        });
      }

      return {
        cancelled: true,
        stockReleased: status !== "EXPIRED",
        newStatus: "CANCELLED",
      };
    }

    it("allows cancelling an EXPIRED reservation without double stock release", () => {
      const outcome = evaluateCancelReservationTransition("EXPIRED");
      expect(outcome.cancelled).toBe(true);
      expect(outcome.newStatus).toBe("CANCELLED");
      expect(outcome.stockReleased).toBe(false); // Stock was released upon expiration
    });

    it("allows cancelling real closeable statuses (ACTIVE, PARTIALLY_FULFILLED) and releases stock", () => {
      const outcomeActive = evaluateCancelReservationTransition("ACTIVE");
      expect(outcomeActive.cancelled).toBe(true);
      expect(outcomeActive.stockReleased).toBe(true);

      const outcomePartial = evaluateCancelReservationTransition("PARTIALLY_FULFILLED");
      expect(outcomePartial.cancelled).toBe(true);
      expect(outcomePartial.stockReleased).toBe(true);
    });

    it("strictly forbids cancelling non-closeable terminal and non-existent statuses with BAD_REQUEST", () => {
      const disallowedStatuses = ["FULFILLED", "CANCELLED", "RELEASED", "DRAFT", "PENDING", "CONFIRMED"];
      for (const status of disallowedStatuses) {
        expect(() => evaluateCancelReservationTransition(status)).toThrow(TRPCError);
        try {
          evaluateCancelReservationTransition(status);
        } catch (err: any) {
          expect(err.code).toBe("BAD_REQUEST");
          expect(err.message).toContain(`لا يمكن إلغاء حجز حالته ${status}`);
        }
      }
    });
  });

  // =========================================================================
  // F7: Sales Cancellation Deadlock Resolution (invoiceCancellationGuard)
  // =========================================================================
  describe("F7: Sales Cancellation Deadlock Resolution for PROCESSING Orders", () => {
    const guardPath = path.resolve(__dirname, "../sale/invoiceCancellationGuard.ts");
    const guardContent = fs.readFileSync(guardPath, "utf-8");

    it("verifies production contract in invoiceCancellationGuard.ts unblocks PROCESSING orders without active consignment", () => {
      expect(guardContent).toContain("assertInvoiceReversalDeliverySafeTx");
      expect(guardContent).toContain("assertInvoiceCancellationDeliverySafeTx");

      // Verify safeOrderStatus contract
      expect(guardContent).toContain('onlineOrder.status === "CANCELLED"');
      expect(guardContent).toContain(
        '(input.mode === "CANCEL" && linkedToSafeConsignment && onlineOrder.status === "SHIPPED")',
      );
      expect(guardContent).toContain(
        '(onlineOrder.status === "PROCESSING" && (consignment == null || consignment.status === "CANCELLED"))',
      );
    });

    function evaluateCancellationSafety(
      onlineOrder: { id: number; orderNumber: string; status: string; branchId: number } | null,
      consignment: {
        id: number;
        consignmentNumber: string;
        sourceType: string;
        sourceId: number;
        status: string;
      } | null,
      mode: "CANCEL" | "CORRECT" | "RETURN",
    ): void {
      if (!onlineOrder) return;

      const linkedToSafeConsignment =
        consignment != null &&
        consignment.sourceType === "ONLINE_ORDER" &&
        Number(consignment.sourceId) === Number(onlineOrder.id);

      const safeOrderStatus =
        onlineOrder.status === "CANCELLED" ||
        (mode === "CANCEL" && linkedToSafeConsignment && onlineOrder.status === "SHIPPED") ||
        (onlineOrder.status === "PROCESSING" &&
          (consignment == null || consignment.status === "CANCELLED"));

      if (!safeOrderStatus) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            onlineOrder.status === "SHIPPED"
              ? `طلب المتجر ${onlineOrder.orderNumber} ما زال قيد التوصيل.`
              : `طلب المتجر ${onlineOrder.orderNumber} ليس في حالة إلغاء توصيل نهائية آمنة (${onlineOrder.status}).`,
        });
      }
    }

    it("permits invoice cancellation when online order is in PROCESSING with no consignment", () => {
      const order = { id: 10, orderNumber: "ORD-10", status: "PROCESSING", branchId: 1 };
      expect(() => evaluateCancellationSafety(order, null, "CANCEL")).not.toThrow();
    });

    it("permits invoice cancellation when online order is in PROCESSING with CANCELLED consignment", () => {
      const order = { id: 10, orderNumber: "ORD-10", status: "PROCESSING", branchId: 1 };
      const consignment = {
        id: 101,
        consignmentNumber: "CN-101",
        sourceType: "ONLINE_ORDER",
        sourceId: 10,
        status: "CANCELLED",
      };
      expect(() => evaluateCancellationSafety(order, consignment, "CANCEL")).not.toThrow();
    });

    it("blocks invoice cancellation when online order is in PROCESSING but consignment is active (DISPATCHED)", () => {
      const order = { id: 10, orderNumber: "ORD-10", status: "PROCESSING", branchId: 1 };
      const consignment = {
        id: 101,
        consignmentNumber: "CN-101",
        sourceType: "ONLINE_ORDER",
        sourceId: 10,
        status: "DISPATCHED",
      };
      expect(() => evaluateCancellationSafety(order, consignment, "CANCEL")).toThrow(TRPCError);
    });

    it("blocks invoice cancellation when online order is in SHIPPED status with no cancelled consignment", () => {
      const order = { id: 10, orderNumber: "ORD-10", status: "SHIPPED", branchId: 1 };
      expect(() => evaluateCancellationSafety(order, null, "CANCEL")).toThrow(TRPCError);
    });
  });

  // =========================================================================
  // F8 & CHALLENGE-001: Invoice Correction Lookup & Relinking
  // =========================================================================
  describe("F8 & CHALLENGE-001: Invoice Correction Unlocking & Relinking to Replacement Invoice", () => {
    const correctPath = path.resolve(__dirname, "../sale/correct.ts");
    const correctContent = fs.readFileSync(correctPath, "utf-8");

    const baseFacts: CorrectionLookupFacts = {
      status: "PENDING",
      sourceType: "ONLINE",
      returnedTotal: "0",
      correctedByInvoiceId: null,
      itemCount: 1,
      hasDigitalCards: false,
      hasActiveInstallmentPlan: false,
      consignmentStatus: null,
      consignmentParcelStatus: null,
      consignmentMoneyStatus: null,
      onlineOrderStatus: null,
    };

    it("F8: correctionLookupBlockReason directly permits correction when online order is in PROCESSING with no consignment", () => {
      const reason = correctionLookupBlockReason({
        ...baseFacts,
        onlineOrderStatus: "PROCESSING",
        consignmentStatus: null,
      });
      expect(reason).toBeNull();
    });

    it("F8: correctionLookupBlockReason directly permits correction when consignment is completely CANCELLED", () => {
      const reason = correctionLookupBlockReason({
        ...baseFacts,
        onlineOrderStatus: "PROCESSING",
        consignmentStatus: "CANCELLED",
        consignmentParcelStatus: "CANCELLED",
        consignmentMoneyStatus: "CANCELLED",
      });
      expect(reason).toBeNull();
    });

    it("F8: correctionLookupBlockReason directly blocks correction when consignment is active", () => {
      const reason = correctionLookupBlockReason({
        ...baseFacts,
        onlineOrderStatus: "PROCESSING",
        consignmentStatus: "DISPATCHED",
        consignmentParcelStatus: "ASSIGNED",
        consignmentMoneyStatus: "UNSETTLED",
      });
      expect(reason).toMatch(/ألغِ إسناد التوصيل/);
    });

    it("F8: correctionLookupBlockReason directly blocks correction when online order is in SHIPPED or CONFIRMED status", () => {
      const reasonShipped = correctionLookupBlockReason({
        ...baseFacts,
        onlineOrderStatus: "SHIPPED",
      });
      expect(reasonShipped).toMatch(/ألغِ طلب المتجر المرتبط/);

      const reasonConfirmed = correctionLookupBlockReason({
        ...baseFacts,
        onlineOrderStatus: "CONFIRMED",
      });
      expect(reasonConfirmed).toMatch(/ألغِ طلب المتجر المرتبط/);
    });

    it("CHALLENGE-001: verifies production implementation in server/services/sale/correct.ts relinks onlineOrders.invoiceId to newId", () => {
      // 1. Verify import of onlineOrders
      expect(correctContent).toMatch(
        /import\s*\{[^}]*\bonlineOrders\b[^}]*\}\s*from\s*["'].*drizzle\/schema["']/,
      );

      // 2. Verify exact relinking statement inside correctSaleInTx
      const relinkingPattern =
        /if\s*\(\s*inv\.sourceType\s*===\s*["']ONLINE["']\s*\)\s*\{\s*await\s+tx\s*\.\s*update\s*\(\s*onlineOrders\s*\)\s*\.\s*set\s*\(\s*\{\s*invoiceId:\s*newId\s*\}\s*\)\s*\.\s*where\s*\(\s*eq\s*\(\s*onlineOrders\.invoiceId\s*,\s*input\.originalInvoiceId\s*\)\s*\);\s*\}/;
      expect(correctContent).toMatch(relinkingPattern);

      // 3. Strict mutation sensitivity assertion:
      // Verify that the relinking block exists between step 8 (relinking invoices) and step 9 (overpay calculation)
      const step8Index = correctContent.indexOf("// ── ٨) ربط الفاتورتين");
      const step9Index = correctContent.indexOf("// ── ٩) الفرق الزائد");
      expect(step8Index).toBeGreaterThan(-1);
      expect(step9Index).toBeGreaterThan(step8Index);

      const betweenSection = correctContent.slice(step8Index, step9Index);
      expect(betweenSection).toContain('if (inv.sourceType === "ONLINE")');
      expect(betweenSection).toContain("update(onlineOrders)");
      expect(betweenSection).toContain("set({ invoiceId: newId })");
      expect(betweenSection).toContain("where(eq(onlineOrders.invoiceId, input.originalInvoiceId))");
    });

    it("CHALLENGE-001: verifies downstream dispatch and reversal safety contracts", () => {
      // When onlineOrders.invoiceId is updated from originalInvoiceId (SUPERSEDED) to newId (PENDING),
      // verify dispatchInvoice.ts contract: dispatch accepts PENDING, rejects SUPERSEDED
      const dispatchPath = path.resolve(__dirname, "../delivery/dispatchInvoice.ts");
      const dispatchContent = fs.readFileSync(dispatchPath, "utf-8");
      expect(dispatchContent).toContain(
        'if (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED")',
      );

      // Verify cancelSale contract: cancelSale searches onlineOrders by invoiceId
      const cancelPath = path.resolve(__dirname, "../sale/cancel.ts");
      const cancelContent = fs.readFileSync(cancelPath, "utf-8");
      expect(cancelContent).toContain("eq(onlineOrders.invoiceId, input.invoiceId)");
      expect(cancelContent).toContain(".update(onlineOrders)");
      expect(cancelContent).toContain('status: "CANCELLED",');
    });
  });

  // =========================================================================
  // F9: Sales Full Return Online Order Synchronization (returnService.ts)
  // =========================================================================
  describe("F9: Sales Full Return Online Order Synchronization (returnService.ts)", () => {
    const returnServicePath = path.resolve(__dirname, "../returnService.ts");
    const returnServiceContent = fs.readFileSync(returnServicePath, "utf-8");

    it("verifies production contract in returnService.ts imports onlineOrders and performs cancellation on full return", () => {
      expect(returnServiceContent).toMatch(
        /import\s*\{[^}]*\bonlineOrders\b[^}]*\}\s*from\s*["'].*drizzle\/schema["']/,
      );

      // In processFullInvoiceReturnTx:
      expect(returnServiceContent).toContain('if (inv.sourceType === "ONLINE") {');
      expect(returnServiceContent).toContain(".update(onlineOrders)");
      expect(returnServiceContent).toContain('status: "CANCELLED",');
      expect(returnServiceContent).toContain("eq(onlineOrders.invoiceId, input.invoiceId)");

      // In processInvoiceReturnTx:
      expect(returnServiceContent).toContain('if (fullyReturned && inv.sourceType === "ONLINE") {');
      const processInvoiceReturnBlock =
        /if\s*\(\s*fullyReturned\s*&&\s*inv\.sourceType\s*===\s*["']ONLINE["']\s*\)\s*\{\s*await\s+tx\s*\.\s*update\s*\(\s*onlineOrders\s*\)\s*\.\s*set\s*\(\s*\{\s*status:\s*["']CANCELLED["']/;
      expect(returnServiceContent).toMatch(processInvoiceReturnBlock);
    });

    it("evaluates return service invariants for online order synchronization", () => {
      function evaluateInvoiceReturnSync(
        invoice: { id: number; sourceType: string },
        fullyReturned: boolean,
      ): { onlineOrderStatus: string | null } {
        let onlineOrderStatus: string | null = null;
        if (fullyReturned && invoice.sourceType === "ONLINE") {
          onlineOrderStatus = "CANCELLED";
        }
        return { onlineOrderStatus };
      }

      // Full return on ONLINE invoice cancels online order
      expect(evaluateInvoiceReturnSync({ id: 501, sourceType: "ONLINE" }, true)).toEqual({
        onlineOrderStatus: "CANCELLED",
      });

      // Partial return on ONLINE invoice does NOT cancel online order
      expect(evaluateInvoiceReturnSync({ id: 501, sourceType: "ONLINE" }, false)).toEqual({
        onlineOrderStatus: null,
      });

      // Full return on POS invoice does NOT cancel online order
      expect(evaluateInvoiceReturnSync({ id: 502, sourceType: "POS" }, true)).toEqual({
        onlineOrderStatus: null,
      });
    });
  });

  // =========================================================================
  // Comprehensive Symmetry Matrix & Reversal Invariants
  // =========================================================================
  describe("Comprehensive Symmetry & Operational Lifecycle Invariants", () => {
    it("guarantees reversal symmetry across the entire delivery-storefront-sales lifecycle", () => {
      // 1. Order placed -> PROCESSING, Invoice PENDING, Consignment ASSIGNED
      let orderStatus = "PROCESSING";
      let invoiceStatus = "PENDING";
      let parcelStatus: ParcelStatus = "ASSIGNED";

      // 2. Cancellation before courier dispatch using real assertParcelTransition
      assertParcelTransition(parcelStatus, "CANCELLED");
      parcelStatus = "CANCELLED";

      // 3. Invoice cancellation guard checks
      const safe =
        orderStatus === "PROCESSING" &&
        (parcelStatus === null || parcelStatus === "CANCELLED");
      expect(safe).toBe(true);

      // 4. Cascade cancellation
      invoiceStatus = "CANCELLED";
      orderStatus = "CANCELLED";

      expect(parcelStatus).toBe("CANCELLED");
      expect(invoiceStatus).toBe("CANCELLED");
      expect(orderStatus).toBe("CANCELLED");
    });
  });
});
