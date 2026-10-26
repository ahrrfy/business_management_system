import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { appErrorMessage } from "../../../shared/errors";
import {
  couponPrograms,
  coupons,
  customers,
  invoices,
  loyaltyAccounts,
  loyaltyLedgerEntries,
  loyaltyPrograms,
  onlineOrders,
  promotions,
  users,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { retryOnDeadlock } from "../../lib/retryDeadlock";
import { baghdadToday, utcDayStart } from "../businessDay";
import { hashCouponCode } from "../couponService";
import { type DecimalInput, money, round2, toDbMoney } from "../money";
import { requireActiveStorefrontCustomer } from "../storefrontCustomerIdentityService";
import { withTx } from "../tx";

export type LoyaltyRulesInput = {
  name: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  pointsPerIqd: string;
  iqdDiscountPerPoint: string;
  minRedeemPoints: number;
  maxRedeemPercent: number;
  expiresAfterDays: number | null;
};

export type LoyaltyLedgerEntryType =
  | "ORDER_EARN"
  | "ORDER_REVERSE"
  | "REDEEM"
  | "ADJUSTMENT"
  | "EXPIRE";

export type LoyaltyRedeemResult = {
  outcome: "ISSUED" | "REPLAYED";
  code: string;
  programName: string;
  discountIqd: string;
  minOrderSpendIqd: string;
  pointsRedeemed: number;
  pointsBalance: string;
  validTo: Date | null;
};

function validateRules(input: LoyaltyRulesInput) {
  const earn = money(input.pointsPerIqd);
  const discount = money(input.iqdDiscountPerPoint);
  if (earn.isNegative() || discount.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "قواعد النقاط والخصم لا تقبل قيماً سالبة",
    });
  }
  if (
    input.minRedeemPoints < 0 ||
    input.maxRedeemPercent < 0 ||
    input.maxRedeemPercent > 100
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "حدود استبدال النقاط غير صحيحة",
    });
  }
  if (input.expiresAfterDays != null && input.expiresAfterDays < 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مدة انتهاء النقاط يجب أن تكون يوماً واحداً على الأقل",
    });
  }
  return { earn, discount };
}

export async function listLoyaltyPrograms() {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(loyaltyPrograms)
    .orderBy(desc(loyaltyPrograms.updatedAt));
}

export async function saveLoyaltyProgram(
  input: LoyaltyRulesInput & { id?: number },
  actorUserId: number,
) {
  const { earn, discount } = validateRules(input);
  return withTx(async (tx) => {
    const values = {
      name: input.name.trim(),
      status: input.status,
      pointsPerIqd: earn.toFixed(6),
      iqdDiscountPerPoint: toDbMoney(discount),
      minRedeemPoints: input.minRedeemPoints,
      maxRedeemPercent: input.maxRedeemPercent,
      expiresAfterDays: input.expiresAfterDays,
    };
    if (input.id) {
      const exists = (
        await tx
          .select({ id: loyaltyPrograms.id })
          .from(loyaltyPrograms)
          .where(eq(loyaltyPrograms.id, input.id))
          .for("update")
          .limit(1)
      )[0];
      if (!exists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "برنامج الولاء غير موجود",
        });
      }
      await tx
        .update(loyaltyPrograms)
        .set(values)
        .where(eq(loyaltyPrograms.id, input.id));
      return { id: input.id, ...values };
    }
    const result = await tx
      .insert(loyaltyPrograms)
      .values({ ...values, createdBy: actorUserId });
    return { id: extractInsertId(result), ...values };
  });
}

function parseOriginalEarnedNetMerchandise(note: string | null): Decimal | null {
  if (!note) return null;
  const match = note.match(/صافي البضاعة\s+(\d+(?:\.\d+)?)/);
  if (!match?.[1]) return null;
  const parsed = money(match[1]);
  return parsed.gt(0) ? parsed : null;
}

function parseUnrecoveredPointsFromNote(note: string | null): Decimal {
  if (!note) return money(0);
  const match = note.match(/تعذّر استرداد\s+(\d+(?:\.\d+)?)\s+نقطة/);
  if (!match?.[1]) return money(0);
  const parsed = money(match[1]);
  return parsed.gt(0) ? parsed : money(0);
}

/**
 * يُستدعى داخل معاملة تسليم الطلب فقط؛ يحتسب النقاط حصراً على صافي البضاعة بعد الخصم
 * مع استبعاد أجرة التوصيل وعدم خصم القسيمة مرتين، ويمنع التكرار بمفتاح idempotencyKey.
 */
