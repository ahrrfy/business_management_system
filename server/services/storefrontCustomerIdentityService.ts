import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";

import {
  couponPrograms,
  coupons,
  customers,
  loyaltyAccounts,
  loyaltyLedgerEntries,
  loyaltyPrograms,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { canonicalIraqiMobile } from "../lib/phone";
import { withTx } from "./tx";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "store-alarabiya";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_KEYS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);
const SESSION_ISSUER = "alarabiya-storefront";
const SESSION_AUDIENCE = "customer-mobile";
const CUSTOMER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

type FirebaseClaims = {
  uid: string;
  phone: string;
};

export type StorefrontCustomerSession = {
  token: string;
  expiresInSeconds: number;
  customer: { id: number; name: string; phone: string };
};

function sessionSecret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is required for storefront customer sessions");
  return new TextEncoder().encode(value);
}

function cleanName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب اسم العميل بحرفين إلى 120 حرفاً" });
  }
  return name;
}

/** يتحقق من ID token عبر مفاتيح Firebase العامة ولا يحتاج إرسال مفتاح خدمة إلى التطبيق. */
async function verifyFirebasePhoneToken(idToken: string): Promise<FirebaseClaims> {
  try {
    const { payload } = await jwtVerify(idToken, FIREBASE_KEYS, {
      audience: FIREBASE_PROJECT_ID,
      issuer: FIREBASE_ISSUER,
    });
    const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
    const uid = typeof payload.sub === "string" ? payload.sub : "";
    const phone = typeof payload.phone_number === "string" ? canonicalIraqiMobile(payload.phone_number) : null;
    if (!uid || firebase?.sign_in_provider !== "phone" || !phone) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "رمز التحقق لا يثبت رقم هاتف عراقي صالحاً" });
    }
    return { uid, phone };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: "UNAUTHORIZED", message: "انتهت صلاحية تحقق الهاتف أو لا يمكن التحقق منه" });
  }
}

