import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RECEPTION_WORKSPACE_SCHEMA_VERSION,
  RECEPTION_WORKSPACE_TTL_MS,
  applyReceptionCouponPreview,
  clearReceptionCouponPricing,
  clearReceptionWorkspaceSnapshot,
  clearReceptionWorkspaceForUse,
  createReceptionDraftSyncQueue,
  createReceptionDraftPointer,
  createReceptionLocalSnapshot,
  isReceptionWorkspaceDirty,
  isReceptionWorkspaceBoundaryBlocked,
  isDefinitiveReceptionPromotionRejection,
  isReceptionWorkspaceSnapshotSizeSafe,
  legacyReceptionWorkspaceStorageKey,
  migrateReceptionWorkspaceV1,
  parseReceptionWorkspaceSnapshot,
  persistReceptionWorkspaceMigration,
  prepareReceptionConversationStart,
  prepareReceptionDepositDraft,
  prepareReceptionDraftCart,
  prepareReceptionDraftSwitch,
  prepareReceptionLocalWorkspaceRestore,
  purgeReceptionWorkspaceSnapshots,
  reconcileReceptionCartRows,
  receptionWorkspaceFingerprint,
  receptionWorkspaceStorageKey,
  resolveReceptionRestoredPricingContext,
  serializeReceptionWorkspaceSnapshot,
  updateRestoredReceptionCustomization,
  writeReceptionWorkspaceSnapshot,
} from "./receptionWorkspaceState";
import { effectivePrice } from "@/components/reception/cartMath";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function localInput() {
  return {
    clientRequestId: REQUEST_ID,
    cart: [
      {
        key: "line-1",
        row: {
          variantId: 11,
          productId: 3,
          productUnitId: 22,
          productName: "دفتر",
          unitName: "قطعة",
          conversionFactor: "1",
          price: "2500",
          stockBase: 7,
          isService: false,
          isPrintService: false,
          isCustomizable: false,
        },
        qty: 2,
      },
    ],
    customer: { customerId: 7, name: "عميل", phone: "07700000000", isNew: false },
    phoneInput: "07700000000",
    customerCreditLimit: "250000",
    tierOverride: "WHOLESALE" as const,
    effectiveTier: "WHOLESALE" as const,
    draftPromotionPending: false,
    draftPromotionShiftId: null,
    detachedRecoveryPending: false,
    payInput: "5000",
    method: "CARD" as const,
    deferred: false,
    invoiceDiscountPct: "5",
    couponInput: "SAVE5",
    couponCode: "SAVE5",
    couponLabel: "خصم 5%",
    channel: "WALK_IN" as const,
    channelHandle: "",
    linkedConversationId: null,
  };
}