export async function awardDeliveredOnlineOrderPoints(
  tx: Tx,
  input: { onlineOrderId: number; customerId?: number | null; total?: string },
) {
  if (!Number.isFinite(input.onlineOrderId) || input.onlineOrderId <= 0) {
    return null;
  }

  const orderRow = (
    await tx
      .select({
        orderCustomerId: onlineOrders.customerId,
        orderTotal: onlineOrders.total,
        shippingCost: onlineOrders.shippingCost,
        invoiceId: onlineOrders.invoiceId,
        invoiceStatus: invoices.status,
        invoiceTotal: invoices.total,
        invoiceReturnedTotal: invoices.returnedTotal,
        invoiceDeliveryFee: invoices.deliveryFee,
      })
      .from(onlineOrders)
      .leftJoin(invoices, eq(invoices.id, onlineOrders.invoiceId))
      .where(eq(onlineOrders.id, input.onlineOrderId))
      .for("update")
      .limit(1)
  )[0];
  if (!orderRow) return null;

  const customerId =
    orderRow.orderCustomerId != null
      ? Number(orderRow.orderCustomerId)
      : input.customerId != null
        ? Number(input.customerId)
        : 0;
  if (!Number.isFinite(customerId) || customerId <= 0) return null;

  // ترتيب الأقفال الموحّد عبر كل عمليات الولاء: customers -> loyaltyPrograms -> loyaltyAccounts
  // يمنع التوقف المتبادل (deadlock) عند تزامن تسليم طلب مع استبدال العميل لنقاطه.
  const customerRow = (
    await tx
      .select({
        id: customers.id,
        isActive: customers.isActive,
        deletedAt: customers.deletedAt,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .for("update")
      .limit(1)
  )[0];
  if (
    !customerRow ||
    customerRow.isActive === false ||
    customerRow.deletedAt != null
  ) {
    return null;
  }

  const program = (
    await tx
      .select()
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.status, "ACTIVE"))
      .orderBy(desc(loyaltyPrograms.updatedAt))
      .for("update")
      .limit(1)
  )[0];
  if (!program) return null;

  const idempotencyKey = `earn:order:${input.onlineOrderId}`;
  const alreadyByOrder = (
    await tx
      .select({ id: loyaltyLedgerEntries.id })
      .from(loyaltyLedgerEntries)
      .where(
        and(
          eq(loyaltyLedgerEntries.onlineOrderId, input.onlineOrderId),
          eq(loyaltyLedgerEntries.entryType, "ORDER_EARN"),
        ),
      )
      .for("update")
      .limit(1)
  )[0];
  if (alreadyByOrder) return null;
  const alreadyByKey = (
    await tx
      .select({ id: loyaltyLedgerEntries.id })
      .from(loyaltyLedgerEntries)
      .where(eq(loyaltyLedgerEntries.idempotencyKey, idempotencyKey))
      .limit(1)
  )[0];
  if (alreadyByKey) return null;

  let eligibleNetIqd: Decimal;
  if (orderRow.invoiceId != null) {
    if (
      orderRow.invoiceStatus === "CANCELLED" ||
      orderRow.invoiceStatus === "RETURNED" ||
      orderRow.invoiceStatus === "SUPERSEDED"
    ) {
      eligibleNetIqd = money(0);
    } else {
      eligibleNetIqd = round2(
        Decimal.max(
          0,
          money(orderRow.invoiceTotal ?? "0")
            .minus(money(orderRow.invoiceReturnedTotal ?? "0"))
            .minus(money(orderRow.invoiceDeliveryFee ?? "0")),
        ),
      );
    }
  } else {
    eligibleNetIqd = round2(
      Decimal.max(
        0,
        money(orderRow.orderTotal ?? "0").minus(
          money(orderRow.shippingCost ?? "0"),
        ),
      ),
    );
  }

  if (!eligibleNetIqd.gt(0)) return null;

  const points = round2(eligibleNetIqd.times(money(program.pointsPerIqd)));
  if (!points.gt(0)) return null;

  let account = (
    await tx
      .select()
      .from(loyaltyAccounts)
      .where(
        and(
          eq(loyaltyAccounts.programId, Number(program.id)),
          eq(loyaltyAccounts.customerId, customerId),
        ),
      )
      .for("update")
      .limit(1)
  )[0];
  if (!account) {
    const created = await tx.insert(loyaltyAccounts).values({
      programId: Number(program.id),
      customerId,
      pointsBalance: "0.00",
    });
    const accountId = extractInsertId(created);
    account = (
      await tx
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId))
        .for("update")
        .limit(1)
    )[0]!;
  }

  const nextBalance = round2(money(account.pointsBalance).plus(points));
  await tx
    .update(loyaltyAccounts)
    .set({ pointsBalance: toDbMoney(nextBalance) })
    .where(eq(loyaltyAccounts.id, Number(account.id)));

  await tx.insert(loyaltyLedgerEntries).values({
    accountId: Number(account.id),
    customerId,
    onlineOrderId: input.onlineOrderId,
    entryType: "ORDER_EARN",
    pointsDelta: toDbMoney(points),
    balanceAfter: toDbMoney(nextBalance),
    idempotencyKey,
    note: `نقاط طلب مكتمل (صافي البضاعة ${toDbMoney(eligibleNetIqd)} د.ع)`,
  });

  return {
    accountId: Number(account.id),
    awarded: toDbMoney(points),
    balance: toDbMoney(nextBalance),
  };
}

