/**
 * نيّة البيع الرقميّ والتنفيذ الخارجيّ (ش٧).
 *
 * **الخطر الذي تُلغيه هذه الشريحة:** «طُبع الكرت من جهاز المزوّد ثم فشل حفظ البيع فلم يبقَ له أثر».
 * الحلّ: تُسجَّل النيّة **قبل** لمس جهاز المزوّد، ويُسجَّل نجاح كل كرت لحظةَ إصداره. فإذا انهار
 * المتصفّح أو الشبكة بعد ذلك، يبقى الكرت المُصدَر مسجَّلاً في القاعدة وقابلاً للاسترداد الإداريّ.
 *
 * ثوابت لا تُكسَر:
 *   • `prepare` **لا يُنشئ فاتورة ولا يخفض رصيد محفظة** — يحجز فقط (reservedBalance) تحت قفل.
 *   • القفل بترتيب `walletId` تصاعدياً في كل المسارات ⇒ استحالة deadlock بين نيّتين متزامنتين.
 *   • بندٌ سُجِّل `SUCCESS` **لا يُلغى ولا يُحرَّر حجزه أبداً** — لا بالانتهاء ولا بالإلغاء؛
 *     النيّة تنتقل إلى `NEEDS_REVIEW` ويُعالَج الأثر الماليّ بقرارٍ إداريّ صريح.
 *   • تكرار مرجع التنفيذ لدى المزوّد نفسه يمنعه **قيدٌ في القاعدة** (هجرة 0127) لا فحصٌ تطبيقيّ.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceVersions,
  digitalProviders,
  digitalSaleIntentItems,
  digitalSaleIntents,
  digitalWalletReservations,
  digitalWallets,
  products,
  shifts,
  suppliers,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, sumMoney, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";
import { normalizeSnapshot, type StudentSnapshot } from "./studentService";

/* ────────── الأنواع ────────── */

export interface PrepareLine {
  /** مفتاح السطر من السلة — يجعل كرتين من الفئة نفسها بندَين مستقلَّين. */
  lineKey: string;
  offeringId: number;
  /** إصدار السعر الذي عُرض للزبون — يُقارَن بالنافذ خادمياً ويُرفض إن انحرف. */
  priceVersionId: number;
  /** السعر كما عُرض — يُقارَن ولا يُوثَق به. */
  expectedSellPrice: string;
  student?: StudentSnapshot | null;
}

export interface PrepareInput {
  clientRequestId: string;
  branchId: number;
  shiftId: number;
  paymentMethod: string;
  cartFingerprint: string;
  lines: PrepareLine[];
}

/** مهلة النيّة: نافذةٌ معقولة لإصدار الكروت من جهاز المزوّد قبل أن تُعتبر مهجورة. */
const INTENT_TTL_MINUTES = 30;

/** طرق الدفع المسموحة للبيع الرقميّ (§٢ من الوثيقة: لا آجل على الكروت في الإصدار الأول). */
const ALLOWED_PAYMENT_METHODS = new Set(["CASH", "CARD"]);

async function auditLog(tx: Tx, actor: Actor, action: string, entityId: number, details: unknown): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalSaleIntent",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort
  }
}

/* ────────── إعداد النيّة ────────── */

