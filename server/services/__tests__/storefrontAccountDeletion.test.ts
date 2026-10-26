import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { hasOverfilledPublicSensitiveBatch } from "../../middleware/publicSensitiveBatch";
import { storefrontRouter } from "../../routers/storefrontRouter";
import { router } from "../../trpc";
import { hashCouponCode } from "../couponService";
import * as customerIdentity from "../storefrontCustomerIdentityService";
import * as turnstileService from "../storefrontTurnstile";
import { truncateAllTables } from "./__testUtils__";

const STAFF_SECRET = "staff_jwt_secret_for_testing_purposes_only_12345";
const STOREFRONT_SECRET = "storefront_jwt_secret_v1_for_testing_only_12345";

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_STOREFRONT_JWT_SECRET = process.env.STOREFRONT_JWT_SECRET;
const ORIGINAL_TURNSTILE_ENABLED = process.env.STOREFRONT_TURNSTILE_ENABLED;
const ORIGINAL_ORDERING_ENABLED = process.env.STOREFRONT_ORDERING_ENABLED;
const ORIGINAL_TURNSTILE_SITE_KEY = process.env.STOREFRONT_TURNSTILE_SITE_KEY;
const ORIGINAL_TURNSTILE_SECRET_KEY = process.env.STOREFRONT_TURNSTILE_SECRET_KEY;
const ORIGINAL_TURNSTILE_HOSTNAMES = process.env.STOREFRONT_TURNSTILE_HOSTNAMES;

const mountedStorefrontRouter = router({ storefront: storefrontRouter });

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function publicCaller(ip = "198.51.100.42") {
  return mountedStorefrontRouter.createCaller({
    req: {
      ip,
      headers: { "user-agent": "vitest-storefront-w2" },
      socket: { remoteAddress: ip },
    },
    res: {},
    user: null,
    sessionId: null,
    platformAdmin: null,
  } as never).storefront;
}

function setFirebaseVerifier(
  fn: ((idToken: string) => Promise<{ uid: string; phone: string }>) | null,
) {
  const hook = (
    customerIdentity as unknown as {
      __setFirebasePhoneTokenVerifierForTest?: typeof fn extends infer _
        ? (verifier: typeof fn) => void
        : never;
    }
  ).__setFirebasePhoneTokenVerifierForTest;
  if (typeof hook !== "function") {
    throw new Error("__setFirebasePhoneTokenVerifierForTest is not implemented yet");
  }
  hook(fn);
}