/**
 * استرداد نسبيّ لنقاط الولاء عند مرتجع جزئي/كامل أو تصحيح فاتورة طلب متجر لأسفل.
 * يحافظ على معدل الاكتساب الأصلي لقيد ORDER_EARN ولا يُسقط المرتجع المحاسبي إذا سبق
 * للعميل صرف نقاطه (يقتطع المتاح ويُسقف الرصيد عند 0.00 مع توثيق الفارق في الدفتر).
 */
function boundLoyaltyIdempotencyKey(rawKey: string): string {
  if (rawKey.length <= 100) return rawKey;
  const digest = createHash("sha256").update(rawKey).digest("hex").slice(0, 48);
  return `${rawKey.slice(0, 49)}:h:${digest}`;
}

export function buildRedeemIdempotencyKey(
  customerId: number,
  trimmedRequestId: string,
): string {
  const raw = `redeem:${customerId}:${trimmedRequestId}`;
  if (raw.length <= 100) return raw;
  const digest = createHash("sha256")
    .update(trimmedRequestId)
    .digest("hex")
    .slice(0, 48);
  return `redeem:${customerId}:h:${digest}`;
}

export async function reverseOnlineOrderLoyaltyPoints(
  tx: Tx,
  input: {
    onlineOrderId: number;
    remainingNetMerchandiseIqd: DecimalInput;
    idempotencyKey: string;
    reasonLabel: string;
  },
) {
  if (!Number.isFinite(input.onlineOrderId) || input.onlineOrderId <= 0) {
    return null;
  }

  const boundedIdempotencyKey = boundLoyaltyIdempotencyKey(input.idempotencyKey);

  // قفل صفّ الطلب ثمّ العميل أولاً لتوحيد ترتيب الأقفال مع الاستبدال والاكتساب
  const orderRow = (
    await tx
      .select({
        customerId: onlineOrders.customerId,
        total: onlineOrders.total,
        shippingCost: onlineOrders.shippingCost,
      })
      .from(onlineOrders)
      .where(eq(onlineOrders.id, input.onlineOrderId))
      .for("update")
      .limit(1)
  )[0];
  let lockedCustomerId =
    orderRow?.customerId != null && Number(orderRow.customerId) > 0
      ? Number(orderRow.customerId)
      : 0;
  if (lockedCustomerId > 0) {
    await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, lockedCustomerId))
      .for("update")
      .limit(1);
  }

  const existingByKey = (
    await tx
      .select({ id: loyaltyLedgerEntries.id })
      .from(loyaltyLedgerEntries)
      .where(eq(loyaltyLedgerEntries.idempotencyKey, boundedIdempotencyKey))
      .limit(1)
  )[0];
  if (existingByKey) return null;

  const earnRow = (
    await tx
      .select()
      .from(loyaltyLedgerEntries)
      .where(
        and(
          eq(loyaltyLedgerEntries.onlineOrderId, input.onlineOrderId),
          eq(loyaltyLedgerEntries.entryType, "ORDER_EARN"),
        ),
      )
      .orderBy(asc(loyaltyLedgerEntries.id))
      .for("update")
      .limit(1)
  )[0];
  if (!earnRow) return null;

  const earnCustomerId = Number(earnRow.customerId);
  if (earnCustomerId > 0 && earnCustomerId !== lockedCustomerId) {
    await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, earnCustomerId))
      .for("update")
      .limit(1);
    lockedCustomerId = earnCustomerId;
  }

  const earnedPoints = round2(money(earnRow.pointsDelta));
  if (!earnedPoints.gt(0)) return null;

  const account = (
    await tx
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.id, Number(earnRow.accountId)))
      .for("update")
      .limit(1)
  )[0];
  if (!account) return null;

  let originalNetMerchandise = parseOriginalEarnedNetMerchandise(earnRow.note);
  if (!originalNetMerchandise && orderRow) {
    const fallback = round2(
      Decimal.max(
        0,
        money(orderRow.total ?? "0").minus(money(orderRow.shippingCost ?? "0")),
      ),
    );
    if (fallback.gt(0)) originalNetMerchandise = fallback;
  }
  if (!originalNetMerchandise || !originalNetMerchandise.gt(0)) return null;

  const clampedRemainingIqd = Decimal.min(
    originalNetMerchandise,
    Decimal.max(0, round2(money(input.remainingNetMerchandiseIqd))),
  );
  const targetRetainedPoints = round2(
    earnedPoints.times(clampedRemainingIqd).dividedBy(originalNetMerchandise),
  );

  // قراءة قافلة حالية (FOR UPDATE) لتجاوز لقطة REPEATABLE READ القديمة عند تداخل مرتجعين جزئيين
  const priorReversals = await tx
    .select({
      idempotencyKey: loyaltyLedgerEntries.idempotencyKey,
      pointsDelta: loyaltyLedgerEntries.pointsDelta,
      note: loyaltyLedgerEntries.note,
    })
    .from(loyaltyLedgerEntries)
    .where(
      and(
        eq(loyaltyLedgerEntries.accountId, Number(account.id)),
        eq(loyaltyLedgerEntries.onlineOrderId, input.onlineOrderId),
        eq(loyaltyLedgerEntries.entryType, "ORDER_REVERSE"),
      ),
    )
    .for("update");
  if (priorReversals.some((rev) => rev.idempotencyKey === boundedIdempotencyKey)) {
    return null;
  }

  let priorAccountedClawback = money(0);
  for (const rev of priorReversals) {
    const deducted = money(rev.pointsDelta).abs();
    const unrecovered = parseUnrecoveredPointsFromNote(rev.note);
    priorAccountedClawback = priorAccountedClawback
      .plus(deducted)
      .plus(unrecovered);
  }

  const cumulativeTargetClawback = round2(
    Decimal.max(0, earnedPoints.minus(targetRetainedPoints)),
  );
  const requiredClawback = round2(
    Decimal.max(0, cumulativeTargetClawback.minus(priorAccountedClawback)),
  );
  if (!requiredClawback.gt(0)) return null;

  const availableBalance = round2(
    Decimal.max(0, money(account.pointsBalance ?? "0")),
  );
  const actualDeducted = round2(
    Decimal.min(requiredClawback, availableBalance),
  );
  const unrecovered = round2(requiredClawback.minus(actualDeducted));
  const nextBalance = round2(
    Decimal.max(0, availableBalance.minus(actualDeducted)),
  );

  if (actualDeducted.gt(0)) {
    await tx
      .update(loyaltyAccounts)
      .set({ pointsBalance: toDbMoney(nextBalance) })
      .where(eq(loyaltyAccounts.id, Number(account.id)));
  }

  const deltaSigned = actualDeducted.gt(0) ? actualDeducted.negated() : money(0);
  const unrecoveredSuffix = unrecovered.gt(0)
    ? ` — تعذّر استرداد ${toDbMoney(unrecovered)} نقطة لاستنفاد الرصيد`
    : "";
  const maxReasonLen = Math.max(0, 255 - unrecoveredSuffix.length);
  const note = `${input.reasonLabel.slice(0, maxReasonLen)}${unrecoveredSuffix}`;

  await tx.insert(loyaltyLedgerEntries).values({
    accountId: Number(account.id),
    customerId: Number(earnRow.customerId),
    onlineOrderId: input.onlineOrderId,
    entryType: "ORDER_REVERSE",
    pointsDelta: toDbMoney(deltaSigned),
    balanceAfter: toDbMoney(nextBalance),
    idempotencyKey: boundedIdempotencyKey,
    note,
  });

  return {
    accountId: Number(account.id),
    reversed: toDbMoney(actualDeducted),
    unrecovered: toDbMoney(unrecovered),
    balance: toDbMoney(nextBalance),
  };
}