export async function prepare(
  tx: Tx,
  input: PrepareInput,
  actor: Actor,
): Promise<{ intentId: number; replay: boolean; expiresAt: Date }> {
  // idempotency: نقرة مزدوجة/إعادة إرسال بنفس المفتاح تُعيد النيّة القائمة بدل حجزٍ ثانٍ.
  const [existing] = await tx
    .select({ id: digitalSaleIntents.id, expiresAt: digitalSaleIntents.expiresAt, status: digitalSaleIntents.status, fp: digitalSaleIntents.cartFingerprint })
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.clientRequestId, input.clientRequestId))
    .limit(1);
  if (existing) {
    if (existing.fp !== input.cartFingerprint) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "نفس مفتاح الطلب بسلّةٍ مختلفة — أعد فتح فاتورة جديدة",
      });
    }
    return { intentId: Number(existing.id), replay: true, expiresAt: existing.expiresAt };
  }

  if (!input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا كروت في السلة" });
  }
  if (!ALLOWED_PAYMENT_METHODS.has(input.paymentMethod)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "البيع الرقميّ نقداً أو ببطاقة فقط — لا آجل على الكروت",
    });
  }
  const keys = new Set(input.lines.map((l) => l.lineKey));
  if (keys.size !== input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفاتيح أسطر مكرّرة في السلة" });
  }

  // وردية مفتوحة ومملوكة للفاعل في الفرع نفسه.
  const [shift] = await tx
    .select({ id: shifts.id, branchId: shifts.branchId, userId: shifts.userId, status: shifts.status })
    .from(shifts)
    .where(eq(shifts.id, input.shiftId))
    .limit(1);
  if (!shift || shift.status !== "OPEN") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا وردية مفتوحة" });
  }
  if (Number(shift.branchId) !== input.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الوردية تخصّ فرعاً آخر" });
  }
  if (Number(shift.userId) !== actor.userId && actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "الوردية تخصّ مستخدماً آخر" });
  }

  const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1);
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

  // تحقّق كل بند مقابل الحالة الخادمية اللحظية.
  type Resolved = {
    line: PrepareLine;
    offeringId: number;
    providerId: number;
    settlementMode: string;
    walletId: number | null;
    name: string;
    requiresStudentData: boolean;
    sellPrice: string;
    providerShare: string;
    margin: string;
    priceVersionId: number;
    student: StudentSnapshot | null;
  };
  const resolved: Resolved[] = [];

  for (const line of input.lines) {
    const [row] = await tx
      .select({
        offeringId: digitalOfferings.id,
        providerId: digitalOfferings.providerId,
        name: products.name,
        isActive: digitalOfferings.isActive,
        requiresStudentData: digitalOfferings.requiresStudentData,
        priceValidityHours: digitalOfferings.priceValidityHours,
        providerActive: digitalProviders.isActive,
        settlementMode: digitalProviders.settlementMode,
        branchActive: digitalOfferingBranches.isActive,
        walletId: digitalOfferingBranches.walletId,
        currentVersionId: digitalCurrentPrices.priceVersionId,
        sellPrice: digitalPriceVersions.sellPrice,
        providerShare: digitalPriceVersions.providerShare,
        margin: digitalPriceVersions.marginAmount,
        validFrom: digitalPriceVersions.validFrom,
        validUntil: digitalPriceVersions.validUntil,
      })
      .from(digitalOfferings)
      .innerJoin(products, eq(digitalOfferings.productId, products.id))
      .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
      .innerJoin(
        digitalOfferingBranches,
        and(
          eq(digitalOfferingBranches.offeringId, digitalOfferings.id),
          eq(digitalOfferingBranches.branchId, input.branchId),
        ),
      )
      .leftJoin(
        digitalCurrentPrices,
        and(
          eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
          eq(digitalCurrentPrices.branchId, input.branchId),
        ),
      )
      .leftJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
      .where(eq(digitalOfferings.id, line.offeringId))
      .limit(1);

    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "بطاقة غير متاحة في هذا الفرع" });
    if (!row.isActive || !row.providerActive || !row.branchActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» لم تعد متاحة للبيع` });
    }
    if (row.currentVersionId == null || row.sellPrice == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» بلا سعر منشور` });
    }
    if (Number(row.currentVersionId) !== line.priceVersionId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `تغيّر سعر «${row.name}» — أزِل الكرت وأعِد إضافته بالسعر الجديد`,
      });
    }
    if (row.validUntil != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `انتهى سريان سعر «${row.name}»` });
    }
    if (row.priceValidityHours != null && row.validFrom != null) {
      const ageHours = (Date.now() - new Date(row.validFrom).getTime()) / 3_600_000;
      if (ageHours > row.priceValidityHours) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `سعر «${row.name}» يحتاج تحديثاً` });
      }
    }
    if (!money(line.expectedSellPrice).eq(money(row.sellPrice))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `سعر «${row.name}» في الشاشة لا يطابق سعر الخادم — حدّث السلة`,
      });
    }

    let student: StudentSnapshot | null = null;
    if (row.requiresStudentData) {
      if (!line.student) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» يتطلّب بيانات الطالب` });
      }
      student = normalizeSnapshot(line.student);
    } else if (line.student) {
      // بند غير تعليميّ يجب أن تبقى حقول الطالب فارغة (§٥.٩).
      throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» لا يقبل بيانات طالب` });
    }

    if (row.settlementMode === "PREPAID" && row.walletId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `«${row.name}» مزوّده مسبق الدفع بلا محفظة مربوطة بهذا الفرع`,
      });
    }

    resolved.push({
      line,
      offeringId: Number(row.offeringId),
      providerId: Number(row.providerId),
      settlementMode: row.settlementMode,
      walletId: row.walletId != null ? Number(row.walletId) : null,
      name: row.name,
      requiresStudentData: row.requiresStudentData,
      sellPrice: row.sellPrice,
      providerShare: row.providerShare!,
      margin: row.margin!,
      priceVersionId: Number(row.currentVersionId),
      student,
    });
  }

  // حجز أرصدة المحافظ المسبقة: **قفلٌ بترتيب walletId تصاعدياً** (منع deadlock)، والكفاية
  // تُحسب على المتاح = الرصيد − المحجوز الفعّال، لا على الرصيد وحده.
  const needByWallet = new Map<number, string[]>();
  for (const r of resolved) {
    if (r.settlementMode !== "PREPAID" || r.walletId == null) continue;
    const list = needByWallet.get(r.walletId) ?? [];
    list.push(r.providerShare);
    needByWallet.set(r.walletId, list);
  }
  const walletIds = Array.from(needByWallet.keys()).sort((a, b) => a - b);

  const expiresAt = new Date(Date.now() + INTENT_TTL_MINUTES * 60_000);
  const expectedTotal = toDbMoney(sumMoney(resolved.map((r) => r.sellPrice)));

  const intentRes = await tx.insert(digitalSaleIntents).values({
    clientRequestId: input.clientRequestId,
    branchId: input.branchId,
    shiftId: input.shiftId,
    createdBy: actor.userId,
    status: "PREPARED",
    cartFingerprint: input.cartFingerprint,
    paymentMethod: input.paymentMethod,
    expectedTotal,
    expiresAt,
  });
  const intentId = extractInsertId(intentRes);

  for (const walletId of walletIds) {
    const [wallet] = await tx
      .select({
        id: digitalWallets.id,
        name: digitalWallets.name,
        isActive: digitalWallets.isActive,
        currentBalance: digitalWallets.currentBalance,
        reservedBalance: digitalWallets.reservedBalance,
      })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update");
    if (!wallet) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
    if (!wallet.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `المحفظة «${wallet.name}» معطَّلة` });
    }

    const need = sumMoney(needByWallet.get(walletId)!);
    const available = money(wallet.currentBalance).minus(money(wallet.reservedBalance));
    if (available.lt(need)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `رصيد «${wallet.name}» لا يكفي: المتاح ${toDbMoney(available)} والمطلوب ${toDbMoney(need)}. ` +
          `أودِع رصيداً أو أزِل بعض الكروت.`,
      });
    }

    await tx.insert(digitalWalletReservations).values({
      walletId,
      intentId,
      amount: toDbMoney(need),
      status: "ACTIVE",
    });
    await tx
      .update(digitalWallets)
      .set({ reservedBalance: toDbMoney(money(wallet.reservedBalance).plus(need)) })
      .where(eq(digitalWallets.id, walletId));
  }

  for (const r of resolved) {
    await tx.insert(digitalSaleIntentItems).values({
      intentId,
      lineKey: r.line.lineKey,
      offeringId: r.offeringId,
      providerId: r.providerId,
      priceVersionId: r.priceVersionId,
      sellPriceSnapshot: r.sellPrice,
      providerShareSnapshot: r.providerShare,
      marginSnapshot: r.margin,
      fulfillmentStatus: "PENDING",
      studentCustomerId: r.student?.customerId ?? null,
      studentNameSnapshot: r.student?.studentName ?? null,
      studentPhoneSnapshot: r.student?.studentPhone ?? null,
      guardianPhoneSnapshot: r.student?.guardianPhone ?? null,
      studentAddressSnapshot: r.student?.address ?? null,
    });
  }

  await auditLog(tx, actor, "digitalCards.intent.prepared", intentId, {
    branchId: input.branchId,
    items: resolved.length,
    expectedTotal,
  });

  return { intentId, replay: false, expiresAt };
}

