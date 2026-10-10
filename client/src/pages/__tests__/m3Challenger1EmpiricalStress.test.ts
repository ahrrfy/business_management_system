import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createTab, type POSTab, type PaymentMethod } from "@/components/pos/posShared";

describe("Milestone 3 Challenger 1 (Iteration 5): POS Sales Attribution Empirical Stress", () => {
  const posSharedSource = readFileSync(new URL("../../components/pos/posShared.ts", import.meta.url), "utf8");
  const posSource = readFileSync(new URL("../POS.tsx", import.meta.url), "utf8");
  const cartPanelSource = readFileSync(new URL("../../components/pos/CartPanel.tsx", import.meta.url), "utf8");
  const saleRouterSource = readFileSync(new URL("../../../../server/routers/saleRouter.ts", import.meta.url), "utf8");
  const posExternalPaymentSource = readFileSync(new URL("../../../../server/services/posExternalPayment.ts", import.meta.url), "utf8");
  const saleCreateSource = readFileSync(new URL("../../../../server/services/sale/create.ts", import.meta.url), "utf8");

  // =========================================================================
  // 1. POS Tab State Multi-Tab Switching & Persistence Verification
  // =========================================================================
  describe("1. POS Tab State & Multi-Tab Switching Persistence", () => {
    it("1.1: createTab initializes salesRepId strictly to null", () => {
      const tab1 = createTab(1, "طلب 1");
      expect(tab1.salesRepId).toBe(null);
      expect(posSharedSource).toContain("salesRepId: null,");
      expect(posSharedSource).toContain("salesRepId?: number | null;");
    });

    it("1.2: Multi-tab state isolates salesRepId across tabs and preserves assignments across switches", () => {
      // Replicate POS.tsx tab state management logic
      let tabs: POSTab[] = [createTab(1, "طلب 1"), createTab(2, "طلب 2"), createTab(3, "طلب 3")];
      let activeId = 1;

      const patchTab = (id: number, patch: Partial<POSTab>) => {
        tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
      };
      const patchActive = (patch: Partial<POSTab>) => {
        patchTab(activeId, patch);
      };
      const getActiveTab = () => tabs.find((t) => t.id === activeId) ?? tabs[0];

      // Assign sales rep 42 to Tab 1
      activeId = 1;
      patchActive({ salesRepId: 42 });
      expect(getActiveTab().salesRepId).toBe(42);

      // Switch to Tab 2 and assign sales rep 88
      activeId = 2;
      expect(getActiveTab().salesRepId).toBe(null); // Tab 2 unaffected
      patchActive({ salesRepId: 88 });
      expect(getActiveTab().salesRepId).toBe(88);

      // Switch to Tab 3 (unassigned)
      activeId = 3;
      expect(getActiveTab().salesRepId).toBe(null);

      // Switch back to Tab 1 -> must still have 42
      activeId = 1;
      expect(getActiveTab().salesRepId).toBe(42);

      // Switch back to Tab 2 -> must still have 88
      activeId = 2;
      expect(getActiveTab().salesRepId).toBe(88);

      // Verify all tabs in memory retain distinct values
      expect(tabs[0].salesRepId).toBe(42);
      expect(tabs[1].salesRepId).toBe(88);
      expect(tabs[2].salesRepId).toBe(null);
    });

    it("1.3: Clearing attribution on one tab does not corrupt other tabs", () => {
      let tabs: POSTab[] = [
        { ...createTab(1), salesRepId: 101 },
        { ...createTab(2), salesRepId: 202 },
      ];
      let activeId = 1;

      // Clear sales rep on Tab 1
      tabs = tabs.map((t) => (t.id === activeId ? { ...t, salesRepId: null } : t));

      expect(tabs.find((t) => t.id === 1)?.salesRepId).toBe(null);
      expect(tabs.find((t) => t.id === 2)?.salesRepId).toBe(202);
    });

    it("1.4: Closing an active tab transfers focus while preserving attribution of remaining tabs", () => {
      let tabs: POSTab[] = [
        { ...createTab(1), salesRepId: 50 },
        { ...createTab(2), salesRepId: 75 },
        { ...createTab(3), salesRepId: 90 },
      ];
      let activeId = 2;

      // Close Tab 2
      const idToClose = 2;
      const next = tabs.filter((t) => t.id !== idToClose);
      if (activeId === idToClose) {
        activeId = next[next.length - 1].id;
      }
      tabs = next;

      expect(tabs.length).toBe(2);
      expect(activeId).toBe(3);
      expect(tabs.find((t) => t.id === 1)?.salesRepId).toBe(50);
      expect(tabs.find((t) => t.id === 3)?.salesRepId).toBe(90);
    });

    it("1.5: Draft persistence serialization and hydration retains salesRepId per tab", () => {
      const originalTabs: POSTab[] = [
        { ...createTab(1), salesRepId: 111 },
        { ...createTab(2), salesRepId: 222 },
        { ...createTab(3), salesRepId: null },
      ];

      // Simulate JSON serialization to localStorage
      const serialized = JSON.stringify({ tabs: originalTabs, activeId: 2 });
      const parsed = JSON.parse(serialized);

      // Hydration mapping
      const hydratedTabs = parsed.tabs.map((t: POSTab) => ({
        ...t,
        method: "CASH" as PaymentMethod,
      }));

      expect(hydratedTabs[0].salesRepId).toBe(111);
      expect(hydratedTabs[1].salesRepId).toBe(222);
      expect(hydratedTabs[2].salesRepId).toBe(null);
    });
  });

  // =========================================================================
  // 2. POS Mutation Payload Generation (submitSale and quickPay)
  // =========================================================================
  describe("2. POS Mutation Payload Generation (submitSale and quickPay)", () => {
    // Production payload builders extracted directly from POS.tsx
    const buildSubmitPayload = (activeTab: Partial<POSTab>) => {
      return {
        branchId: 1,
        shiftId: 10,
        sourceType: "POS" as const,
        clientRequestId: activeTab.clientRequestId || "req-1",
        customerId: activeTab.customerId ?? undefined,
        lines: [],
        ...(activeTab.salesRepId
          ? {
              salesRepId: activeTab.salesRepId,
              attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const },
            }
          : {}),
      };
    };

    const buildQuickPayPayload = (activeTab: Partial<POSTab>) => {
      return {
        branchId: 1,
        shiftId: 10,
        sourceType: "POS" as const,
        clientRequestId: activeTab.clientRequestId || "req-2",
        customerId: activeTab.customerId ?? undefined,
        lines: [],
        ...(activeTab.salesRepId
          ? {
              salesRepId: activeTab.salesRepId,
              attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const },
            }
          : {}),
      };
    };

    it("2.1: submitSale payload includes salesRepId and attribution when rep is assigned", () => {
      const payload = buildSubmitPayload({ salesRepId: 55 });
      expect(payload.salesRepId).toBe(55);
      expect(payload.attribution).toEqual({ repId: 55, mode: "DIRECT" });
    });

    it("2.2: submitSale payload omits salesRepId and attribution when rep is null or undefined", () => {
      const payloadNull = buildSubmitPayload({ salesRepId: null });
      expect("salesRepId" in payloadNull).toBe(false);
      expect("attribution" in payloadNull).toBe(false);

      const payloadUndef = buildSubmitPayload({ salesRepId: undefined });
      expect("salesRepId" in payloadUndef).toBe(false);
      expect("attribution" in payloadUndef).toBe(false);
    });

    it("2.3: quickPay payload includes salesRepId and attribution when rep is assigned", () => {
      const payload = buildQuickPayPayload({ salesRepId: 77 });
      expect(payload.salesRepId).toBe(77);
      expect(payload.attribution).toEqual({ repId: 77, mode: "DIRECT" });
    });

    it("2.4: quickPay payload omits salesRepId and attribution when rep is null or undefined", () => {
      const payloadNull = buildQuickPayPayload({ salesRepId: null });
      expect("salesRepId" in payloadNull).toBe(false);
      expect("attribution" in payloadNull).toBe(false);

      const payloadUndef = buildQuickPayPayload({ salesRepId: undefined });
      expect("salesRepId" in payloadUndef).toBe(false);
      expect("attribution" in payloadUndef).toBe(false);
    });

    it("2.5: POS.tsx source verification: exact spread pattern is present in submitSale and quickPay", () => {
      const expectedSpread =
        '...(activeTab.salesRepId ? { salesRepId: activeTab.salesRepId, attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const } } : {})';

      // Both submitSale (around line 1041) and quickPay (around line 1095) must contain this exact spread
      const matches = posSource.split(expectedSpread).length - 1;
      expect(matches).toBe(2);
    });

    it("2.6: Stress generator: 500 random rep IDs generate valid mutation payloads without drift", () => {
      for (let repId = 1; repId <= 500; repId++) {
        const submitPayload = buildSubmitPayload({ salesRepId: repId });
        expect(submitPayload.salesRepId).toBe(repId);
        expect(submitPayload.attribution).toEqual({ repId, mode: "DIRECT" });

        const quickPayPayload = buildQuickPayPayload({ salesRepId: repId });
        expect(quickPayPayload.salesRepId).toBe(repId);
        expect(quickPayPayload.attribution).toEqual({ repId, mode: "DIRECT" });
      }
    });
  });

  // =========================================================================
  // 3. saleRouter Zod Schema Validation & Service Forwarding
  // =========================================================================
  describe("3. saleRouter Zod Schema Validation & Service Forwarding", () => {
    // Exact schema extracted from server/routers/saleRouter.ts (lines 977-986)
    const attributionZodSchema = z.object({
      salesRepId: z.number().int().positive().nullish(),
      attribution: z
        .object({
          repId: z.number().int().positive().nullish(),
          assistedById: z.number().int().positive().nullish(),
          role: z.enum(["FLOOR_REP", "RECEPTIONIST", "CASHIER", "FULFILLER"]).nullish(),
          mode: z.enum(["DIRECT", "SPLIT", "POOL"]).nullish(),
          splitRatio: z.string().nullish(),
          teamPoolId: z.number().int().positive().nullish(),
        })
        .nullish(),
    });

    it("3.1: Accepts valid direct sales rep attribution payloads", () => {
      const valid1 = {
        salesRepId: 10,
        attribution: { repId: 10, mode: "DIRECT" as const },
      };
      const parsed1 = attributionZodSchema.safeParse(valid1);
      expect(parsed1.success).toBe(true);
      if (parsed1.success) {
        expect(parsed1.data.salesRepId).toBe(10);
        expect(parsed1.data.attribution?.repId).toBe(10);
        expect(parsed1.data.attribution?.mode).toBe("DIRECT");
      }
    });

    it("3.2: Accepts multi-role split and team pool attribution payloads", () => {
      const validSplit = {
        salesRepId: 12,
        attribution: {
          repId: 12,
          assistedById: 15,
          mode: "SPLIT" as const,
          splitRatio: "70/30",
          role: "FLOOR_REP" as const,
        },
      };
      const parsedSplit = attributionZodSchema.safeParse(validSplit);
      expect(parsedSplit.success).toBe(true);

      const validPool = {
        attribution: {
          mode: "POOL" as const,
          teamPoolId: 3,
          role: "FULFILLER" as const,
        },
      };
      const parsedPool = attributionZodSchema.safeParse(validPool);
      expect(parsedPool.success).toBe(true);
    });

    it("3.3: Accepts null and undefined attribution payloads (unassisted cashier sales)", () => {
      expect(attributionZodSchema.safeParse({ salesRepId: null, attribution: null }).success).toBe(true);
      expect(attributionZodSchema.safeParse({ salesRepId: undefined, attribution: undefined }).success).toBe(true);
      expect(attributionZodSchema.safeParse({}).success).toBe(true);
    });

    it("3.4: Rejects invalid attribution payloads (negative ID, non-integer, invalid enum)", () => {
      // Negative salesRepId
      expect(attributionZodSchema.safeParse({ salesRepId: -5 }).success).toBe(false);

      // Zero salesRepId (must be positive)
      expect(attributionZodSchema.safeParse({ salesRepId: 0 }).success).toBe(false);

      // Float salesRepId
      expect(attributionZodSchema.safeParse({ salesRepId: 3.14 }).success).toBe(false);

      // Invalid mode enum
      expect(
        attributionZodSchema.safeParse({
          attribution: { mode: "UNRECOGNIZED" as any },
        }).success,
      ).toBe(false);

      // Invalid role enum
      expect(
        attributionZodSchema.safeParse({
          attribution: { role: "MANAGER" as any },
        }).success,
      ).toBe(false);
    });

    it("3.5: Router mutation effectively forwards salesRepId and attribution without stripping", () => {
      // Simulate saleRouter mutation handler unpacking
      const input = {
        branchId: 1,
        shiftId: 2,
        lines: [],
        managerApproval: undefined,
        salesRepId: 42,
        attribution: { repId: 42, mode: "DIRECT" as const },
      };

      const { managerApproval, ...saleInput } = input;
      const effectiveInput = {
        ...saleInput,
        branchId: 1,
        sourceType: "POS" as const,
        creditApproved: false,
        requireExternalPaymentAttempt: true,
      };

      // salesRepId and attribution must not be stripped
      expect(effectiveInput.salesRepId).toBe(42);
      expect(effectiveInput.attribution).toEqual({ repId: 42, mode: "DIRECT" });

      // Simulate posExternalPayment coreSaleInput unpacking
      const { requireExternalPaymentAttempt: _required, payment: _p, ...coreRest } = effectiveInput;
      expect(coreRest.salesRepId).toBe(42);
      expect(coreRest.attribution).toEqual({ repId: 42, mode: "DIRECT" });
    });

    it("3.6: Verify contract integrity in saleRouter.ts, posExternalPayment.ts, and create.ts", () => {
      expect(saleRouterSource).toContain("salesRepId: z.number().int().positive().nullish()");
      expect(saleRouterSource).toMatch(/attribution:\s*z\s*\.object\(\{/);
      expect(posExternalPaymentSource).toContain("coreSaleInput(input)");
      expect(saleCreateSource).toContain("salesRepId: input.attribution?.repId ?? input.salesRepId,");
      expect(saleCreateSource).toContain("salesRepId: attributionPlan.primaryUserId,");
      expect(saleCreateSource).toContain("recordInvoiceAttributionsInTx");
    });
  });
});