function extractCouponCodeFromLedgerNote(note: string | null): string | null {
  if (!note) return null;
  const bracketMatch = note.match(/\[CODE:([A-Z0-9-]+)\]/);
  if (bracketMatch?.[1]) return bracketMatch[1];
  const prefixMatch = note.match(/\b(LOY-[A-Z0-9-]+)\b/);
  return prefixMatch?.[1] ?? null;
}

async function generateUniqueLoyaltyCouponCode(tx: Tx): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const token = randomBytes(5).toString("hex").toUpperCase();
    const code = `LOY-${token.slice(0, 5)}-${token.slice(5)}`;
    const hash = hashCouponCode(code);
    const exists = (
      await tx
        .select({ id: coupons.id })
        .from(coupons)
        .where(eq(coupons.codeHash, hash))
        .limit(1)
    )[0];
    if (!exists) return code;
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: appErrorMessage({
      what: "تعذّر توليد رمز قسيمة الولاء",
      why: "حدث تصادم غير متوقّع أثناء توليد رمز القسيمة الفريد",
      doThis: "أعد المحاولة بعد لحظات",
    }),
  });
}

/**
 * استبدال ذاتي لنقاط العميل الموثّق بقسيمة خصم شخصية فورية قابلة للاستخدام في المتجر.
 * محمي بـ idempotencyKey وبقفل صفوف البرنامج والحساب لمنع السحب المزدوج بالتزامن.
 */
