import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import * as customerIdentity from "../storefrontCustomerIdentityService";
import { enqueuePostCommit, withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_STOREFRONT_JWT_SECRET = process.env.STOREFRONT_JWT_SECRET;

// نصوص اختبار حرفية منخفضة العشوائية عمداً كي لا يعلّمها GitGuardian كأسرار حقيقية.
const STAFF_SECRET = "staff_jwt_secret_for_testing_purposes_only_12345";
const STOREFRONT_SECRET_V1 = "storefront_jwt_secret_v1_for_testing_only_12345";
const STOREFRONT_SECRET_V2 = "storefront_jwt_secret_v2_for_testing_only_67890";

function restoreJwtEnv(): void {
  if (ORIGINAL_JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }
  if (ORIGINAL_STOREFRONT_JWT_SECRET === undefined) {
    delete process.env.STOREFRONT_JWT_SECRET;
  } else {
    process.env.STOREFRONT_JWT_SECRET = ORIGINAL_STOREFRONT_JWT_SECRET;
  }
}

async function signTestToken(
  secret: string,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(opts.issuer ?? "alarabiya-storefront")
    .setAudience(opts.audience ?? "customer-mobile")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

describe("storefrontCustomerIdentityService — فصل سر JWT وسلامة معاملات withTx", () => {
  beforeEach(async () => {
    restoreJwtEnv();
    process.env.JWT_SECRET = STAFF_SECRET;
    delete process.env.STOREFRONT_JWT_SECRET;
    await truncateTables(["customers"]);
  });

  afterEach(() => {
    restoreJwtEnv();
  });

  it("لا يحتوي على COMMIT أو ROLLBACK خام داخل withTx", () => {
    const source = readFileSync(
      new URL("../storefrontCustomerIdentityService.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/sql\s*`\s*COMMIT\s*`/i);
    expect(source).not.toMatch(/sql\s*`\s*ROLLBACK\s*`/i);
  });

  it("يسقط تلقائياً إلى JWT_SECRET عند عدم ضبط STOREFRONT_JWT_SECRET أو كونه فارغاً", async () => {
    process.env.STOREFRONT_JWT_SECRET = "   ";
    const signFn = (
      customerIdentity as unknown as {
        signStorefrontCustomerSession?: (input: {
          customerId: number;
          firebaseUid: string;
          phone: string;
        }) => Promise<string>;
      }
    ).signStorefrontCustomerSession;
    expect(typeof signFn).toBe("function");

    const token = await signFn!({
      customerId: 42,
      firebaseUid: "uid-fallback-1",
      phone: "+9647701234567",
    });
    const verified = await customerIdentity.verifyStorefrontCustomerSession(token);
    expect(verified).toEqual({
      customerId: 42,
      firebaseUid: "uid-fallback-1",
      phone: "+9647701234567",
    });
  });

  it("يوقّع التوكن بـ STOREFRONT_JWT_SECRET عند ضبطه (>=32 حرفاً) ويرفض التحقق بسر خاطئ", async () => {
    process.env.STOREFRONT_JWT_SECRET = STOREFRONT_SECRET_V1;
    const signFn = (
      customerIdentity as unknown as {
        signStorefrontCustomerSession?: (input: {
          customerId: number;
          firebaseUid: string;
          phone: string;
        }) => Promise<string>;
      }
    ).signStorefrontCustomerSession;
    expect(typeof signFn).toBe("function");

    const token = await signFn!({
      customerId: 77,
      firebaseUid: "uid-sf-v1",
      phone: "+9647801112233",
    });

    // التحقق عبر STOREFRONT_JWT_SECRET ينجح
    const verified = await customerIdentity.verifyStorefrontCustomerSession(token);
    expect(verified).toEqual({
      customerId: 77,
      firebaseUid: "uid-sf-v1",
      phone: "+9647801112233",
    });

    // لو تغيّر كلا السرّين إلى قيم أخرى يُرفض التوكن فوراً
    process.env.STOREFRONT_JWT_SECRET = STOREFRONT_SECRET_V2;
    process.env.JWT_SECRET = "another_unrelated_staff_secret_for_testing_9999";
    await expect(customerIdentity.verifyStorefrontCustomerSession(token)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("يدعم التدوير السلس بلا طرد للعملاء: يقبل توكنات JWT_SECRET القديمة أثناء تفعيل STOREFRONT_JWT_SECRET الجديد مع رفض توكنات الموظفين", async () => {
    // توكن عميل قديم موقّع قبل الترقية بواسطة JWT_SECRET
    const legacyCustomerToken = await signTestToken(STAFF_SECRET, {
      scope: "storefront-customer",
      cid: 91,
      fuid: "uid-legacy-customer",
      phone: "+9647901234567",
    });

    // الآن فعّلنا STOREFRONT_JWT_SECRET المستقل
    process.env.STOREFRONT_JWT_SECRET = STOREFRONT_SECRET_V1;

    // ١) التوكن القديم للعميل يظل صالحاً (صفر خروج قسري)
    const legacyVerified = await customerIdentity.verifyStorefrontCustomerSession(legacyCustomerToken);
    expect(legacyVerified).toEqual({
      customerId: 91,
      firebaseUid: "uid-legacy-customer",
      phone: "+9647901234567",
    });

    // ٢) التوكن الجديد الموقّع بـ STOREFRONT_JWT_SECRET يعمل كمسار أساسي
    const newCustomerToken = await signTestToken(STOREFRONT_SECRET_V1, {
      scope: "storefront-customer",
      cid: 92,
      fuid: "uid-new-customer",
      phone: "+9647712345678",
    });
    const newVerified = await customerIdentity.verifyStorefrontCustomerSession(newCustomerToken);
    expect(newVerified.customerId).toBe(92);

    // ٣) توكن جلسة موظف موقّع بـ JWT_SECRET يُرفض قطعاً لاختلاف issuer/audience/scope
    const staffToken = await signTestToken(
      STAFF_SECRET,
      { userId: 1, role: "admin", fp: "staff-fp" },
      { issuer: "alarabiya-erp", audience: "erp-staff" },
    );
    await expect(customerIdentity.verifyStorefrontCustomerSession(staffToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    // ٤) حتى لو حمل issuer/audience المتجر لكن scope مختلف عن storefront-customer يُرفض
    const wrongScopeToken = await signTestToken(STAFF_SECRET, {
      scope: "staff-session",
      cid: 1,
      fuid: "uid-x",
      phone: "+9647700000000",
    });
    await expect(customerIdentity.verifyStorefrontCustomerSession(wrongScopeToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("يرفض STOREFRONT_JWT_SECRET القصير (<32 حرفاً) صراحةً عند ضبطه", async () => {
    process.env.STOREFRONT_JWT_SECRET = "too-short-secret";
    const signFn = (
      customerIdentity as unknown as {
        signStorefrontCustomerSession?: (input: {
          customerId: number;
          firebaseUid: string;
          phone: string;
        }) => Promise<string>;
      }
    ).signStorefrontCustomerSession;
    expect(typeof signFn).toBe("function");
    await expect(
      signFn!({
        customerId: 10,
        firebaseUid: "uid-short",
        phone: "+9647701234567",
      }),
    ).rejects.toThrow(/STOREFRONT_JWT_SECRET/);
  });

  it("يُوحّد إنشاء العميل تحت التنافس المتزامن ويُحرّر القفل الاستشاري ويشغّل postCommit بعد الالتزام", async () => {
    const resolveFn = (
      customerIdentity as unknown as {
        resolveStorefrontCustomer?: (
          phone: string,
          name: string,
          firebaseUid: string,
        ) => Promise<{ id: number; name: string; phone: string }>;
      }
    ).resolveStorefrontCustomer;
    expect(typeof resolveFn).toBe("function");

    const phone = "+9647705554433";
    const results = await Promise.all([
      resolveFn!(phone, "عميل متزامن", "uid-race-a"),
      resolveFn!(phone, "عميل متزامن", "uid-race-b"),
      resolveFn!(phone, "عميل متزامن", "uid-race-c"),
    ]);

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);

    const rows = await db()
      .select({ id: s.customers.id })
      .from(s.customers)
      .where(eq(s.customers.phone, phone));
    expect(rows).toHaveLength(1);

    // التأكد من تحرير القفل الاستشاري بعد اكتمال المعاملات
    const lockCheck = (await db().execute(
      sql`SELECT IS_FREE_LOCK(${`online-customer:${phone}`}) AS freeLock`,
    )) as unknown;
    const freeRow = Array.isArray(lockCheck)
      ? (lockCheck[0] as Array<{ freeLock?: number }> | undefined)?.[0]
      : (lockCheck as { rows?: Array<{ freeLock?: number }> }).rows?.[0];
    expect(Number(freeRow?.freeLock)).toBe(1);

    // عند تعطيل العميل تفشل المعاملة بـ FORBIDDEN ويظل القفل محرّراً ولا يعمل postCommit على rollback
    await db()
      .update(s.customers)
      .set({ isActive: false })
      .where(eq(s.customers.id, rows[0]!.id));

    await expect(resolveFn!(phone, "عميل معطل", "uid-disabled")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const lockAfterReject = (await db().execute(
      sql`SELECT IS_FREE_LOCK(${`online-customer:${phone}`}) AS freeLock`,
    )) as unknown;
    const freeAfterRejectRow = Array.isArray(lockAfterReject)
      ? (lockAfterReject[0] as Array<{ freeLock?: number }> | undefined)?.[0]
      : (lockAfterReject as { rows?: Array<{ freeLock?: number }> }).rows?.[0];
    expect(Number(freeAfterRejectRow?.freeLock)).toBe(1);

    // تحقق إضافي أن withTx + enqueuePostCommit يعملان بتسلسل سليم دون كسر من COMMIT خام
    let postCommitObservedRow = false;
    await withTx(async (tx) => {
      await tx.insert(s.customers).values({
        name: "عميل اختبار postCommit",
        phone: "+9647709990001",
        customerType: "فرد",
        defaultPriceTier: "RETAIL",
        creditLimit: "0",
        currentBalance: "0",
        isActive: true,
      });
      enqueuePostCommit(tx, async () => {
        const found = await db()
          .select({ id: s.customers.id })
          .from(s.customers)
          .where(eq(s.customers.phone, "+9647709990001"));
        postCommitObservedRow = found.length === 1;
      });
    });
    expect(postCommitObservedRow).toBe(true);
  });
});
