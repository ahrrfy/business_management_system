/**
 * شطب نيّةٍ عالقة (٣٠/٧/٢٦، قرار المالك) — مسار إنهاء `NEEDS_REVIEW`.
 *
 * **المشكلة التي يحلّها:** كرتٌ صدر من جهاز المزوّد ثمّ ضاع البيع (انقطاع/إغلاق متصفّح).
 * النيّة تعلق في `NEEDS_REVIEW`، وحجزُ محفظتها **لا يُحرَّر عمداً** (المال مستحقّ فعلاً)
 * لكن لم يكن ثمّة ما يُنهيها ⇒ الحجز مجمَّدٌ أبداً، والرصيد المتاح يتآكل بكل حالة،
 * والمطابقة اليومية تُظهر فرقاً دائماً لا يُغلق.
 *
 * **لماذا هو خسارة لا تسوية:** دفعنا حصة المزوّد ولم نقبض من زبون. فالقيد `DIGITAL_WRITEOFF`
 * **cost-only** (revenue=0، cost=الحصة، profit=−الحصة) على نمط `DELIVERY_WRITEOFF` — لا حركة
 * أصلٍ صفرية كبقية `DIGITAL_WALLET_*`. الدفاتر تُظهر الخسارة ولا تُخفيها.
 *
 * **لماذا باعتمادٍ ثنائيّ:** الشطب بابُ إخفاء عجزٍ بفاعلٍ واحد — لذا طالبٌ ثمّ معتمِدٌ آخر
 * (admin مُستثنى للتصحيح الإداريّ، نفس اصطلاح `approveAdjustment` و`approveStockAdjustment`).
 * الطلب **لا يمسّ مالاً إطلاقاً**؛ كل الأثر المالي في الاعتماد وحده وداخل معاملة واحدة.
 *
 * **مساران بحسب نمط التسوية** (كلاهما ينتهي بنفس الخسارة، ويختلفان في مصدرها):
 *   • PREPAID — الجهاز خصم فعلاً: الحجز يُستهلَك ورصيد المحفظة ينزل بالحصة فيطابق الواقع.
 *   • POSTPAID — المزوّد سيُطالبنا: ذمّته ترتفع بالحصة (لا محفظة ولا حجز أصلاً).
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  digitalProviders,
  digitalSaleIntentItems,
  digitalSaleIntents,
  digitalWalletReservations,
  digitalWalletTransactions,
  digitalWallets,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, sumMoney, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

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
    // best-effort — نفس اصطلاح بقية خدمات الوحدة (لا يُسقِط عمليةً مالية لأجل سطر تدقيق).
  }
}

function assertManager(actor: Actor): void {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "شطب النيّة قرارٌ مديريّ" });
  }
}

async function lockIntent(tx: Tx, intentId: number) {
  const [intent] = await tx
    .select()
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.id, intentId))
    .for("update");
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });
  return intent;
}

/**
 * البنود التي **صدرت كروتها فعلاً** — هي وحدها موضوع الشطب. البند الفاشل/المعلّق لا كلفة له
 * (لم يخصم الجهاز شيئاً) فشطبه يُحمّل المكتبة خسارةً لم تقع.
 */
async function issuedItems(tx: Tx, intentId: number) {
  return tx
    .select({
      id: digitalSaleIntentItems.id,
      providerId: digitalSaleIntentItems.providerId,
      providerShare: digitalSaleIntentItems.providerShareSnapshot,
      providerReference: digitalSaleIntentItems.providerReference,
    })
    .from(digitalSaleIntentItems)
    .where(
      and(
        eq(digitalSaleIntentItems.intentId, intentId),
        eq(digitalSaleIntentItems.fulfillmentStatus, "SUCCESS"),
      ),
    );
}

/* ─── ① الطلب — بلا أيّ أثرٍ ماليّ ─────────────────────────────────────────── */