export async function redeemStorefrontLoyaltyPoints(input: {
  customerSessionToken: string;
  points: number;
  clientRequestId: string;
}): Promise<LoyaltyRedeemResult> {
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "عدد النقاط غير صالح",
        why: "يجب إدخال عدد صحيح موجب من النقاط للاستبدال",
        doThis: "أدخل عدداً صحيحاً من النقاط ثم أعد المحاولة",
      }),
    });
  }
  const trimmedRequestId = input.clientRequestId.trim();
  if (trimmedRequestId.length < 8 || trimmedRequestId.length > 80) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "معرّف طلب الاستبدال غير صالح",
        why: "مفتاح عدم التكرار خارج النطاق المسموح",
        doThis: "حدّث الشاشة وأعد المحاولة",
      }),
    });
  }

  const session = await requireActiveStorefrontCustomer(
    input.customerSessionToken,
  );
  const idempotencyKey = buildRedeemIdempotencyKey(
    session.customerId,
    trimmedRequestId,
  );

  return retryOnDeadlock(() =>
    withTx(async (tx) => {
      // ترتيب الأقفال الموحّد: customers -> loyaltyPrograms -> loyaltyAccounts
      const lockedCustomer = (
        await tx
          .select({
            id: customers.id,
            isActive: customers.isActive,
            deletedAt: customers.deletedAt,
          })
          .from(customers)
          .where(eq(customers.id, session.customerId))
          .for("update")
          .limit(1)
      )[0];
      if (
        !lockedCustomer ||
        lockedCustomer.isActive === false ||
        lockedCustomer.deletedAt != null
      ) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: appErrorMessage({
            what: "انتهت صلاحية جلسة العميل",
            why: "لم يعد الحساب نشطاً لإصدار قسائم الولاء",
            doThis: "أعد تسجيل الدخول وتحقق من رقم هاتفك",
          }),
        });
      }

      const existingRedeem = (
        await tx
          .select()
          .from(loyaltyLedgerEntries)
          .where(eq(loyaltyLedgerEntries.idempotencyKey, idempotencyKey))
          .limit(1)
      )[0];
    if (existingRedeem) {
      const priorRedeemedPoints = Math.round(
        money(existingRedeem.pointsDelta).abs().toNumber(),
      );
      if (priorRedeemedPoints !== input.points) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعارض في إعادة إرسال طلب الاستبدال",
            why: "تم استخدام معرّف الطلب نفسه مسبقاً لعدد نقاط مختلف",
            doThis: "أعد المحاولة بطلب استبدال جديد",
          }),
        });
      }
      const existingCode = extractCouponCodeFromLedgerNote(existingRedeem.note);
      if (existingCode) {
        const couponRow = (
          await tx
            .select({
              code: coupons.code,
              programName: couponPrograms.name,
              validTo: couponPrograms.validTo,
              discountAmount: promotions.discountAmount,
              minOrderSpend: promotions.minOrderSpend,
            })
            .from(coupons)
            .innerJoin(couponPrograms, eq(coupons.programId, couponPrograms.id))
            .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
            .where(eq(coupons.codeHash, hashCouponCode(existingCode)))
            .limit(1)
        )[0];
        const currentAcc = (
          await tx
            .select({ pointsBalance: loyaltyAccounts.pointsBalance })
            .from(loyaltyAccounts)
            .where(eq(loyaltyAccounts.id, Number(existingRedeem.accountId)))
            .limit(1)
        )[0];
        if (couponRow) {
          return {
            outcome: "REPLAYED",
            code: couponRow.code,
            programName: couponRow.programName,
            discountIqd: toDbMoney(couponRow.discountAmount),
            minOrderSpendIqd: toDbMoney(couponRow.minOrderSpend),
            pointsRedeemed: priorRedeemedPoints,
            pointsBalance: toDbMoney(
              currentAcc?.pointsBalance ?? existingRedeem.balanceAfter,
            ),
            validTo: couponRow.validTo ?? null,
          };
        }
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر استرجاع قسيمة الاستبدال السابقة",
          why: "تم تنفيذ طلب الاستبدال هذا مسبقاً ولكن لم تعد القسيمة المرتبطة متاحة للإعادة",
          doThis: "تحقق من قسائمك الفعّالة أو أعد المحاولة بطلب استبدال جديد",
        }),
      });
    }

    const program = (
      await tx
        .select()
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.status, "ACTIVE"))
        .orderBy(desc(loyaltyPrograms.updatedAt))
        .for("update")
        .limit(1)
    )[0];
    if (!program) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر استبدال نقاط الولاء",
          why: "برنامج الولاء غير مفعّل حالياً",
          doThis: "جرّب لاحقاً بعد تفعيل برنامج الولاء من الإدارة",
        }),
      });
    }

    const iqdPerPoint = money(program.iqdDiscountPerPoint);
    if (!iqdPerPoint.gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذّر استبدال نقاط الولاء",
          why: "لم تحدّد الإدارة قيمة الخصم بالدينار لكل نقطة بعد",
          doThis: "تواصل مع خدمة العملاء أو حاول لاحقاً",
        }),
      });
    }

    const minPoints = Number(program.minRedeemPoints ?? 0);
    if (input.points < minPoints) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "النقاط المطلوب استبدالها أقل من الحد الأدنى",
          why: `الحد الأدنى للاستبدال هو ${minPoints} نقطة بينما أدخلت ${input.points} نقطة`,
          doThis: `أدخل ${minPoints} نقطة على الأقل للاستبدال`,
        }),
      });
    }

    const account = (
      await tx
        .select()
        .from(loyaltyAccounts)
        .where(
          and(
            eq(loyaltyAccounts.programId, Number(program.id)),
            eq(loyaltyAccounts.customerId, session.customerId),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    const availableBalance = round2(money(account?.pointsBalance ?? "0"));
    if (!account || availableBalance.lt(input.points)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "رصيد النقاط غير كافٍ للاستبدال",
          why: `رصيدك المتاح حالياً ${toDbMoney(availableBalance)} نقطة وهو أقل من ${input.points} نقطة`,
          doThis: "اختر عدداً من النقاط ضمن رصيدك المتاح",
        }),
      });
    }

    const discountIqd = round2(money(input.points).times(iqdPerPoint));
    if (!discountIqd.gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "قيمة القسيمة الناتجة غير صالحة",
          why: "نتج عن النقاط المختارة خصم صفري",
          doThis: "زد عدد النقاط المختارة للاستبدال",
        }),
      });
    }

    const maxPct = Number(program.maxRedeemPercent ?? 0);
    const minOrderSpend =
      maxPct > 0 && maxPct < 100
        ? round2(
            discountIqd
              .times(100)
              .dividedBy(maxPct)
              .toDecimalPlaces(0, Decimal.ROUND_CEIL),
          )
        : money(0);

    let creatorUserId: number | null =
      program.createdBy != null ? Number(program.createdBy) : null;
    if (creatorUserId != null) {
      const creatorExists = (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, creatorUserId))
          .limit(1)
      )[0];
      if (!creatorExists) creatorUserId = null;
    }
    if (creatorUserId == null) {
      const fallbackUser = (
        await tx
          .select({ id: users.id })
          .from(users)
          .orderBy(desc(users.isOwner), asc(users.id))
          .limit(1)
      )[0];
      if (!fallbackUser) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: appErrorMessage({
            what: "تعذّر إصدار قسيمة الولاء",
            why: "لا يوجد مستخدم إداري مرجعي لربط برنامج القسائم",
            doThis: "أبلغ إدارة المتجر بمراجعة إعدادات المستخدمين",
          }),
        });
      }
      creatorUserId = Number(fallbackUser.id);
    }

    const todayYmd = baghdadToday();
    const validFromDate = utcDayStart(todayYmd);
    const validToDate =
      program.expiresAfterDays != null && Number(program.expiresAfterDays) > 0
        ? new Date(
            validFromDate.getTime() +
              Number(program.expiresAfterDays) * 24 * 60 * 60 * 1000,
          )
        : null;
    const validToYmd = validToDate ? validToDate.toISOString().slice(0, 10) : null;

    const discountDb = toDbMoney(discountIqd);
    const minSpendDb = toDbMoney(minOrderSpend);
    const couponProgramTitle = `مكافأة ولاء (${Number(discountIqd).toLocaleString("en-US")} د.ع)`;

    const reusableProgram = (
      await tx
        .select({
          programId: couponPrograms.id,
          programName: couponPrograms.name,
          validTo: couponPrograms.validTo,
        })
        .from(couponPrograms)
        .innerJoin(promotions, eq(couponPrograms.promotionId, promotions.id))
        .where(
          and(
            eq(couponPrograms.status, "ACTIVE"),
            eq(couponPrograms.codePrefix, "LOY"),
            eq(couponPrograms.isFirstOrderSelfService, false),
            isNull(couponPrograms.branchId),
            eq(couponPrograms.perCouponLimit, 1),
            sql`${couponPrograms.perCustomerLimit} >= 999999`,
            sql`${couponPrograms.validFrom} <= ${todayYmd}`,
            validToYmd
              ? sql`${couponPrograms.validTo} = ${validToYmd}`
              : isNull(couponPrograms.validTo),
            eq(promotions.isActive, true),
            eq(promotions.applicationMode, "COUPON"),
            eq(promotions.type, "AMOUNT"),
            eq(promotions.scope, "ALL"),
            isNull(promotions.branchId),
            isNull(promotions.customerTier),
            sql`${promotions.effectiveFrom} <= ${todayYmd}`,
            validToYmd
              ? sql`${promotions.effectiveTo} = ${validToYmd}`
              : isNull(promotions.effectiveTo),
            eq(promotions.discountAmount, discountDb),
            eq(promotions.maxDiscountAmount, discountDb),
            eq(promotions.minOrderSpend, minSpendDb),
          ),
        )
        .orderBy(desc(couponPrograms.id))
        .for("update")
        .limit(1)
    )[0];

    let couponProgramId: number;
    let couponProgramName: string;
    let resolvedValidTo: Date | null;

    if (reusableProgram) {
      couponProgramId = Number(reusableProgram.programId);
      couponProgramName = reusableProgram.programName;
      resolvedValidTo = reusableProgram.validTo ?? null;
    } else {
      const promoInsert = await tx.insert(promotions).values({
        name: couponProgramTitle,
        description: `قسيمة خصم ناتجة عن استبدال نقاط برنامج «${program.name}»`,
        type: "AMOUNT",
        discountPercent: "0.00",
        discountAmount: discountDb,
        maxDiscountAmount: discountDb,
        minLineAmount: "0.00",
        minOrderSpend: minSpendDb,
        scope: "ALL",
        effectiveFrom: validFromDate,
        effectiveTo: validToDate,
        customerTier: null,
        branchId: null,
        freeShipping: false,
        shippingDiscountAmount: "0.00",
        priority: 100,
        isActive: true,
        applicationMode: "COUPON",
        isStoreManaged: true,
        createdBy: creatorUserId,
      });
      const promotionId = extractInsertId(promoInsert);

      const cpInsert = await tx.insert(couponPrograms).values({
        promotionId,
        name: couponProgramTitle,
        status: "ACTIVE",
        branchId: null,
        validFrom: validFromDate,
        validTo: validToDate,
        perCouponLimit: 1,
        perCustomerLimit: 999_999,
        isFirstOrderSelfService: false,
        codePrefix: "LOY",
        createdBy: creatorUserId,
      });
      couponProgramId = extractInsertId(cpInsert);
      couponProgramName = couponProgramTitle;
      resolvedValidTo = validToDate;
    }

    const code = await generateUniqueLoyaltyCouponCode(tx);
    await tx.insert(coupons).values({
      programId: couponProgramId,
      code,
      codeHash: hashCouponCode(code),
      customerId: session.customerId,
      status: "ACTIVE",
      redemptionCount: 0,
      issuedAt: new Date(),
    });

    const nextBalance = round2(availableBalance.minus(input.points));
    await tx
      .update(loyaltyAccounts)
      .set({ pointsBalance: toDbMoney(nextBalance) })
      .where(eq(loyaltyAccounts.id, Number(account.id)));

    await tx.insert(loyaltyLedgerEntries).values({
      accountId: Number(account.id),
      customerId: session.customerId,
      onlineOrderId: null,
      entryType: "REDEEM",
      pointsDelta: toDbMoney(money(input.points).negated()),
      balanceAfter: toDbMoney(nextBalance),
      idempotencyKey,
      note: `استبدال ${input.points} نقطة بقسيمة خصم ${discountDb} د.ع [CODE:${code}]`,
    });

    return {
      outcome: "ISSUED",
      code,
      programName: couponProgramName,
      discountIqd: discountDb,
      minOrderSpendIqd: minSpendDb,
      pointsRedeemed: input.points,
      pointsBalance: toDbMoney(nextBalance),
      validTo: resolvedValidTo,
    };
  }),
  );
}

