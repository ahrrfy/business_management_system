import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  coupons,
  customers,
  loyaltyAccounts,
  loyaltyLedgerEntries,
  onlineOrders,
  storefrontAccountDeletionRequests,
  storefrontPushDevices,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { canonicalIraqiMobile } from "../lib/phone";
import { retryOnDup } from "../lib/retryDup";
import { money, round2, toDbMoney } from "./money";
import { currentOnlineOrderStatus } from "./storeAdmin/onlineOrderTracking";
import { verifyFirebasePhoneToken } from "./storefrontCustomerIdentityService";
import { withTx } from "./tx";

export const ACCOUNT_DELETION_RETENTION_DAYS = 365 as const;
const RETENTION_MS = ACCOUNT_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ANONYMIZED_CUSTOMER_NAME = "عميل محذوف";

function addRetentionPeriod(from: Date): Date {
  return new Date(from.getTime() + RETENTION_MS);
}

function hashValueSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildPhoneMatchCondition(canonicalPhone: string) {
  const phoneVariants = Array.from(
    new Set(
      [
        canonicalPhone,
        ...(canonicalPhone.startsWith("+964")
          ? [
              `0${canonicalPhone.slice(4)}`,
              `964${canonicalPhone.slice(4)}`,
              `00964${canonicalPhone.slice(4)}`,
              canonicalPhone.slice(4),
            ]
          : []),
      ].filter(Boolean),
    ),
  );
  const normDigits = canonicalPhone.replace(/\D/g, "");
  const digitVariants = Array.from(
    new Set(
      [
        normDigits,
        normDigits ? `00${normDigits}` : "",
        ...(canonicalPhone.startsWith("+964")
          ? [`0${canonicalPhone.slice(4)}`, canonicalPhone.slice(4)]
          : []),
      ].filter(Boolean),
    ),
  );
  const digitPredicates =
    digitVariants.length > 0
      ? (() => {
          const digitSqlList = sql.join(
            digitVariants.map((d) => sql`${d}`),
            sql`, `,
          );
          return [
            sql`REGEXP_REPLACE(COALESCE(${customers.phone}, ''), '[^0-9]', '') IN (${digitSqlList})`,
            sql`REGEXP_REPLACE(COALESCE(${customers.phone2}, ''), '[^0-9]', '') IN (${digitSqlList})`,
            sql`REGEXP_REPLACE(COALESCE(${customers.phone3}, ''), '[^0-9]', '') IN (${digitSqlList})`,
            sql`REGEXP_REPLACE(COALESCE(${customers.whatsapp}, ''), '[^0-9]', '') IN (${digitSqlList})`,
          ];
        })()
      : [];

  return or(
    inArray(customers.phone, phoneVariants),
    inArray(customers.phone2, phoneVariants),
    inArray(customers.phone3, phoneVariants),
    inArray(customers.whatsapp, phoneVariants),
    ...digitPredicates,
  )!;
}

function rowMatchesCanonicalPhone(
  row: {
    phone: string | null;
    phone2: string | null;
    phone3: string | null;
    whatsapp: string | null;
  },
  canonicalPhone: string,
): boolean {
  return [row.phone, row.phone2, row.phone3, row.whatsapp].some(
    (p) => Boolean(p && p.trim()) && canonicalIraqiMobile(p!.trim()) === canonicalPhone,
  );
}

async function findMatchingActiveCustomers(tx: Tx, canonicalPhone: string) {
  const candidates = await tx
    .select({
      id: customers.id,
      phone: customers.phone,
      phone2: customers.phone2,
      phone3: customers.phone3,
      whatsapp: customers.whatsapp,
      deletedAt: customers.deletedAt,
    })
    .from(customers)
    .where(and(isNull(customers.deletedAt), buildPhoneMatchCondition(canonicalPhone)))
    .orderBy(asc(customers.id));

  return candidates.filter(
    (c) => c.deletedAt == null && rowMatchesCanonicalPhone(c, canonicalPhone),
  );
}