/* ────────── تسجيل التنفيذ الخارجيّ ────────── */

export type ExecutionStatus = "SUCCESS" | "FAILED" | "UNKNOWN";

export async function markExecution(
  tx: Tx,
  input: { intentId: number; intentItemId: number; status: ExecutionStatus; providerReference?: string | null },
  actor: Actor,
): Promise<{ itemId: number; status: ExecutionStatus; allSettled: boolean; idempotent: boolean }> {
  const intent = await lockIntent(tx, input.intentId);
  assertActorOwnsIntent(intent, actor);
  if (intent.status === "FINALIZED" || intent.status === "CANCELLED") {
    throw new TRPCError({ code: "CONFLICT", message: "النيّة أُغلقت — لا تُعدَّل" });
  }

  const [item] = await tx
    .select()
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.id, input.intentItemId), eq(digitalSaleIntentItems.intentId, input.intentId)))
    .for("update");
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "بند التنفيذ غير موجود" });

  const ref = input.providerReference?.trim() || null;

  // idempotency: نفس الحالة ونفس المرجع ⇒ لا شيء (نقرة مزدوجة/إعادة إرسال بعد انقطاع).
  if (item.fulfillmentStatus === input.status && (item.providerReference ?? null) === ref) {
    return { itemId: Number(item.id), status: input.status, allSettled: await allItemsSettled(tx, input.intentId), idempotent: true };
  }

  // **لا رجوع عن النجاح من الكاشير**: الكرت صدر فعلاً؛ التصحيح قرارٌ إداريّ (عكسٌ موثَّق).
  if (item.fulfillmentStatus === "SUCCESS" && actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يُلغى نجاحُ كرتٍ صدر فعلاً — راجِع المدير",
    });
  }

  // سياسة المرجع للمزوّد.
  const [provider] = await tx
    .select({ referencePolicy: digitalProviders.referencePolicy, name: suppliers.name })
    .from(digitalProviders)
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(eq(digitalProviders.id, Number(item.providerId)))
    .limit(1);
  if (input.status === "SUCCESS" && provider?.referencePolicy === "REQUIRED" && !ref) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `مزوّد «${provider.name}» يتطلّب رقم مرجع التنفيذ` });
  }
  if (provider?.referencePolicy === "NONE" && ref) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `مزوّد «${provider.name}» لا يستعمل مرجع تنفيذ` });
  }

  try {
    await tx
      .update(digitalSaleIntentItems)
      .set({
        fulfillmentStatus: input.status,
        providerReference: ref,
        confirmedBy: actor.userId,
        confirmedAt: new Date(),
      })
      .where(eq(digitalSaleIntentItems.id, input.intentItemId));
  } catch (e) {
    // القيد الفريد `uq_dsii_provider_ref` (هجرة 0127). drizzle يغلّف خطأ السائق ⇒ نفكّ
    // سلسلة `cause` كما في `isDupUserId` بـemployeeService (نفس الاصطلاح).
    if (isDupProviderRef(e)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رقم المرجع مسجَّل لكرتٍ آخر من هذا المزوّد — تحقّق من الرقم",
      });
    }
    throw e;
  }

  if (intent.status === "PREPARED") {
    await tx.update(digitalSaleIntents).set({ status: "EXECUTING" }).where(eq(digitalSaleIntents.id, input.intentId));
  }

  const allSettled = await allItemsSettled(tx, input.intentId);
  if (allSettled) {
    const anyFailed = await hasNonSuccess(tx, input.intentId);
    await tx
      .update(digitalSaleIntents)
      .set({ status: anyFailed ? "NEEDS_REVIEW" : "EXECUTED" })
      .where(eq(digitalSaleIntents.id, input.intentId));
  }

  await auditLog(tx, actor, "digitalCards.intent.execution", input.intentId, {
    itemId: input.intentItemId,
    status: input.status,
    hasReference: ref != null,
  });

  return { itemId: Number(item.id), status: input.status, allSettled, idempotent: false };
}