export async function loyaltyOverview(limit = 30) {
  const db = getDb();
  if (!db) return { accounts: [], totalPoints: "0" };
  const accounts = await db
    .select({
      customerId: customers.id,
      customerName: customers.name,
      pointsBalance: loyaltyAccounts.pointsBalance,
      programName: loyaltyPrograms.name,
      updatedAt: loyaltyAccounts.updatedAt,
    })
    .from(loyaltyAccounts)
    .innerJoin(customers, eq(loyaltyAccounts.customerId, customers.id))
    .innerJoin(loyaltyPrograms, eq(loyaltyAccounts.programId, loyaltyPrograms.id))
    .orderBy(desc(loyaltyAccounts.pointsBalance))
    .limit(limit);
  const total = (
    await db
      .select({
        value: sql<string>`COALESCE(SUM(${loyaltyAccounts.pointsBalance}), 0)`,
      })
      .from(loyaltyAccounts)
  )[0];
  return { accounts, totalPoints: String(total?.value ?? "0") };
}

export async function listLoyaltyLedgerEntries(input?: {
  limit?: number;
  entryType?: LoyaltyLedgerEntryType;
}) {
  const db = getDb();
  if (!db) return [];
  const safeLimit = Math.min(Math.max(input?.limit ?? 100, 1), 200);
  const rows = await db
    .select({
      id: loyaltyLedgerEntries.id,
      customerId: loyaltyLedgerEntries.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      onlineOrderId: loyaltyLedgerEntries.onlineOrderId,
      orderNumber: onlineOrders.orderNumber,
      entryType: loyaltyLedgerEntries.entryType,
      pointsDelta: loyaltyLedgerEntries.pointsDelta,
      balanceAfter: loyaltyLedgerEntries.balanceAfter,
      note: loyaltyLedgerEntries.note,
      createdAt: loyaltyLedgerEntries.createdAt,
    })
    .from(loyaltyLedgerEntries)
    .innerJoin(customers, eq(loyaltyLedgerEntries.customerId, customers.id))
    .leftJoin(onlineOrders, eq(loyaltyLedgerEntries.onlineOrderId, onlineOrders.id))
    .where(
      input?.entryType
        ? eq(loyaltyLedgerEntries.entryType, input.entryType)
        : undefined,
    )
    .orderBy(desc(loyaltyLedgerEntries.id))
    .limit(safeLimit);

  return rows.map((row) => ({
    id: Number(row.id),
    customerId: Number(row.customerId),
    customerName: row.customerName,
    customerPhone: row.customerPhone ?? null,
    onlineOrderId: row.onlineOrderId == null ? null : Number(row.onlineOrderId),
    orderNumber: row.orderNumber ?? null,
    entryType: row.entryType,
    pointsDelta: String(row.pointsDelta),
    balanceAfter: String(row.balanceAfter),
    note: row.note ?? null,
    createdAt: row.createdAt,
  }));
}