/**
 * حذف حساب العميل من التطبيق الأصيل (`storefront.deleteMe`) بعد تحقق Firebase OTP حيّ:
 * - يبمّم البيانات الشخصية فوراً ضمن حدود الأعمدة (`varchar(20)` للهاتف ⇒ NULL) ويُصفّر `clientRequestId`
 * - يرفع `sessionVersion` لإبطال كل توكنات الجلسات ذات الـ7 أيام فوراً
 * - يلغي ربط أجهزة الإشعارات، ويبطل القسائم الشخصية غير المستعملة، ويُنهي رصيد نقاط الولاء مع بقاء سجل الدفتر
 * - يحتفظ بالفواتير وإجماليات الطلبات وسجلات التدقيق لمدة سنة كاملة (365 يوماً) للامتثال المحاسبي.
 */
export async function deleteMyStorefrontAccount(input: {
  firebaseIdToken: string;
  reason?: string;
}): Promise<{ ok: true; deletedAt: string; retentionUntil: string }> {
  const firebase = await verifyFirebasePhoneToken(input.firebaseIdToken);
  const now = new Date();
  const retentionUntil = addRetentionPeriod(now);

  return withTx(async (tx) => {
    const initialMatches = await findMatchingActiveCustomers(tx, firebase.phone);
    if (initialMatches.length === 0) {
      return {
        ok: true as const,
        deletedAt: now.toISOString(),
        retentionUntil: retentionUntil.toISOString(),
      };
    }

    const candidateIds = initialMatches.map((c) => Number(c.id)).sort((a, b) => a - b);
    const lockedCustomers = await tx
      .select({
        id: customers.id,
        currentBalance: customers.currentBalance,
        deletedAt: customers.deletedAt,
        phone: customers.phone,
        phone2: customers.phone2,
        phone3: customers.phone3,
        whatsapp: customers.whatsapp,
      })
      .from(customers)
      .where(inArray(customers.id, candidateIds))
      .orderBy(asc(customers.id))
      .for("update");

    const activeMatches = lockedCustomers.filter(
      (c) => c.deletedAt == null && rowMatchesCanonicalPhone(c, firebase.phone),
    );
    if (activeMatches.length === 0) {
      return {
        ok: true as const,
        deletedAt: now.toISOString(),
        retentionUntil: retentionUntil.toISOString(),
      };
    }

    const targetIds = activeMatches.map((c) => Number(c.id));

    for (const customer of activeMatches) {
      if (!money(customer.currentBalance ?? 0).eq(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "يتعذّر حذف الحساب لوجود رصيد مالي غير مسوّى",
            why: "يوجد رصيد ذمّة مدين أو دائن مسجّل على هذا الحساب يجب تصفيته محاسبياً قبل الحذف",
            doThis: "تواصل مع قسم المحاسبة في المكتبة لتسوية الرصيد ثم أعد طلب حذف الحساب",
          }),
        });
      }
    }

    const [inFlightOrder] = await tx
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        effectiveStatus: currentOnlineOrderStatus,
      })
      .from(onlineOrders)
      .where(
        and(
          inArray(onlineOrders.customerId, targetIds),
          inArray(currentOnlineOrderStatus, [
            "PENDING",
            "CONFIRMED",
            "PROCESSING",
            "SHIPPED",
          ]),
        ),
      )
      .limit(1);

    if (inFlightOrder) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "يتعذّر حذف الحساب لوجود طلب نشط قيد التنفيذ",
          why: `الطلب رقم ${inFlightOrder.orderNumber} لا يزال قيد التجهيز أو التوصيل ولم يُغلق بعد`,
          doThis:
            inFlightOrder.effectiveStatus === "PENDING"
              ? "ألغِ الطلب المعلّق من شاشة «طلباتي» أولاً أو انتظر إتمام تسليمه ثم أعد المحاولة"
              : "انتظر إتمام تسليم الطلب الحالي وتسويته ثم أعد طلب حذف الحساب",
        }),
      });
    }

    await tx
      .update(customers)
      .set({
        name: ANONYMIZED_CUSTOMER_NAME,
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
        deletedAt: now,
        retentionUntil,
        sessionVersion: sql`${customers.sessionVersion} + 1`,
      })
      .where(inArray(customers.id, targetIds));

    await tx
      .update(storefrontPushDevices)
      .set({
        customerId: null,
        marketingOptIn: false,
        transactionalOptIn: false,
        revokedAt: now,
      })
      .where(inArray(storefrontPushDevices.customerId, targetIds));

    await tx
      .update(coupons)
      .set({
        status: "VOID",
        voidedAt: now,
      })
      .where(
        and(
          inArray(coupons.customerId, targetIds),
          eq(coupons.status, "ACTIVE"),
          eq(coupons.redemptionCount, 0),
        ),
      );

    const accounts = await tx
      .select({
        id: loyaltyAccounts.id,
        customerId: loyaltyAccounts.customerId,
        pointsBalance: loyaltyAccounts.pointsBalance,
      })
      .from(loyaltyAccounts)
      .where(inArray(loyaltyAccounts.customerId, targetIds))
      .orderBy(asc(loyaltyAccounts.id))
      .for("update");

    for (const account of accounts) {
      const balance = round2(money(account.pointsBalance ?? 0));
      if (balance.gt(0)) {
        await tx
          .update(loyaltyAccounts)
          .set({ pointsBalance: "0.00" })
          .where(eq(loyaltyAccounts.id, account.id));
        await tx.insert(loyaltyLedgerEntries).values({
          accountId: Number(account.id),
          customerId: Number(account.customerId),
          entryType: "EXPIRE",
          pointsDelta: toDbMoney(balance.negated()),
          balanceAfter: "0.00",
          note: "انتهاء صلاحية الرصيد عند حذف حساب العميل بناءً على طلبه",
        });
      }
    }

    await tx.insert(storefrontAccountDeletionRequests).values({
      requestNumber: buildDeletionRequestNumber(now),
      phoneHash: hashValueSha256(firebase.phone),
      customerId: targetIds[0] ?? null,
      reason: input.reason?.trim() ? input.reason.trim().slice(0, 500) : null,
      status: "COMPLETED",
      retentionUntil,
      processedAt: now,
    });

    return {
      ok: true as const,
      deletedAt: now.toISOString(),
      retentionUntil: retentionUntil.toISOString(),
    };
  });
}