export async function requestWriteoff(
  tx: Tx,
  input: { intentId: number; reason: string },
  actor: Actor,
): Promise<{ intentId: number; issuedCount: number; amount: string }> {
  assertManager(actor);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب سبباً واضحاً للشطب" });

  const intent = await lockIntent(tx, input.intentId);
  if (intent.status === "WRITEOFF_PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: "للنيّة طلب شطبٍ معلّق — ينتظر اعتماد مديرٍ آخر" });
  }
  if (intent.status !== "NEEDS_REVIEW") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "الشطب لا يكون إلا لنيّةٍ تحت المراجعة — لا تُشطب نيّةٌ مثبَّتة أو ملغاة",
    });
  }

  const items = await issuedItems(tx, input.intentId);
  if (items.length === 0) {
    // حارس: نيّةٌ بلا كرتٍ صادر تُلغى بلا شطبٍ ولا خسارة (`cancelIntent` يحرّر حجزها).
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا كرت صادراً في هذه النيّة — ألغِها بدل شطبها (الإلغاء يحرّر الحجز بلا خسارة)",
    });
  }

  await tx
    .update(digitalSaleIntents)
    .set({
      status: "WRITEOFF_PENDING",
      writeoffRequestedBy: actor.userId,
      writeoffRequestedAt: new Date(),
      writeoffReason: reason,
    })
    .where(eq(digitalSaleIntents.id, input.intentId));

  const amount = sumMoney(items.map((i) => i.providerShare));
  await auditLog(tx, actor, "digitalCards.intent.writeoffRequested", input.intentId, {
    issuedCount: items.length,
    amount: toDbMoney(amount),
    reason,
  });

  return { intentId: input.intentId, issuedCount: items.length, amount: toDbMoney(amount) };
}

/* ─── ② الاعتماد — كلّ الأثر المالي هنا، وداخل معاملة واحدة ────────────────── */