/* ────────── الإلغاء والانتهاء ────────── */

/**
 * إلغاء نيّة **لم يُنفَّذ منها شيء**: يحرّر الحجوزات ويعيد الرصيد المحجوز.
 * وجودُ بندٍ ناجحٍ واحد يمنع الإلغاء ⇒ تنتقل إلى NEEDS_REVIEW بدلاً منه.
 */
export async function cancelIntent(
  tx: Tx,
  input: { intentId: number; reason?: string | null },
  actor: Actor,
): Promise<{ intentId: number; outcome: "CANCELLED" | "NEEDS_REVIEW" }> {
  const intent = await lockIntent(tx, input.intentId);
  assertActorOwnsIntent(intent, actor);
  if (intent.status === "FINALIZED") {
    throw new TRPCError({ code: "CONFLICT", message: "النيّة مُثبَّتة بفاتورة — لا تُلغى" });
  }
  if (intent.status === "CANCELLED") {
    return { intentId: input.intentId, outcome: "CANCELLED" };
  }

  const executed = await hasSuccessfulItem(tx, input.intentId);
  if (executed) {
    // الحجز **لا يُحرَّر**: كرتٌ صدر فعلاً وله أثرٌ ماليّ مستحقّ. المراجعة الإدارية تحسمه.
    await tx.update(digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(digitalSaleIntents.id, input.intentId));
    await auditLog(tx, actor, "digitalCards.intent.needsReview", input.intentId, { reason: input.reason ?? "cancel-after-execution" });
    return { intentId: input.intentId, outcome: "NEEDS_REVIEW" };
  }

  await releaseReservations(tx, input.intentId);
  await tx.update(digitalSaleIntents).set({ status: "CANCELLED" }).where(eq(digitalSaleIntents.id, input.intentId));
  await auditLog(tx, actor, "digitalCards.intent.cancelled", input.intentId, { reason: input.reason ?? null });
  return { intentId: input.intentId, outcome: "CANCELLED" };
}