async function resolveCustomer(phone: string, name: string, firebaseUid: string) {
  return withTx(async (tx) => {
    const lockName = `storefront-firebase-customer:${phone}`;
    const lockResult = (await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`)) as unknown;
    const row = Array.isArray(lockResult)
      ? (lockResult[0] as Array<{ locked?: number }> | undefined)?.[0]
      : (lockResult as { rows?: Array<{ locked?: number }> }).rows?.[0];
    if (Number(row?.locked) !== 1) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر تأمين ملف العميل، أعد المحاولة" });
    }
    try {
      const existing = (
        await tx
          .select({ id: customers.id, name: customers.name, isActive: customers.isActive })
          .from(customers)
          .where(or(
            eq(customers.phone, phone),
            eq(customers.phone2, phone),
            eq(customers.phone3, phone),
            eq(customers.whatsapp, phone),
          ))
          .orderBy(desc(customers.isActive), desc(customers.id))
          .for("update")
          .limit(1)
      )[0];
      if (existing) {
        if (existing.isActive === false) {
          throw new TRPCError({ code: "FORBIDDEN", message: "هذا الرقم مرتبط بعميل معطّل؛ تواصل مع المكتبة" });
        }
        return { id: Number(existing.id), name: existing.name, phone };
      }

      const inserted = await tx.insert(customers).values({
        name,
        phone,
        customerType: "فرد",
        defaultPriceTier: "RETAIL",
        creditLimit: "0",
        currentBalance: "0",
        isActive: true,
        clientRequestId: `firebase-phone:${firebaseUid}`,
      });
      return { id: extractInsertId(inserted), name, phone };
    } finally {
      await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
    }
  });
}

async function signCustomerSession(input: { customerId: number; firebaseUid: string; phone: string }): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + CUSTOMER_SESSION_TTL_SECONDS;
  return new SignJWT({
    scope: "storefront-customer",
    cid: input.customerId,
    fuid: input.firebaseUid,
    phone: input.phone,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(sessionSecret());
}

export async function claimFirebaseStorefrontCustomer(input: { firebaseIdToken: string; displayName: string }): Promise<StorefrontCustomerSession> {
  const firebase = await verifyFirebasePhoneToken(input.firebaseIdToken);
  const customer = await resolveCustomer(firebase.phone, cleanName(input.displayName), firebase.uid);
  const token = await signCustomerSession({ customerId: customer.id, firebaseUid: firebase.uid, phone: firebase.phone });
  return { token, expiresInSeconds: CUSTOMER_SESSION_TTL_SECONDS, customer };
}

export async function verifyStorefrontCustomerSession(token: string): Promise<{ customerId: number; firebaseUid: string; phone: string }> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    const customerId = Number(payload.cid);
    const firebaseUid = typeof payload.fuid === "string" ? payload.fuid : "";
    const phone = typeof payload.phone === "string" ? canonicalIraqiMobile(payload.phone) : null;
    if (payload.scope !== "storefront-customer" || !Number.isInteger(customerId) || customerId <= 0 || !firebaseUid || !phone) {
      throw new Error("Invalid customer session claims");
    }
    return { customerId, firebaseUid, phone };
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "جلسة العميل غير صالحة أو منتهية؛ أعد تحقق الهاتف" });
  }
}

/** لقطة شخصية محدودة: لا تعيد CRM أو معلومات إدارية، بل ما يلزم لبطاقة الولاء والقسائم فقط. */
export async function storefrontCustomerBenefits(session: { customerId: number; phone: string }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });

  const customer = (await db
    .select({ id: customers.id, name: customers.name, phone: customers.phone, isActive: customers.isActive })
    .from(customers)
    .where(eq(customers.id, session.customerId))
    .limit(1))[0];
  if (!customer || customer.isActive === false || canonicalIraqiMobile(customer.phone) !== session.phone) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "لم تعد جلسة العميل صالحة؛ أعد تحقق الهاتف" });
  }

  const program = (await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.status, "ACTIVE"))
    .orderBy(desc(loyaltyPrograms.updatedAt))
    .limit(1))[0] ?? null;
  const account = program
    ? (await db
      .select()
      .from(loyaltyAccounts)
      .where(and(eq(loyaltyAccounts.programId, Number(program.id)), eq(loyaltyAccounts.customerId, Number(customer.id))))
      .limit(1))[0] ?? null
    : null;
  const ledger = account
    ? await db
      .select({ entryType: loyaltyLedgerEntries.entryType, pointsDelta: loyaltyLedgerEntries.pointsDelta, balanceAfter: loyaltyLedgerEntries.balanceAfter, note: loyaltyLedgerEntries.note, createdAt: loyaltyLedgerEntries.createdAt })
      .from(loyaltyLedgerEntries)
      .where(eq(loyaltyLedgerEntries.accountId, Number(account.id)))
      .orderBy(desc(loyaltyLedgerEntries.id))
      .limit(20)
    : [];

  const today = new Date();
  const assignedCoupons = await db
    .select({ id: coupons.id, code: coupons.code, name: couponPrograms.name, validTo: couponPrograms.validTo })
    .from(coupons)
    .innerJoin(couponPrograms, eq(coupons.programId, couponPrograms.id))
    .where(and(
      eq(coupons.customerId, Number(customer.id)),
      eq(coupons.status, "ACTIVE"),
      eq(couponPrograms.status, "ACTIVE"),
      lte(couponPrograms.validFrom, today),
      or(isNull(couponPrograms.validTo), gte(couponPrograms.validTo, today)),
    ))
    .orderBy(desc(coupons.issuedAt))
    .limit(20);

  return {
    customer: { id: Number(customer.id), name: customer.name, phone: session.phone },
    loyalty: program ? {
      programName: program.name,
      pointsBalance: String(account?.pointsBalance ?? "0"),
      pointsPerIqd: String(program.pointsPerIqd),
      iqdDiscountPerPoint: String(program.iqdDiscountPerPoint),
      minRedeemPoints: Number(program.minRedeemPoints),
      maxRedeemPercent: Number(program.maxRedeemPercent),
      ledger: ledger.map((entry) => ({
        entryType: entry.entryType,
        pointsDelta: String(entry.pointsDelta),
        balanceAfter: String(entry.balanceAfter),
        note: entry.note ?? null,
        createdAt: entry.createdAt,
      })),
    } : null,
    coupons: assignedCoupons.map((coupon) => ({
      id: Number(coupon.id),
      code: coupon.code,
      name: coupon.name,
      validTo: coupon.validTo ?? null,
    })),
  };
}