export async function approveWriteoff(
  tx: Tx,
  input: { intentId: number },
  actor: Actor,
): Promise<{ intentId: number; writtenOff: number; loss: string }> {
  assertManager(actor);

  const intent = await lockIntent(tx, input.intentId);
  if (intent.status === "WRITTEN_OFF") {
    throw new TRPCError({ code: "CONFLICT", message: "النيّة مشطوبة مسبقاً" });
  }
  if (intent.status !== "WRITEOFF_PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: "لا طلب شطبٍ معلّقاً على هذه النيّة" });
  }
  // فصل المهام: المُعتمِد ≠ الطالب. admin مُستثنى (نفس اصطلاح بقية الوحدات).
  if (Number(intent.writeoffRequestedBy) === actor.userId && actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يعتمد الشطب من طلبه — يلزم مديرٌ آخر" });
  }

  const items = await issuedItems(tx, input.intentId);
  if (items.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا كرت صادراً في هذه النيّة" });
  }
  const branchId = Number(intent.branchId);
  const reason = intent.writeoffReason ?? "";

  /* أنماط التسوية لكل مزوّدٍ في النيّة — الحصة تعود من مصدرها الصحيح. */
  const providerIds = Array.from(new Set(items.map((i) => Number(i.providerId))));
  const providers = await tx
    .select({
      id: digitalProviders.id,
      supplierId: digitalProviders.supplierId,
      settlementMode: digitalProviders.settlementMode,
    })
    .from(digitalProviders)
    .where(inArray(digitalProviders.id, providerIds));
  const modeById = new Map(providers.map((p) => [Number(p.id), p]));

  /* ② أ — المسبق: استهلاك الحجز وخفض الرصيد بالحصة (مطابقةً لما خصمه الجهاز فعلاً). */
  const reservations = await tx
    .select()
    .from(digitalWalletReservations)
    .where(
      and(
        eq(digitalWalletReservations.intentId, input.intentId),
        eq(digitalWalletReservations.status, "ACTIVE"),
      ),
    );

  // قفلٌ بترتيب walletId تصاعدياً — نفس اصطلاح `prepare`/`approveReversal` (منع deadlock).
  for (const r of [...reservations].sort((a, b) => Number(a.walletId) - Number(b.walletId))) {
    const walletId = Number(r.walletId);
    const [w] = await tx
      .select({
        id: digitalWallets.id,
        branchId: digitalWallets.branchId,
        currentBalance: digitalWallets.currentBalance,
        reservedBalance: digitalWallets.reservedBalance,
      })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update");
    if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });

    const amount = money(r.amount);
    const nextBalance = money(w.currentBalance).minus(amount);
    const nextReserved = money(w.reservedBalance).minus(amount);
    if (nextBalance.lt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الشطب يجعل رصيد المحفظة سالباً — راجِع الحركات" });
    }

    await tx.insert(digitalWalletTransactions).values({
      walletId,
      branchId: Number(w.branchId),
      type: "WRITEOFF",
      direction: "OUT",
      amount: toDbMoney(amount),
      balanceAfter: toDbMoney(nextBalance),
      transactionNumber: `DWO-${input.intentId}-${walletId}`,
      clientRequestId: `WOFF:${input.intentId}:${walletId}`,
      createdBy: actor.userId,
      approvedBy: actor.userId,
      approvedAt: new Date(),
      notes: `شطب نيّة عالقة #${input.intentId} — ${reason}`.trim(),
    });

    await tx
      .update(digitalWallets)
      .set({
        currentBalance: toDbMoney(nextBalance),
        // الحجز يُستهلَك لا يُطلَق: المال خرج فعلاً، ولو أُطلق لعاد الرصيد المتاح كذباً.
        reservedBalance: toDbMoney(nextReserved.lt(0) ? money(0) : nextReserved),
      })
      .where(eq(digitalWallets.id, walletId));

    await tx
      .update(digitalWalletReservations)
      .set({ status: "CONSUMED", consumedAt: new Date() })
      .where(eq(digitalWalletReservations.id, Number(r.id)));
  }

  /* ② ب — الآجل: ذمّة المزوّد ترتفع بالحصة (سيُطالبنا بكرتٍ أصدره). */
  const postpaidBySupplier = new Map<number, ReturnType<typeof money>>();
  for (const i of items) {
    const p = modeById.get(Number(i.providerId));
    if (!p || p.settlementMode !== "POSTPAID") continue;
    const sid = Number(p.supplierId);
    postpaidBySupplier.set(sid, (postpaidBySupplier.get(sid) ?? money(0)).plus(money(i.providerShare)));
  }
  // ترتيب supplierId تصاعدياً — نفس اصطلاح منع الـdeadlock في مسار الأمانة والتثبيت.
  for (const supplierId of Array.from(postpaidBySupplier.keys()).sort((a, b) => a - b)) {
    await adjustSupplierBalance(tx, supplierId, postpaidBySupplier.get(supplierId)!);
  }

  /* ② ج — القيد: خسارةٌ بمقدار الحصة كاملةً، أياً كان مصدرها. */
  const loss = sumMoney(items.map((i) => i.providerShare));
  await postEntry(tx, {
    entryType: "DIGITAL_WRITEOFF",
    branchId,
    amount: loss,
    revenue: money(0),
    cost: loss,
    profit: money(0).minus(loss),
    dedupeKey: `DIGITAL:WOFF:${input.intentId}`,
    notes: `شطب نيّة كروت عالقة #${input.intentId} — ${reason}`.trim(),
    createdBy: actor.userId,
  });

  await tx
    .update(digitalSaleIntents)
    .set({ status: "WRITTEN_OFF", writeoffApprovedBy: actor.userId, writeoffApprovedAt: new Date() })
    .where(eq(digitalSaleIntents.id, input.intentId));

  await auditLog(tx, actor, "digitalCards.intent.writeoffApproved", input.intentId, {
    writtenOff: items.length,
    loss: toDbMoney(loss),
    requestedBy: intent.writeoffRequestedBy,
    reason,
    references: items.map((i) => i.providerReference).filter(Boolean),
  });

  return { intentId: input.intentId, writtenOff: items.length, loss: toDbMoney(loss) };
}

/* ─── ③ الرفض — يعيدها للطابور بلا أثرٍ ماليّ ──────────────────────────────── */

export async function rejectWriteoff(
  tx: Tx,
  input: { intentId: number; reason?: string | null },
  actor: Actor,
): Promise<{ intentId: number }> {
  assertManager(actor);
  const intent = await lockIntent(tx, input.intentId);
  if (intent.status !== "WRITEOFF_PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: "لا طلب شطبٍ معلّقاً على هذه النيّة" });
  }
  if (Number(intent.writeoffRequestedBy) === actor.userId && actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يبتّ في الطلب من قدّمه — يلزم مديرٌ آخر" });
  }

  await tx
    .update(digitalSaleIntents)
    .set({
      status: "NEEDS_REVIEW",
      writeoffRequestedBy: null,
      writeoffRequestedAt: null,
      writeoffReason: null,
    })
    .where(eq(digitalSaleIntents.id, input.intentId));

  await auditLog(tx, actor, "digitalCards.intent.writeoffRejected", input.intentId, {
    requestedBy: intent.writeoffRequestedBy,
    requestReason: intent.writeoffReason,
    rejectReason: input.reason ?? null,
  });

  return { intentId: input.intentId };
}