/**
 * كنّاس النيّات المنتهية: يحرّر حجوزات النيّات **الخالية من أي تنفيذ** ويجعلها EXPIRED،
 * ويحوّل ما نُفِّذ منها شيءٌ إلى NEEDS_REVIEW **دون تحرير حجزه** (§٥.٩).
 */
export async function expireStaleIntents(
  tx: Tx,
  now: Date = new Date(),
): Promise<{ expired: number; needsReview: number }> {
  // **EXECUTED مشمولةٌ عمداً:** نيّةٌ صدرت كل كروتها ثم هُجرت قبل تثبيت الفاتورة (أُغلق المتصفّح،
  // انقطعت الشبكة) هي أخطر الحالات — كروتٌ بيد الزبون بلا فاتورة. لا يجوز تركها معلّقةً للأبد.
  const stale = await tx
    .select({ id: digitalSaleIntents.id })
    .from(digitalSaleIntents)
    .where(
      and(
        inArray(digitalSaleIntents.status, ["PREPARED", "EXECUTING", "EXECUTED"]),
        lt(digitalSaleIntents.expiresAt, now),
      ),
    )
    .orderBy(asc(digitalSaleIntents.id))
    .limit(200);

  let expired = 0;
  let needsReview = 0;
  for (const s of stale) {
    const intentId = Number(s.id);
    await lockIntent(tx, intentId);
    if (await hasSuccessfulItem(tx, intentId)) {
      await tx.update(digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(digitalSaleIntents.id, intentId));
      needsReview++;
    } else {
      await releaseReservations(tx, intentId);
      await tx.update(digitalSaleIntents).set({ status: "EXPIRED" }).where(eq(digitalSaleIntents.id, intentId));
      expired++;
    }
  }
  return { expired, needsReview };
}

/* ────────── قراءات ────────── */

export async function getIntent(db: DB, intentId: number) {
  const [intent] = await db.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.id, intentId)).limit(1);
  if (!intent) return null;

  const items = await db
    .select({
      id: digitalSaleIntentItems.id,
      lineKey: digitalSaleIntentItems.lineKey,
      offeringId: digitalSaleIntentItems.offeringId,
      name: products.name,
      providerName: suppliers.name,
      referencePolicy: digitalProviders.referencePolicy,
      sellPrice: digitalSaleIntentItems.sellPriceSnapshot,
      fulfillmentStatus: digitalSaleIntentItems.fulfillmentStatus,
      providerReference: digitalSaleIntentItems.providerReference,
      studentName: digitalSaleIntentItems.studentNameSnapshot,
      confirmedAt: digitalSaleIntentItems.confirmedAt,
    })
    .from(digitalSaleIntentItems)
    .innerJoin(digitalOfferings, eq(digitalSaleIntentItems.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalSaleIntentItems.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(eq(digitalSaleIntentItems.intentId, intentId))
    .orderBy(asc(digitalSaleIntentItems.id));

  return { intent, items };
}

/** طابور المراجعة: نيّات فيها كرتٌ صدر ولم تُثبَّت بفاتورة — لا تُترك بلا معالجة. */
export async function listNeedsReview(db: DB, filters: { branchId?: number | null }) {
  const conds = [eq(digitalSaleIntents.status, "NEEDS_REVIEW" as const)];
  if (filters.branchId != null) conds.push(eq(digitalSaleIntents.branchId, filters.branchId));

  return db
    .select({
      id: digitalSaleIntents.id,
      branchId: digitalSaleIntents.branchId,
      branchName: branches.name,
      createdBy: digitalSaleIntents.createdBy,
      expectedTotal: digitalSaleIntents.expectedTotal,
      createdAt: digitalSaleIntents.createdAt,
      expiresAt: digitalSaleIntents.expiresAt,
      successCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i
        WHERE i.intentId = digitalSaleIntents.id AND i.fulfillmentStatus = 'SUCCESS'
      )`,
      itemCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i WHERE i.intentId = digitalSaleIntents.id
      )`,
    })
    .from(digitalSaleIntents)
    .innerJoin(branches, eq(digitalSaleIntents.branchId, branches.id))
    .where(and(...conds))
    .orderBy(asc(digitalSaleIntents.id))
    .limit(200);
}