async function signLegacyPreUpgradeSessionToken(claims: {
  customerId: number;
  firebaseUid: string;
  phone: string;
}): Promise<string> {
  return new SignJWT({
    scope: "storefront-customer",
    cid: claims.customerId,
    fuid: claims.firebaseUid,
    phone: claims.phone,
    // Intentionally omit `sv` to simulate pre-0406 7-day mobile JWTs
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("alarabiya-storefront")
    .setAudience("customer-mobile")
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(STOREFRONT_SECRET));
}

describe("Storefront Wave 2 — Account Deletion & 1-Year Accounting Retention", () => {
  beforeEach(async () => {
    process.env.JWT_SECRET = STAFF_SECRET;
    process.env.STOREFRONT_JWT_SECRET = STOREFRONT_SECRET;
    delete process.env.STOREFRONT_TURNSTILE_ENABLED;
    await truncateAllTables();
    await db().insert(s.branches).values({
      id: 1,
      name: "الفرع الرئيسي",
      code: "MAIN",
      type: "MAIN",
    });
    await db().insert(s.users).values({
      id: 1,
      openId: "w2-admin",
      name: "مدير النظام",
      role: "admin",
      loginMethod: "local",
    });
  });

  afterEach(() => {
    try {
      setFirebaseVerifier(null);
    } catch {
      // hook not yet implemented in RED phase
    }
    vi.restoreAllMocks();
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    if (ORIGINAL_STOREFRONT_JWT_SECRET === undefined) delete process.env.STOREFRONT_JWT_SECRET;
    else process.env.STOREFRONT_JWT_SECRET = ORIGINAL_STOREFRONT_JWT_SECRET;
    if (ORIGINAL_TURNSTILE_ENABLED === undefined) delete process.env.STOREFRONT_TURNSTILE_ENABLED;
    else process.env.STOREFRONT_TURNSTILE_ENABLED = ORIGINAL_TURNSTILE_ENABLED;
    if (ORIGINAL_ORDERING_ENABLED === undefined) delete process.env.STOREFRONT_ORDERING_ENABLED;
    else process.env.STOREFRONT_ORDERING_ENABLED = ORIGINAL_ORDERING_ENABLED;
    if (ORIGINAL_TURNSTILE_SITE_KEY === undefined) delete process.env.STOREFRONT_TURNSTILE_SITE_KEY;
    else process.env.STOREFRONT_TURNSTILE_SITE_KEY = ORIGINAL_TURNSTILE_SITE_KEY;
    if (ORIGINAL_TURNSTILE_SECRET_KEY === undefined) delete process.env.STOREFRONT_TURNSTILE_SECRET_KEY;
    else process.env.STOREFRONT_TURNSTILE_SECRET_KEY = ORIGINAL_TURNSTILE_SECRET_KEY;
    if (ORIGINAL_TURNSTILE_HOSTNAMES === undefined) delete process.env.STOREFRONT_TURNSTILE_HOSTNAMES;
    else process.env.STOREFRONT_TURNSTILE_HOSTNAMES = ORIGINAL_TURNSTILE_HOSTNAMES;
  });

  it("blocks HTTP batching for deleteMe, requestAccountDeletion, and uploadCustomizationAsset", () => {
    expect(hasOverfilledPublicSensitiveBatch("/storefront.deleteMe,storefront.deleteMe")).toBe(true);
    expect(
      hasOverfilledPublicSensitiveBatch(
        "/storefront.requestAccountDeletion,storefront.requestAccountDeletion",
      ),
    ).toBe(true);
    expect(
      hasOverfilledPublicSensitiveBatch(
        "/storefront.uploadCustomizationAsset,storefront.uploadCustomizationAsset",
      ),
    ).toBe(true);
    expect(hasOverfilledPublicSensitiveBatch("/storefront.deleteMe")).toBe(false);
    expect(hasOverfilledPublicSensitiveBatch("/storefront.requestAccountDeletion")).toBe(false);
    expect(hasOverfilledPublicSensitiveBatch("/storefront.uploadCustomizationAsset")).toBe(false);
  });

  it("keeps pre-upgrade JWTs without `sv` valid while sessionVersion === 0, then revokes all existing 7-day JWTs immediately upon deleteMe", async () => {
    setFirebaseVerifier(async () => ({
      uid: "fuid-iraq-001",
      phone: "+9647701234567",
    }));

    const caller = publicCaller();
    const claimed = await caller.claimFirebaseCustomer({
      firebaseIdToken: "x".repeat(120),
      displayName: "أحمد الكاظمي",
    });
    expect(claimed.customer.phone).toBe("+9647701234567");

    // Pre-upgrade token (no `sv` claim) works seamlessly when sessionVersion === 0
    const preUpgradeToken = await signLegacyPreUpgradeSessionToken({
      customerId: claimed.customer.id,
      firebaseUid: "fuid-iraq-001",
      phone: "+9647701234567",
    });
    await expect(
      customerIdentity.verifyStorefrontCustomerSession(preUpgradeToken),
    ).resolves.toEqual({
      customerId: claimed.customer.id,
      firebaseUid: "fuid-iraq-001",
      phone: "+9647701234567",
    });
    await expect(
      customerIdentity.requireActiveStorefrontCustomer(preUpgradeToken),
    ).resolves.toEqual({
      customerId: claimed.customer.id,
      firebaseUid: "fuid-iraq-001",
      phone: "+9647701234567",
    });
    await expect(
      caller.customerBenefitsPrivate({ customerSessionToken: claimed.token }),
    ).resolves.toMatchObject({
      customer: { id: claimed.customer.id, name: "أحمد الكاظمي" },
    });

    // Execute deleteMe (mobile contract passes ONLY { firebaseIdToken })
    const beforeMs = Date.now();
    const deletion = await caller.deleteMe({
      firebaseIdToken: "live-otp-token-" + "y".repeat(110),
    });
    const afterMs = Date.now();

    expect(deletion.ok).toBe(true);
    const deletedAtMs = Date.parse(deletion.deletedAt);
    const retentionUntilMs = Date.parse(deletion.retentionUntil);
    expect(deletedAtMs).toBeGreaterThanOrEqual(beforeMs - 2_000);
    expect(deletedAtMs).toBeLessThanOrEqual(afterMs + 2_000);
    const diffDays = (retentionUntilMs - deletedAtMs) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(365, 2);

    // Both the newly-issued 7-day JWT AND the pre-upgrade JWT fail immediately with UNAUTHORIZED
    await expect(
      customerIdentity.verifyStorefrontCustomerSession(claimed.token),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      customerIdentity.verifyStorefrontCustomerSession(preUpgradeToken),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      customerIdentity.requireActiveStorefrontCustomer(claimed.token),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.customerBenefitsPrivate({ customerSessionToken: claimed.token }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("anonymizes PII within varchar(20), clears clientRequestId for re-registration with same firebaseUid, revokes push/coupons/loyalty, and preserves 1-year accounting records", async () => {
    setFirebaseVerifier(async () => ({
      uid: "fuid-recreate-77",
      phone: "+9647805556677",
    }));

    const caller = publicCaller();
    const claimed = await caller.claimFirebaseCustomer({
      firebaseIdToken: "a".repeat(120),
      displayName: "سارة العبيدي",
    });
    const oldCustomerId = claimed.customer.id;

    // Enrich customer PII across all fields + delivered order + invoice + audit log + push + coupon + loyalty
    await db()
      .update(s.customers)
      .set({
        phone2: "07719998877",
        phone3: "07901112233",
        whatsapp: "+9647805556677",
        address: "حي الجامعة - شارع الربيع",
        city: "بغداد",
        district: "المنصور",
        notes: "عميلة مميزة",
        waConsent: "OPTED_IN",
      })
      .where(eq(s.customers.id, oldCustomerId));

    await db().insert(s.storefrontPushDevices).values({
      customerId: oldCustomerId,
      tokenHash: "h".repeat(64),
      tokenCiphertext: "cipher-push-token",
      platform: "ANDROID",
      appVersion: "1.4.0",
      marketingOptIn: true,
      transactionalOptIn: true,
    });

    await db().insert(s.promotions).values({
      id: 10,
      name: "خصم ترحيبي",
      type: "PERCENT",
      discountPercent: "10.00",
      discountAmount: "0.00",
      scope: "ALL",
      effectiveFrom: new Date("2026-01-01"),
      effectiveTo: new Date("2027-01-01"),
      branchId: 1,
      customerTier: "RETAIL",
      minLineAmount: "0.00",
      priority: 10,
      isActive: true,
      applicationMode: "COUPON",
      isStoreManaged: true,
    });
    await db().insert(s.couponPrograms).values({
      id: 10,
      promotionId: 10,
      name: "برنامج شخصي",
      status: "ACTIVE",
      branchId: 1,
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2027-01-01"),
      perCouponLimit: 1,
      perCustomerLimit: 1,
      codePrefix: "PERS",
      createdBy: 1,
    });
    await db().insert(s.coupons).values([
      {
        id: 101,
        programId: 10,
        customerId: oldCustomerId,
        code: "PERS-UNUSED",
        codeHash: hashCouponCode("PERS-UNUSED"),
        status: "ACTIVE",
        redemptionCount: 0,
      },
      {
        id: 102,
        programId: 10,
        customerId: oldCustomerId,
        code: "PERS-USED",
        codeHash: hashCouponCode("PERS-USED"),
        status: "REDEEMED",
        redemptionCount: 1,
      },
    ]);

    await db().insert(s.loyaltyPrograms).values({
      id: 5,
      name: "نقاط المكتبة",
      status: "ACTIVE",
      pointsPerIqd: "0.01",
      iqdDiscountPerPoint: "10.00",
      minRedeemPoints: 10,
      maxRedeemPercent: 50,
    });
    await db().insert(s.loyaltyAccounts).values({
      id: 50,
      programId: 5,
      customerId: oldCustomerId,
      pointsBalance: "150.00",
    });
    await db().insert(s.loyaltyLedgerEntries).values({
      accountId: 50,
      customerId: oldCustomerId,
      entryType: "ORDER_EARN",
      pointsDelta: "150.00",
      balanceAfter: "150.00",
      note: "منح طلب سابق",
    });

    // Historical DELIVERED order + PAID invoice + auditLog (must stay 100% intact!)
    await db().insert(s.invoices).values({
      id: 700,
      invoiceNumber: "INV-W2-700",
      sourceType: "ONLINE",
      paymentMethod: "CASH",
      paymentMode: "COD",
      status: "PAID",
      customerId: oldCustomerId,
      branchId: 1,
      createdBy: 1,
      subtotal: "25000.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      total: "25000.00",
      paidAmount: "25000.00",
    });
    await db().insert(s.onlineOrders).values({
      id: 800,
      orderNumber: "ORD-W2-800",
      customerId: oldCustomerId,
      branchId: 1,
      invoiceId: 700,
      subtotal: "20000.00",
      shippingCost: "5000.00",
      total: "25000.00",
      status: "DELIVERED",
      shippingAddress: "بغداد - المنصور",
      governorate: "baghdad",
    });
    await db().insert(s.auditLogs).values({
      userId: 1,
      action: "INVOICE_CREATE",
      entityType: "invoice",
      entityId: "700",
      newValue: { total: "25000.00", customerId: oldCustomerId },
    });

    const delRes = await caller.deleteMe({
      firebaseIdToken: "live-otp-" + "z".repeat(120),
    });
    expect(delRes.ok).toBe(true);

    const [anonymized] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, oldCustomerId));
    expect(anonymized).toMatchObject({
      id: oldCustomerId,
      name: "عميل محذوف",
      phone: null,
      phone2: null,
      phone3: null,
      whatsapp: null,
      address: null,
      city: null,
      district: null,
      notes: null,
      clientRequestId: null,
      waConsent: "OPTED_OUT",
      isActive: false,
      sessionVersion: 1,
    });
    expect(anonymized.deletedAt).toBeInstanceOf(Date);
    expect(anonymized.retentionUntil).toBeInstanceOf(Date);

    // Push device revoked and unlinked
    const [pushRow] = await db().select().from(s.storefrontPushDevices);
    expect(pushRow.customerId).toBeNull();
    expect(pushRow.marketingOptIn).toBe(false);
    expect(pushRow.transactionalOptIn).toBe(false);
    expect(pushRow.revokedAt).toBeInstanceOf(Date);

    // Unused personal coupon voided; historical redeemed coupon untouched
    const couponRows = await db().select().from(s.coupons);
    const unusedCoupon = couponRows.find((c) => c.id === 101)!;
    const usedCoupon = couponRows.find((c) => c.id === 102)!;
    expect(unusedCoupon.status).toBe("VOID");
    expect(unusedCoupon.voidedAt).toBeInstanceOf(Date);
    expect(usedCoupon.status).toBe("REDEEMED");

    // Loyalty balance expired to 0.00 while ledger history preserved + EXPIRE entry appended
    const [loyaltyAcc] = await db()
      .select()
      .from(s.loyaltyAccounts)
      .where(eq(s.loyaltyAccounts.id, 50));
    expect(loyaltyAcc.pointsBalance).toBe("0.00");
    const ledgerRows = await db()
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.accountId, 50));
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows.map((l) => l.entryType).sort()).toEqual(["EXPIRE", "ORDER_EARN"]);

    // Accounting records (invoices, onlineOrders totals, auditLogs) 100% intact
    const [invRow] = await db().select().from(s.invoices).where(eq(s.invoices.id, 700));
    expect(invRow.total).toBe("25000.00");
    expect(invRow.customerId).toBe(oldCustomerId);
    const [ordRow] = await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, 800));
    expect(ordRow.total).toBe("25000.00");
    expect(ordRow.status).toBe("DELIVERED");
    const auditRows = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityId, "700"));
    expect(auditRows).toHaveLength(1);

    // Idempotent second call when already deleted
    const secondDel = await caller.deleteMe({
      firebaseIdToken: "live-otp-2-" + "z".repeat(120),
    });
    expect(secondDel.ok).toBe(true);

    // Re-registration with the EXACT SAME firebaseUid & phone creates a fresh active customer without ER_DUP_ENTRY!
    const reclaimed = await caller.claimFirebaseCustomer({
      firebaseIdToken: "a".repeat(120),
      displayName: "سارة العبيدي الجديدة",
    });
    expect(reclaimed.customer.id).not.toBe(oldCustomerId);
    expect(reclaimed.customer.name).toBe("سارة العبيدي الجديدة");
    await expect(
      customerIdentity.requireActiveStorefrontCustomer(reclaimed.token),
    ).resolves.toMatchObject({
      customerId: reclaimed.customer.id,
      phone: "+9647805556677",
    });
  });

  it("guards deleteMe when customer has an active in-flight order or non-zero AR balance", async () => {
    setFirebaseVerifier(async () => ({
      uid: "fuid-guard-99",
      phone: "+9647714445566",
    }));

    const caller = publicCaller();
    const claimed = await caller.claimFirebaseCustomer({
      firebaseIdToken: "g".repeat(120),
      displayName: "حيدر الشمري",
    });
    const customerId = claimed.customer.id;

    // 1) Active PENDING order blocks deletion
    await db().insert(s.onlineOrders).values({
      id: 901,
      orderNumber: "ORD-INFLIGHT-901",
      customerId,
      branchId: 1,
      subtotal: "10000.00",
      shippingCost: "5000.00",
      total: "15000.00",
      status: "PENDING",
      shippingAddress: "بغداد - الكرادة",
      governorate: "baghdad",
    });

    await expect(
      caller.deleteMe({ firebaseIdToken: "g".repeat(120) }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(PRECONDITION_FAILED|CONFLICT)$/),
    });

    // Mark order CANCELLED, but set non-zero AR balance -> still blocked!
    await db()
      .update(s.onlineOrders)
      .set({ status: "CANCELLED" })
      .where(eq(s.onlineOrders.id, 901));
    await db()
      .update(s.customers)
      .set({ currentBalance: "12500.00" })
      .where(eq(s.customers.id, customerId));

    await expect(
      caller.deleteMe({ firebaseIdToken: "g".repeat(120) }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(PRECONDITION_FAILED|CONFLICT)$/),
    });

    // Settle AR balance to 0.00 -> deletion now succeeds!
    await db()
      .update(s.customers)
      .set({ currentBalance: "0.00" })
      .where(eq(s.customers.id, customerId));

    await expect(
      caller.deleteMe({ firebaseIdToken: "g".repeat(120) }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("persists web requestAccountDeletion without phone enumeration, hashes canonical phone, and enforces Turnstile when enabled", async () => {
    const caller = publicCaller("203.0.113.77");

    await db().insert(s.customers).values({
      id: 501,
      name: "عميل مسجل",
      phone: "+9647708889900",
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
      creditLimit: "0",
      currentBalance: "0",
      isActive: true,
    });

    const knownRes = await caller.requestAccountDeletion({
      phone: "0770 888 9900",
      reason: "أرغب بحذف بياناتي الشخصية",
    });
    const unknownRes = await caller.requestAccountDeletion({
      phone: "07801239876",
      reason: "رقم غير مسجل مسبقاً",
    });

    // Identical non-enumerating shape for both known and unknown phone numbers
    expect(Object.keys(knownRes).sort()).toEqual(["ok", "requestNumber", "retentionDays"]);
    expect(Object.keys(unknownRes).sort()).toEqual(["ok", "requestNumber", "retentionDays"]);
    expect(knownRes).toMatchObject({
      ok: true,
      requestNumber: expect.stringMatching(/^ADR-/),
      retentionDays: 365,
    });
    expect(unknownRes).toMatchObject({
      ok: true,
      requestNumber: expect.stringMatching(/^ADR-/),
      retentionDays: 365,
    });
    expect(knownRes.requestNumber).not.toBe(unknownRes.requestNumber);

    const expectedKnownHash = createHash("sha256")
      .update("+9647708889900", "utf8")
      .digest("hex");
    const rows = await db().select().from(s.storefrontAccountDeletionRequests);
    expect(rows).toHaveLength(2);
    const knownRow = rows.find((r) => r.requestNumber === knownRes.requestNumber)!;
    const unknownRow = rows.find((r) => r.requestNumber === unknownRes.requestNumber)!;
    expect(knownRow.phoneHash).toBe(expectedKnownHash);
    expect(knownRow.customerId).toBe(501);
    expect(knownRow.status).toBe("PENDING_REVIEW");
    expect(unknownRow.customerId).toBeNull();
    expect(unknownRow.requestedIpHash).toMatch(/^[0-9a-f]{64}$/);

    // Existing customer row was NOT wiped without OTP verification!
    const [stillActive] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, 501));
    expect(stillActive.isActive).toBe(true);
    expect(stillActive.phone).toBe("+9647708889900");

    // Invalid Iraqi phone rejected with BAD_REQUEST
    await expect(
      caller.requestAccountDeletion({ phone: "12345" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Turnstile enforced when STOREFRONT_TURNSTILE_ENABLED === "1"
    process.env.STOREFRONT_TURNSTILE_ENABLED = "1";
    const turnstileSpy = vi
      .spyOn(turnstileService, "verifyStorefrontTurnstile")
      .mockResolvedValue(undefined);

    await expect(
      caller.requestAccountDeletion({ phone: "07708889900" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(turnstileSpy).not.toHaveBeenCalled();

    await expect(
      caller.requestAccountDeletion({
        phone: "07708889900",
        turnstileToken: "valid-turnstile-token",
      }),
    ).resolves.toMatchObject({ ok: true, retentionDays: 365 });
    expect(turnstileSpy).toHaveBeenCalled();
    turnstileSpy.mockRestore();
  });

  it("rejects short non-empty invalid firebaseIdToken with UNAUTHORIZED (not Zod BAD_REQUEST)", async () => {
    const caller = publicCaller();
    await expect(
      caller.deleteMe({ firebaseIdToken: "bad-token" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows requestAccountDeletion with real Turnstile verification even when STOREFRONT_ORDERING_ENABLED=0", async () => {
    process.env.STOREFRONT_TURNSTILE_ENABLED = "1";
    process.env.STOREFRONT_ORDERING_ENABLED = "0";
    process.env.STOREFRONT_TURNSTILE_SITE_KEY = "0x4AAAAAA_test_site";
    process.env.STOREFRONT_TURNSTILE_SECRET_KEY = "0x4AAAAAA_test_secret";
    process.env.STOREFRONT_TURNSTILE_HOSTNAMES = "store.alarabiya.iq";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          action: "storefront_order_verify",
          hostname: "store.alarabiya.iq",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const caller = publicCaller("203.0.113.99");
    await expect(
      caller.requestAccountDeletion({
        phone: "07708889900",
        reason: "طلب حذف قانوني أثناء إيقاف الطلبات مؤقتاً",
        turnstileToken: "real-cf-turnstile-token",
      }),
    ).resolves.toMatchObject({
      ok: true,
      requestNumber: expect.stringMatching(/^ADR-/),
      retentionDays: 365,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("prevents MVCC stale-snapshot account deletion when a concurrent transaction commits a PENDING order on MySQL 8 REPEATABLE READ", async () => {
    setFirebaseVerifier(async () => ({
      uid: "fuid-race-mvcc",
      phone: "+9647721112233",
    }));

    const caller = publicCaller();
    const claimed = await caller.claimFirebaseCustomer({
      firebaseIdToken: "r".repeat(120),
      displayName: "مصطفى السعدي",
    });
    const customerId = claimed.customer.id;

    let resolveLocked!: () => void;
    const customerRowLocked = new Promise<void>((resolve) => {
      resolveLocked = resolve;
    });
    let resolveDeleteDispatched!: () => void;
    const deleteDispatched = new Promise<void>((resolve) => {
      resolveDeleteDispatched = resolve;
    });

    // Transaction 1 (simulating createOnlineOrder holding customers FOR UPDATE, then inserting PENDING order and committing)
    const tx1Promise = db().transaction(async (tx) => {
      await tx
        .select({ id: s.customers.id })
        .from(s.customers)
        .where(eq(s.customers.id, customerId))
        .for("update");
      resolveLocked();

      await deleteDispatched;
      // Give tx2 enough time to run its initial plain SELECT (freezing its REPEATABLE READ snapshot) and block on FOR UPDATE
      await new Promise((r) => setTimeout(r, 150));

      await tx.insert(s.onlineOrders).values({
        id: 950,
        orderNumber: "ORD-RACE-950",
        customerId,
        branchId: 1,
        subtotal: "10000.00",
        shippingCost: "5000.00",
        total: "15000.00",
        status: "PENDING",
        shippingAddress: "بغداد - زيونة",
        governorate: "baghdad",
      });
    });

    await customerRowLocked;
    const deletePromise = caller.deleteMe({
      firebaseIdToken: "r".repeat(120),
    });
    resolveDeleteDispatched();

    await tx1Promise;
    await expect(deletePromise).rejects.toMatchObject({ code: "CONFLICT" });

    // Customer must NOT be anonymized while ORD-RACE-950 is PENDING!
    const [afterCustomer] = await db()
      .select()
      .from(s.customers)
      .where(eq(s.customers.id, customerId));
    expect(afterCustomer.isActive).toBe(true);
    expect(afterCustomer.deletedAt).toBeNull();
    expect(afterCustomer.phone).toBe("+9647721112233");
  });
});