function buildDeletionRequestNumber(now: Date): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `ADR-${ymd}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * طلب حذف الحساب عبر الويب (`/legal/delete-account`) لغير الحاملين لجلسة Firebase OTP:
 * يخزّن بصمة الرقم القانونية (SHA-256) للمراجعة والتحقق دون حذف فوري بلا OTP،
 * ويعيد استجابة موحّدة تمنع تعداد أو استكشاف أرقام العملاء المسجلين.
 */
export async function requestStorefrontAccountDeletion(input: {
  phone: string;
  reason?: string;
  requestedIp?: string | null;
}): Promise<{ ok: true; requestNumber: string; retentionDays: 365 }> {
  const canonicalPhone = canonicalIraqiMobile(input.phone);
  if (!canonicalPhone) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "رقم الهاتف غير صالح",
        why: "الرقم المُدخل لا يطابق صيغة رقم هاتف نقال عراقي معتمد",
        doThis: "أدخل رقم الهاتف بصيغة 07XXXXXXXXX ثم أعد إرسال الطلب",
      }),
    });
  }

  const now = new Date();
  const retentionUntil = addRetentionPeriod(now);
  const phoneHash = hashValueSha256(canonicalPhone);
  const requestedIpHash =
    input.requestedIp && input.requestedIp.trim()
      ? hashValueSha256(input.requestedIp.trim())
      : null;
  const trimmedReason = input.reason?.trim() ? input.reason.trim().slice(0, 500) : null;

  const requestNumber = await retryOnDup(() =>
    withTx(async (tx) => {
      const matches = await findMatchingActiveCustomers(tx, canonicalPhone);
      const matchedCustomerId = matches.length > 0 ? Number(matches[0]!.id) : null;
      const reqNum = buildDeletionRequestNumber(now);
      await tx.insert(storefrontAccountDeletionRequests).values({
        requestNumber: reqNum,
        phoneHash,
        customerId: matchedCustomerId,
        reason: trimmedReason,
        status: "PENDING_REVIEW",
        retentionUntil,
        requestedIpHash,
      });
      return reqNum;
    }),
  );

  return {
    ok: true as const,
    requestNumber,
    retentionDays: ACCOUNT_DELETION_RETENTION_DAYS,
  };
}