describe("reception workspace persistence", () => {
  it("round-trips the local cart and preserves the idempotency key", () => {
    const now = Date.UTC(2026, 8, 17, 9);
    const snapshot = createReceptionLocalSnapshot(localInput(), now);
    const parsed = parseReceptionWorkspaceSnapshot(
      serializeReceptionWorkspaceSnapshot(snapshot),
      now + 1_000,
    );

    expect(parsed).toMatchObject({
      version: RECEPTION_WORKSPACE_SCHEMA_VERSION,
      kind: "LOCAL",
      clientRequestId: REQUEST_ID,
      customer: { customerId: 7 },
      customerCreditLimit: "250000",
      payment: { amount: "5000", method: "CARD", deferred: false },
      tierOverride: "WHOLESALE",
      effectiveTier: "WHOLESALE",
      draftPromotionPending: false,
      detachedRecoveryPending: false,
    });
    expect(parsed?.kind === "LOCAL" ? parsed.cart : []).toHaveLength(1);
    const guarded = parseReceptionWorkspaceSnapshot(serializeReceptionWorkspaceSnapshot(createReceptionLocalSnapshot({ ...localInput(), draftPromotionPending: true, detachedRecoveryPending: true }, now)), now);
    expect(guarded).toMatchObject({ draftPromotionPending: true, detachedRecoveryPending: true });
  });

  it("migrates valid v1 single-tenant snapshots without silently dropping a live cart", () => {
    const now = Date.UTC(2026, 8, 17, 9), current = createReceptionLocalSnapshot(localInput(), now);
    const legacy = { ...current } as Record<string, unknown>; legacy.version = 1; delete legacy.effectiveTier; delete legacy.draftPromotionPending; delete legacy.draftPromotionShiftId; delete legacy.detachedRecoveryPending;
    expect(migrateReceptionWorkspaceV1(JSON.stringify(legacy), now + 1_000)).toMatchObject({ kind: "LOCAL", version: RECEPTION_WORKSPACE_SCHEMA_VERSION, cart: [{ key: "line-1" }], draftPromotionPending: false });
    expect(legacyReceptionWorkspaceStorageKey(8, 1)).toBe("erp:reception-workspace:v1:user:8:branch:1");
    const pointer = { version: 1, kind: "SERVER_DRAFT", savedAt: now, expiresAt: now + RECEPTION_WORKSPACE_TTL_MS, clientRequestId: REQUEST_ID, activeDraftId: 91 };
    expect(migrateReceptionWorkspaceV1(JSON.stringify(pointer), now + 1_000)).toMatchObject({ kind: "SERVER_DRAFT", activeDraftId: 91, legacyIdentityOnly: true });
  });

  it("writes a parseable v3 migration before tombstoning v1", () => {
    const now = Date.now(), snapshot = createReceptionLocalSnapshot(localInput(), now);
    const values = new Map<string, string>([["legacy", "old"]]), operations: string[] = [];
    const storage = {
      setItem: (key: string, value: string) => { operations.push(`set:${key}`); values.set(key, value); },
      removeItem: (key: string) => { operations.push(`remove:${key}`); values.delete(key); },
    };
    expect(persistReceptionWorkspaceMigration(storage, "current", "legacy", snapshot)).toBe(true);
    expect(operations).toEqual(["set:current", "remove:legacy"]);
    expect(parseReceptionWorkspaceSnapshot(values.get("current") ?? null, now)).toMatchObject({ kind: "LOCAL" });
    expect(values.has("legacy")).toBe(false);
  });

  it("keeps a migrated server pointer identity-only across a crash before hydration", () => {
    const now = Date.now();
    const legacy = { version: 1, kind: "SERVER_DRAFT", savedAt: now, expiresAt: now + RECEPTION_WORKSPACE_TTL_MS, clientRequestId: REQUEST_ID, activeDraftId: 91 };
    const snapshot = migrateReceptionWorkspaceV1(JSON.stringify(legacy), now)!;
    const values = new Map<string, string>([["legacy", JSON.stringify(legacy)]]);
    expect(persistReceptionWorkspaceMigration({ setItem: (key, value) => values.set(key, value), removeItem: (key) => { values.delete(key); } }, "current", "legacy", snapshot)).toBe(true);
    expect(parseReceptionWorkspaceSnapshot(values.get("current") ?? null, now)).toMatchObject({ kind: "SERVER_DRAFT", activeDraftId: 91, legacyIdentityOnly: true });
  });

  it("keeps repeated plain row references instead of treating them as cycles", () => {
    const input = localInput();
    input.cart.push({ ...input.cart[0], key: "line-2", row: input.cart[0].row });
    const now = Date.UTC(2026, 8, 17, 9);
    const parsed = parseReceptionWorkspaceSnapshot(
      serializeReceptionWorkspaceSnapshot(createReceptionLocalSnapshot(input, now)),
      now,
    );

    expect(parsed?.kind === "LOCAL" ? parsed.cart : []).toHaveLength(2);
  });

  it("rejects malformed, unsupported, expired, and implausibly future snapshots", () => {
    const now = Date.UTC(2026, 8, 17, 9);
    const snapshot = createReceptionLocalSnapshot(localInput(), now);

    expect(parseReceptionWorkspaceSnapshot("not json", now)).toBeNull();
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify({ ...snapshot, version: 1 }), now)).toBeNull();
    expect(
      parseReceptionWorkspaceSnapshot(
        JSON.stringify({ ...snapshot, version: RECEPTION_WORKSPACE_SCHEMA_VERSION + 1 }),
        now,
      ),
    ).toBeNull();
    expect(
      parseReceptionWorkspaceSnapshot(
        serializeReceptionWorkspaceSnapshot(snapshot),
        now + RECEPTION_WORKSPACE_TTL_MS + 1,
      ),
    ).toBeNull();
    expect(
      parseReceptionWorkspaceSnapshot(
        serializeReceptionWorkspaceSnapshot(createReceptionLocalSnapshot(localInput(), now + 10 * 60_000)),
        now,
      ),
    ).toBeNull();
  });

  it("never serializes payment evidence, cost, or credential-shaped fields", () => {
    const input = localInput();
    (input.cart[0].row as Record<string, unknown>).costPriceBase = "1999.00";
    input.cart[0] = {
      ...input.cart[0],
      custom: {
        title: "طباعة",
        unitPrice: "1000",
        laborCost: "0",
        assignedTo: null,
        size: "A4",
        material: "ورق",
        customizationText: "نص",
        priority: "NORMAL",
        dueDate: "",
        hasDelivery: false,
        deliveryAddress: "",
        deliveryPhone: "",
        deliveryCost: "0",
        deliveryFeeCollection: "COURIER",
        designImages: [],
        paymentReceiptImages: [{ dataUrl: "secret-payment-image" }],
        deposit: "0",
        managerApproval: { email: "boss@example.test", password: "top-secret" },
        password: "nested-secret",
      },
    } as typeof input.cart[number];

    const raw = serializeReceptionWorkspaceSnapshot(
      createReceptionLocalSnapshot(input, Date.UTC(2026, 8, 17, 9)),
    );
    const parsed = parseReceptionWorkspaceSnapshot(raw, Date.UTC(2026, 8, 17, 9));

    expect(raw).not.toContain("secret-payment-image");
    expect(raw).not.toContain("boss@example.test");
    expect(raw).not.toContain("top-secret");
    expect(raw).not.toContain("nested-secret");
    expect(raw).not.toContain("paymentReference");
    expect(raw).not.toContain("costPriceBase");
    expect(raw).toContain('"paymentReceiptImages":[]');
    expect(parsed?.kind === "LOCAL" ? parsed.cart[0]?.custom?.paymentReceiptImages : null).toEqual([]);

    const incomplete = JSON.parse(raw) as { cart: Array<{ custom: Record<string, unknown> }> };
    delete incomplete.cart[0].custom.designImages;
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(incomplete), Date.UTC(2026, 8, 17, 9))).toBeNull();

    const injectedCost = JSON.parse(raw) as { cart: Array<{ row: Record<string, unknown> }> };
    injectedCost.cart[0].row.costPriceBase = "1999.00";
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(injectedCost), Date.UTC(2026, 8, 17, 9))).toBeNull();
  });

  it("stores a server draft identity with a validated local recovery shadow", () => {
    const now = Date.UTC(2026, 8, 17, 9);
    const pointer = createReceptionDraftPointer({ activeDraftId: 91, draftVersion: 4, pendingLocal: createReceptionLocalSnapshot(localInput(), now) });
    const raw = serializeReceptionWorkspaceSnapshot(pointer);
    const parsed = parseReceptionWorkspaceSnapshot(raw, now + 1_000);

    expect(parsed).toMatchObject({
      kind: "SERVER_DRAFT",
      activeDraftId: 91,
      draftVersion: 4,
      clientRequestId: REQUEST_ID,
      pendingLocal: { kind: "LOCAL", cart: [{ key: "line-1" }] },
    });
    const mismatched = { ...pointer, draftVersion: 5, pendingLocal: { ...pointer.pendingLocal, clientRequestId: crypto.randomUUID() } };
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(mismatched), now + 1_000)).toBeNull();
  });

  it("separates a restored coupon price from the non-coupon draft price", () => {
    const input = localInput();
    input.cart[0].row = { ...input.cart[0].row, promotionId: 7, promotionName: "عرض تلقائي", promotionEffectivePrice: "2300" };
    input.cart = applyReceptionCouponPreview(input.cart as never, { code: "SAVE5", programName: "كوبون", lines: [{ productUnitId: 22, promotionId: 8, promotionName: "كوبون", promotionEffectivePrice: "2000" }] }) as typeof input.cart;
    input.cart.push({ ...input.cart[0], key: "line-2", couponPriceSnapshot: undefined, row: { ...input.cart[0].row, productUnitId: 23, promotionId: 7, promotionName: "عرض تلقائي", promotionEffectivePrice: "2300" } });
    const line = createReceptionDraftPointer({ activeDraftId: 91, draftVersion: 4, pendingLocal: createReceptionLocalSnapshot(input) }).pendingLocal.cart[0];
    const automaticPromotion = createReceptionDraftPointer({ activeDraftId: 91, draftVersion: 4, pendingLocal: createReceptionLocalSnapshot(input) }).pendingLocal.cart[1];
    expect(line).toMatchObject({ origPrice: 2300, couponPriceSnapshot: 2000, couponBasePromotion: { promotionId: 7, promotionEffectivePrice: "2300" } });
    expect(effectivePrice(line)).toBe(2000);
    expect(automaticPromotion.couponPriceSnapshot).toBeUndefined();
    expect(effectivePrice(automaticPromotion)).toBe(2300);
    const [withoutCoupon, stillPromoted] = clearReceptionCouponPricing([line, automaticPromotion]);
    expect(withoutCoupon.couponPriceSnapshot).toBeUndefined();
    expect(withoutCoupon.row.promotionId).toBe(7);
    expect(effectivePrice(withoutCoupon)).toBe(2300);
    expect(stillPromoted.row.promotionId).toBe(7);
    expect(effectivePrice(stillPromoted)).toBe(2300);
  });

  it("falls back to an invalid tombstone when removeItem is blocked", () => {
    let stored = "old";
    expect(clearReceptionWorkspaceSnapshot({ removeItem: () => { throw new DOMException("blocked"); }, setItem: (_key, value) => { stored = value; } }, "key")).toBe(true);
    expect(stored).toBe("");
    expect(clearReceptionWorkspaceSnapshot({ removeItem: () => { throw new DOMException("blocked"); }, setItem: () => { throw new DOMException("blocked"); } }, "key")).toBe(false);
  });

  it("isolates storage by user and branch and ignores timestamps in fingerprints", () => {
    expect(receptionWorkspaceStorageKey(10, 8, 1)).not.toBe(receptionWorkspaceStorageKey(10, 8, 2));
    expect(receptionWorkspaceStorageKey(10, 8, 1)).not.toBe(receptionWorkspaceStorageKey(10, 9, 1));
    expect(receptionWorkspaceStorageKey(10, 8, 1)).not.toBe(receptionWorkspaceStorageKey(11, 8, 1));
    expect(receptionWorkspaceStorageKey(null, 8, 1)).toContain("tenant:single");
    expect(receptionWorkspaceStorageKey(undefined, 8, 1)).toBeNull();

    const a = createReceptionLocalSnapshot(localInput(), 1_000);
    const b = createReceptionLocalSnapshot(localInput(), 2_000);
    expect(receptionWorkspaceFingerprint(a)).toBe(receptionWorkspaceFingerprint(b));
    expect(isReceptionWorkspaceSnapshotSizeSafe("x")).toBe(true);
    expect(isReceptionWorkspaceSnapshotSizeSafe("x".repeat(4_000_001))).toBe(false);
  });

  it("rejects incomplete financial/operational rows and malformed digital metadata", () => {
    const now = Date.UTC(2026, 8, 17, 9);
    const snapshot = createReceptionLocalSnapshot(localInput(), now);
    const missingPrice = structuredClone(snapshot) as unknown as { cart: Array<{ row: Record<string, unknown> }> };
    delete missingPrice.cart[0].row.price;
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(missingPrice), now)).toBeNull();

    const missingFlag = structuredClone(snapshot) as unknown as { cart: Array<{ row: Record<string, unknown> }> };
    delete missingFlag.cart[0].row.isPrintService;
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(missingFlag), now)).toBeNull();

    const malformedDigital = structuredClone(snapshot) as unknown as { cart: Array<Record<string, unknown>> };
    malformedDigital.cart[0].digital = { offeringId: 1, priceVersionId: 2 };
    expect(parseReceptionWorkspaceSnapshot(JSON.stringify(malformedDigital), now)).toBeNull();
  });

  it("reconciles stale prices and conversion factors without preserving a stale override", () => {
    const input = localInput();
    input.cart[0] = { ...input.cart[0], origPrice: 2500, disc: 10 };
    const liveRow = {
      ...input.cart[0].row,
      price: "3000",
      conversionFactor: "12",
      promotionEffectivePrice: null,
    };
    const reconciled = reconcileReceptionCartRows(input.cart as never, [liveRow] as never);
    expect(reconciled).toMatchObject({ ok: true });
    if (reconciled.ok) {
      expect(reconciled.cart[0].row.price).toBe("3000");
      expect(reconciled.cart[0].row.conversionFactor).toBe("12");
      expect(reconciled.cart[0].origPrice).toBe(3000);
    }
    expect(reconcileReceptionCartRows(input.cart as never, [])).toEqual({ ok: false, missingUnitIds: [22] });
    expect(reconcileReceptionCartRows(input.cart as never, [{ ...liveRow, price: null }] as never)).toEqual({ ok: false, missingUnitIds: [22] });
    expect(reconcileReceptionCartRows(input.cart as never, [{ ...liveRow, price: "0" }] as never)).toEqual({ ok: false, missingUnitIds: [22] });

    const shadowCart = createReceptionDraftPointer({ activeDraftId: 91, draftVersion: 1, pendingLocal: createReceptionLocalSnapshot(localInput()) }).pendingLocal.cart;
    const preserved = reconcileReceptionCartRows(shadowCart, [{ ...liveRow, price: null }] as never, { preserveStoredPrices: true });
    expect(preserved).toMatchObject({ ok: true, cart: [{ origPrice: 2500, row: { price: null } }] });
    if (!preserved.ok) throw new Error("expected preserved historical row");
    const historicalPointer = createReceptionDraftPointer({ activeDraftId: 91, draftVersion: 2, pendingLocal: createReceptionLocalSnapshot({ ...localInput(), cart: preserved.cart }) });
    expect(parseReceptionWorkspaceSnapshot(serializeReceptionWorkspaceSnapshot(historicalPointer))).toMatchObject({ kind: "SERVER_DRAFT", pendingLocal: { cart: [{ origPrice: 2500, row: { price: "2500" } }] } });

    const customLine = { ...input.cart[0], origPrice: undefined, disc: undefined, custom: { unitPrice: "5000" } };
    const customBaseZero = reconcileReceptionCartRows([customLine] as never, [{ ...liveRow, price: "0" }] as never);
    expect(customBaseZero).toMatchObject({ ok: true, cart: [{ row: { price: "0" }, custom: { unitPrice: "5000" } }] });

    const formerlyCouponEligible = [{ ...input.cart[0], couponPriceSnapshot: 2000 }, { ...input.cart[0], key: "line-2", row: { ...input.cart[0].row, productUnitId: 23 }, couponPriceSnapshot: 2100 }];
    const refreshed = reconcileReceptionCartRows(formerlyCouponEligible as never, [liveRow, { ...liveRow, productUnitId: 23 }] as never);
    if (!refreshed.ok) throw new Error("expected refreshed coupon rows");
    const repriced = applyReceptionCouponPreview(refreshed.cart, { code: "SAVE5", programName: "حي", lines: [{ productUnitId: 22, promotionId: 9, promotionName: "حي", promotionEffectivePrice: "2200" }] });
    expect(repriced[0].couponPriceSnapshot).toBe(2200);
    expect(repriced[1].couponPriceSnapshot).toBeUndefined();
    expect(effectivePrice(repriced[1])).toBe(2700);
  });

  it("prepares a conversation header without silently creating a customer", () => {
    expect(prepareReceptionConversationStart({
      conversationId: 19,
      customerId: null,
      channel: "STORE",
      channelHandle: "+9647701234567",
      displayName: "زبون الرسائل",
    })).toEqual({
      linkedConversationId: 19,
      channel: "OTHER",
      channelHandle: "+9647701234567",
      localPhone: "07701234567",
      customer: { customerId: null, name: "زبون الرسائل", phone: "07701234567", isNew: false },
    });
  });

  it("re-resolves an automatic customer tier and rejects a changed identity", async () => {
    const saved = { customerId: 7, name: "قديم", phone: "07701234567", isNew: false };
    await expect(resolveReceptionRestoredPricingContext(
      { customer: saved, phoneInput: "07701234567" },
      async () => ({ status: "RESOLVED", customerId: 8, defaultPriceTier: "WHOLESALE", name: "آخر" }),
    )).rejects.toThrow("تغيّرت هوية العميل");

    await expect(resolveReceptionRestoredPricingContext(
      { customer: { ...saved, customerId: null }, phoneInput: "07701234567" },
      async () => ({ status: "RESOLVED", customerId: 9, defaultPriceTier: "GOVERNMENT", name: "حي" }),
    )).resolves.toEqual({
      customer: { customerId: 9, name: "حي", phone: "07701234567", isNew: false },
      tier: "GOVERNMENT",
    });

    await expect(resolveReceptionRestoredPricingContext(
      { customer: { ...saved, phone: null }, phoneInput: "" },
      async () => { throw new Error("must not resolve by phone"); },
      async () => ({ status: "RESOLVED", customerId: 7, defaultPriceTier: "WHOLESALE", name: "بالباركود", phone: null }),
    )).resolves.toEqual({ customer: { customerId: 7, name: "بالباركود", phone: null, isNew: false }, tier: "WHOLESALE" });
  });

  it("prepares local hydration with the saved effective tier and blocks unresolved catalog rows", async () => {
    const snapshot = createReceptionLocalSnapshot(localInput(), Date.now());
    let loadedTier: string | null = null;
    const restored = await prepareReceptionLocalWorkspaceRestore(snapshot, {
      isCurrent: () => true,
      resolveAutomaticPricingContext: async ({ customer }) => ({ customer, tier: "RETAIL" }),
      loadCatalog: async ({ tier, customerId }) => {
        loadedTier = `${tier}:${customerId}`;
        return [{ ...localInput().cart[0].row, price: "3100", conversionFactor: "6" }] as never;
      },
      previewCoupon: async () => ({
        code: "SAVE5",
        programName: "خصم حي",
        lines: [{ productUnitId: 22, promotionId: 9, promotionName: "حي", promotionEffectivePrice: "2900" }],
      }),
    });
    expect(loadedTier).toBe("WHOLESALE:7");
    expect(restored).toMatchObject({ ok: true, couponCode: "SAVE5", couponLabel: "خصم حي" });
    if (restored.ok) expect(restored.cart[0].row).toMatchObject({ price: "3100", conversionFactor: "6", promotionEffectivePrice: "2900" });

    const blocked = await prepareReceptionLocalWorkspaceRestore(snapshot, {
      isCurrent: () => true,
      resolveAutomaticPricingContext: async ({ customer }) => ({ customer, tier: "RETAIL" }),
      loadCatalog: async () => [],
      previewCoupon: async () => { throw new Error("must not preview"); },
    });
    expect(blocked).toEqual({ ok: false, reason: "MISSING_CATALOG", missingUnitIds: [22] });

    const shadow = createReceptionDraftPointer({ activeDraftId: 91, draftVersion: 1, pendingLocal: snapshot }).pendingLocal;
    const preserved = await prepareReceptionLocalWorkspaceRestore(shadow, {
      isCurrent: () => true, preserveStoredPrices: true,
      resolveAutomaticPricingContext: async ({ customer }) => ({ customer, tier: "WHOLESALE" }),
      loadCatalog: async () => [{ ...localInput().cart[0].row, price: null }] as never,
      previewCoupon: async () => { throw new Error("server-draft price intent must not be re-previewed"); },
    });
    expect(preserved).toMatchObject({ ok: true, couponCode: "SAVE5", cart: [{ origPrice: 2500, row: { price: null } }] });
  });

  it("rejects a catalog-backed custom draft line when its live row is missing", () => {
    const line = {
      id: 1,
      quantity: "1",
      lineKind: "CUSTOM",
      printSpec: null,
      designImages: null,
      variantId: 11,
      productUnitId: 22,
      title: "طباعة دفتر",
      unitPrice: "3000",
    };
    expect(prepareReceptionDraftCart([line], [])).toEqual({ ok: false, missingCount: 1 });
    const restored = prepareReceptionDraftCart([line], [localInput().cart[0].row] as never);
    expect(restored).toMatchObject({ ok: true });
    if (restored.ok) expect(restored.cart[0].origPrice).toBe(3000);

    const priced = prepareReceptionDraftCart(
      [{ ...line, unitPrice: "150", printSpec: JSON.stringify({ unitPrice: "50" }) }],
      [{ ...localInput().cart[0].row, price: "100" }] as never,
    );
    if (!priced.ok) throw new Error("expected live custom row");
    const metadataOnly = updateRestoredReceptionCustomization(priced.cart[0], { ...priced.cart[0].custom!, material: "ورق" });
    const repriced = updateRestoredReceptionCustomization(priced.cart[0], { ...priced.cart[0].custom!, unitPrice: "70" });
    expect(metadataOnly.origPrice).toBe(150);
    expect(repriced.origPrice).toBe(170);
  });

  it("invalidates an older snapshot when quota/size prevents writing and purges all tenant versions", () => {
    const values = new Map<string, string>([
      ["erp:reception-workspace:v1:user:1:branch:1", "old-v1"],
      ["erp:reception-workspace:v2:tenant:company:9:user:1:branch:1", "old-v2"],
      ["unrelated", "keep"],
    ]);
    const storage = {
      get length() { return values.size; },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(writeReceptionWorkspaceSnapshot(storage, "erp:reception-workspace:v2:test", "x".repeat(4_000_001))).toBe("INVALIDATED");
    values.set("erp:reception-workspace:v2:test", "older");
    const quotaStorage = { ...storage, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
    const validRaw = serializeReceptionWorkspaceSnapshot(createReceptionLocalSnapshot(localInput(), Date.now()));
    expect(writeReceptionWorkspaceSnapshot(quotaStorage, "erp:reception-workspace:v2:test", validRaw)).toBe("INVALIDATED");
    expect(values.has("erp:reception-workspace:v2:test")).toBe(false);
    values.set("erp:reception-workspace:v2:test", "stale");
    const blockedStorage = { setItem: () => { throw new DOMException("blocked", "SecurityError"); }, removeItem: () => { throw new DOMException("blocked", "SecurityError"); } };
    expect(writeReceptionWorkspaceSnapshot(blockedStorage, "erp:reception-workspace:v2:test", validRaw)).toBe("STALE_REMAINS");
    purgeReceptionWorkspaceSnapshots(storage);
    expect(Array.from(values.entries())).toEqual([["unrelated", "keep"]]);
  });

  it("blocks restoration when an identity-boundary purge is incomplete", () => {
    const values = new Map<string, string>([["erp:reception-workspace:v3:tenant:single:user:1:branch:1", "private"]]);
    const blockedStorage = {
      get length() { return values.size; }, key: (index: number) => Array.from(values.keys())[index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
    };
    expect(purgeReceptionWorkspaceSnapshots(blockedStorage)).toBe(false);
    expect(isReceptionWorkspaceBoundaryBlocked(blockedStorage)).toBe(true);

    const bKey = "erp:reception-workspace:v3:tenant:single:user:2:branch:1";
    values.set(bKey, "other-user");
    const partialStorage = { ...blockedStorage, removeItem: (key: string) => { if (key.includes("user:1")) throw new DOMException("blocked", "SecurityError"); values.delete(key); } };
    expect(clearReceptionWorkspaceForUse(partialStorage as unknown as Storage, bKey)).toBe(false);
    expect(values.has("erp:reception-workspace:v3:tenant:single:user:1:branch:1")).toBe(true);
    expect(isReceptionWorkspaceBoundaryBlocked(partialStorage)).toBe(true);

    const recoveredStorage = { ...blockedStorage, removeItem: (key: string) => { values.delete(key); } };
    expect(purgeReceptionWorkspaceSnapshots(recoveredStorage)).toBe(true);
    expect(isReceptionWorkspaceBoundaryBlocked(recoveredStorage)).toBe(false);
  });

  it("marks every operational input group as dirty", () => {
    const clean = {
      cartLength: 0,
      customerId: null,
      customerName: "",
      customerPhone: null,
      customerIsNew: false,
      phoneInput: "",
      customerCreditLimit: "",
      tierOverride: null,
      payInput: "",
      method: "CASH" as const,
      paymentReference: "",
      deferred: false,
      invoiceDiscountPct: "",
      couponInput: "",
      couponCode: null,
      couponLabel: null,
      channel: "WALK_IN" as const,
      channelHandle: "",
      linkedConversationId: null,
      activeDraftId: null,
      draftHeld: "0.00",
    };
    expect(isReceptionWorkspaceDirty(clean)).toBe(false);

    for (const patch of [
      { cartLength: 1 },
      { customerId: 7 },
      { customerName: "عميل" },
      { customerIsNew: true },
      { phoneInput: "07700000000" },
      { customerCreditLimit: "250000" },
      { tierOverride: "WHOLESALE" as const },
      { payInput: "1000" },
      { method: "CARD" as const },
      { paymentReference: "TX-1" },
      { deferred: true },
      { invoiceDiscountPct: "5" },
      { couponInput: "SAVE" },
      { couponCode: "SAVE" },
      { couponLabel: "خصم" },
      { channel: "WHATSAPP" as const },
      { channelHandle: "9647" },
      { linkedConversationId: 12 },
      { activeDraftId: 91 },
      { draftHeld: "500" },
    ]) {
      expect(isReceptionWorkspaceDirty({ ...clean, ...patch }), JSON.stringify(patch)).toBe(true);
    }
  });
});

describe("reception draft transition races", () => {
  it("serializes same-draft syncs and gives the second request the first returned version", async () => {
    let active = { id: 10, version: 1 };
    const first = deferred<{ version: number }>();
    const calls: Array<{ draftId: number; version: number; payload: string }> = [];
    const queue = createReceptionDraftSyncQueue<string>({
      getActive: () => active,
      sync: async (input) => {
        calls.push(input);
        return input.payload === "A1" ? first.promise : { version: 3 };
      },
      applyVersion: (draftId, version) => { if (active.id === draftId) active = { ...active, version }; },
    });
    const a1 = queue.enqueue(10, "A1");
    const a2 = queue.enqueue(10, "A2");
    await Promise.resolve();
    expect(calls).toEqual([{ draftId: 10, version: 1, payload: "A1" }]);
    first.resolve({ version: 2 });
    await expect(a1).resolves.toEqual({ ok: true, draftId: 10, version: 2 });
    await expect(a2).resolves.toEqual({ ok: true, draftId: 10, version: 3 });
    expect(calls[1]).toEqual({ draftId: 10, version: 2, payload: "A2" });
  });

  it("detaches a late A response on reset and lets B sync immediately", async () => {
    let active = { id: 10, version: 1 };
    const lateA = deferred<{ version: number }>();
    const applied: Array<[number, number]> = [];
    const calls: number[] = [];
    const queue = createReceptionDraftSyncQueue<string>({
      getActive: () => active,
      sync: async ({ draftId }) => { calls.push(draftId); return draftId === 10 ? lateA.promise : { version: 8 }; },
      applyVersion: (draftId, version) => { applied.push([draftId, version]); if (active.id === draftId) active = { ...active, version }; },
    });
    const a = queue.enqueue(10, "A");
    await Promise.resolve();
    queue.reset();
    active = { id: 20, version: 7 };
    const b = queue.enqueue(20, "B");
    await expect(b).resolves.toEqual({ ok: true, draftId: 20, version: 8 });
    expect(calls).toEqual([10, 20]);
    lateA.resolve({ version: 2 });
    await expect(a).resolves.toMatchObject({ ok: false, draftId: 10 });
    expect(applied).toEqual([[20, 8]]);
  });

  it("cancels queued payloads when the same draft is force-reloaded", async () => {
    let active = { id: 10, version: 1 };
    const late = deferred<{ version: number }>();
    const payloads: string[] = [];
    const queue = createReceptionDraftSyncQueue<string>({
      getActive: () => active,
      sync: async ({ payload }) => { payloads.push(payload); return late.promise; },
      applyVersion: (_draftId, version) => { active = { ...active, version }; },
    });
    const first = queue.enqueue(10, "before-reload-1");
    const queued = queue.enqueue(10, "before-reload-2");
    await Promise.resolve();
    queue.reset();
    active = { id: 10, version: 9 };
    late.resolve({ version: 2 });
    await expect(first).resolves.toMatchObject({ ok: false, reason: "SUPERSEDED" });
    await expect(queued).resolves.toMatchObject({ ok: false, reason: "SUPERSEDED" });
    expect(payloads).toEqual(["before-reload-1"]);
    expect(active.version).toBe(9);
  });

  it("supersedes and drains an in-flight write before a force reload can read", async () => {
    let active = { id: 10, version: 1 };
    const late = deferred<{ version: number }>();
    const events: string[] = [];
    const queue = createReceptionDraftSyncQueue<string>({
      getActive: () => active,
      sync: async () => { events.push("sync"); return late.promise; },
      applyVersion: (_draftId, version) => { active = { ...active, version }; events.push("apply"); },
    });
    const write = queue.enqueue(10, "pending");
    await Promise.resolve();
    const drain = queue.supersedeAndDrain().then(() => events.push("drained"));
    await Promise.resolve();
    expect(events).toEqual(["sync"]);
    late.resolve({ version: 2 });
    await drain;
    await expect(write).resolves.toMatchObject({ ok: false, reason: "SUPERSEDED" });
    expect(events).toEqual(["sync", "drained"]);
    expect(active.version).toBe(1);
  });

  it("flushes A before loading B, blocks B on a failed flush, and no-ops the active draft", async () => {
    const pendingFlush = deferred<{ ok: true; draftId: number; version: number }>();
    const events: string[] = [];
    const switching = prepareReceptionDraftSwitch({
      active: { id: 10, version: 1 }, targetDraftId: 20, forceReload: false, offline: false, isCurrent: () => true,
      flush: async () => { events.push("flush:A"); return pendingFlush.promise; },
      load: async () => { events.push("load:B"); return { id: 20 }; },
    });
    await Promise.resolve();
    expect(events).toEqual(["flush:A"]);
    pendingFlush.resolve({ ok: true, draftId: 10, version: 2 });
    await expect(switching).resolves.toEqual({ ok: true, kind: "READY", draft: { id: 20 } });
    expect(events).toEqual(["flush:A", "load:B"]);

    const failed = await prepareReceptionDraftSwitch({
      active: { id: 10, version: 2 }, targetDraftId: 20, forceReload: false, offline: false, isCurrent: () => true,
      flush: async () => ({ ok: false, draftId: 10, reason: "FAILED", error: new Error("conflict") }),
      load: async () => { throw new Error("must not load B"); },
    });
    expect(failed).toMatchObject({ ok: false, reason: "SYNC" });
    const same = await prepareReceptionDraftSwitch({
      active: { id: 10, version: 2 }, targetDraftId: 10, forceReload: false, offline: false, isCurrent: () => true,
      flush: async () => { throw new Error("must not sync"); }, load: async () => { throw new Error("must not load"); },
    });
    expect(same).toEqual({ ok: true, kind: "NOOP" });

    let loaded = false;
    const localDirty = await prepareReceptionDraftSwitch({
      active: null, targetDraftId: 20, forceReload: false, localDirty: true, offline: false, isCurrent: () => true,
      flush: async () => { throw new Error("must not sync"); }, load: async () => { loaded = true; return { id: 20 }; },
    });
    expect(localDirty).toEqual({ ok: false, reason: "LOCAL_DIRTY" });
    expect(loaded).toBe(false);
  });

  it("returns a promoted deposit draft and never treats a failed sync as ready", async () => {
    const promotion = deferred<{ draftId: number; version: number; draftNumber: string }>();
    const resultPromise = prepareReceptionDepositDraft({ active: null, isCurrent: () => true,
      flush: async () => { throw new Error("not active"); }, promote: () => promotion.promise });
    promotion.resolve({ draftId: 31, version: 1, draftNumber: "DR-31" });
    await expect(resultPromise).resolves.toEqual({ ok: true, promoted: true, draft: { id: 31, version: 1 }, draftNumber: "DR-31", idempotentReplay: false });

    await expect(prepareReceptionDepositDraft({ active: null, isCurrent: () => true,
      flush: async () => { throw new Error("not active"); }, promote: async () => ({ draftId: 31, version: 2, draftNumber: "DR-31", idempotentReplay: true }),
    })).resolves.toMatchObject({ ok: true, idempotentReplay: true, draft: { id: 31, version: 2 } });

    await expect(prepareReceptionDepositDraft({ active: { id: 31, version: 1 }, isCurrent: () => true,
      flush: async () => ({ ok: false, draftId: 31, reason: "FAILED", error: new Error("offline") }),
      promote: async () => { throw new Error("must not promote"); },
    })).resolves.toMatchObject({ ok: false, reason: "SYNC" });
  });

  it("keeps promotion attachment before dialog open and primes customer id before restored tier effects", () => {
    const source = readFileSync(new URL("../pages/Reception.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/result\.promoted[\s\S]*activeDraftRef\.current = result\.draft;[\s\S]*setActiveDraft\(result\.draft\);[\s\S]*setDepositOpen\(true\)/);
    expect(source).toMatch(/prevCustomerIdRef\.current = restoredCustomerId;[\s\S]*setCustomer\(/);
    expect(source).toContain("prepareReceptionDraftSwitch");
    expect(source).toMatch(/if \(r\.idempotentReplay\)[\s\S]*attachResolvedPromotion\(r\)/);
    expect(source).toMatch(/const draftAtSubmit =[\s\S]*const result = draftAtSubmit/);
    expect(source).toMatch(/handleSubmit[\s\S]*draftTransitionPending \|\| draftPromotionFlightRef\.current/);
    expect(source).toMatch(/openDepositCollect[\s\S]*markDraftPromotionPending\(shift\.id\)[\s\S]*promoteM\.mutateAsync/);
    expect(source).toMatch(/draftPromotionPending[\s\S]*resolvePromotionM\.mutateAsync/);
    expect(source).toContain("D(effectivePrice(line)).lte(0)");
    expect(source).toContain("draftAtSubmit && couponCode");
    expect(source).toContain("enabled: !showCustomization && !submitting && !draftTransitionPending");
    expect(source).toMatch(/function onKey[\s\S]*if \(draftTransitionPending\) \{ e\.preventDefault\(\); return; \}/);
  });

  it("classifies only definitive pre-commit promotion rejections as editable", () => {
    expect(isDefinitiveReceptionPromotionRejection({ data: { code: "BAD_REQUEST" } })).toBe(true);
    expect(isDefinitiveReceptionPromotionRejection({ data: { code: "CONFLICT" } })).toBe(false);
    expect(isDefinitiveReceptionPromotionRejection(new Error("network"))).toBe(false);
  });
});