/* ────────── مساعدات داخلية ────────── */

/** هل الخطأ تكرارٌ على قيد مرجع المزوّد؟ (نمط `isDupUserId` في employeeService — فكّ سلسلة cause.) */
function isDupProviderRef(e: unknown): boolean {
  const err = e as { code?: string; sqlMessage?: string; message?: string; cause?: unknown };
  const code =
    err?.code ??
    (err?.cause as { code?: string } | undefined)?.code ??
    ((err?.cause as { cause?: { code?: string } } | undefined)?.cause)?.code;
  if (code !== "ER_DUP_ENTRY") return false;
  const msg = String(
    err?.sqlMessage ??
      (err?.cause as { sqlMessage?: string } | undefined)?.sqlMessage ??
      err?.message ??
      "",
  );
  return /uq_dsii_provider_ref|refKey/i.test(msg);
}

async function lockIntent(tx: Tx, intentId: number) {
  const [intent] = await tx.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.id, intentId)).for("update");
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });
  return intent;
}

function assertActorOwnsIntent(intent: { createdBy: number; branchId: number }, actor: Actor): void {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (!elevated && Number(intent.createdBy) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه النيّة لمستخدم آخر" });
  }
}

async function allItemsSettled(tx: Tx, intentId: number): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.intentId, intentId), eq(digitalSaleIntentItems.fulfillmentStatus, "PENDING")));
  return Number(row?.n ?? 0) === 0;
}

async function hasNonSuccess(tx: Tx, intentId: number): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.intentId, intentId), ne(digitalSaleIntentItems.fulfillmentStatus, "SUCCESS")));
  return Number(row?.n ?? 0) > 0;
}

async function hasSuccessfulItem(tx: Tx, intentId: number): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.intentId, intentId), eq(digitalSaleIntentItems.fulfillmentStatus, "SUCCESS")));
  return Number(row?.n ?? 0) > 0;
}

/** يحرّر كل الحجوزات الفعّالة لنيّة ويعيد المبالغ إلى `reservedBalance` — بترتيب walletId. */
async function releaseReservations(tx: Tx, intentId: number): Promise<void> {
  const active = await tx
    .select({ id: digitalWalletReservations.id, walletId: digitalWalletReservations.walletId, amount: digitalWalletReservations.amount })
    .from(digitalWalletReservations)
    .where(and(eq(digitalWalletReservations.intentId, intentId), eq(digitalWalletReservations.status, "ACTIVE")))
    .orderBy(asc(digitalWalletReservations.walletId));

  for (const r of active) {
    const [wallet] = await tx
      .select({ reservedBalance: digitalWallets.reservedBalance })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, Number(r.walletId)))
      .for("update");
    if (!wallet) continue;
    // القصّ عند الصفر: حارسٌ ضد رصيدٍ محجوزٍ سالبٍ لو تسلّل تحريرٌ مزدوج.
    const next = money(wallet.reservedBalance).minus(money(r.amount));
    await tx
      .update(digitalWallets)
      .set({ reservedBalance: toDbMoney(next.lt(0) ? money(0) : next) })
      .where(eq(digitalWallets.id, Number(r.walletId)));
    await tx
      .update(digitalWalletReservations)
      .set({ status: "RELEASED", releasedAt: new Date() })
      .where(and(eq(digitalWalletReservations.id, Number(r.id)), eq(digitalWalletReservations.status, "ACTIVE")));
  }
}

/** يُستعمل في اختبارات الاتساق: مجموع الحجوزات الفعّالة لمحفظة. */
export async function activeReservedTotal(db: DB, walletId: number): Promise<string> {
  const rows = await db
    .select({ amount: digitalWalletReservations.amount })
    .from(digitalWalletReservations)
    .where(and(eq(digitalWalletReservations.walletId, walletId), eq(digitalWalletReservations.status, "ACTIVE")));
  return toDbMoney(sumMoney(rows.map((r) => r.amount)));
}

export const INTENT_TTL = INTENT_TTL_MINUTES;
