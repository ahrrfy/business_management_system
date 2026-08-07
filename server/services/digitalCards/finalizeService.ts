/**
 * التثبيت المالي للبيع الرقميّ (ش٨) — **معاملة واحدة، لا حالة وسطية**.
 *
 * الثابت الحاكم (معيار خروج ش٨): بين الفاتورة والتسوية والتفاصيل لا توجد حالة وسطية. أي فشلٍ في
 * أيّ خطوة يُرجِع كل شيء: الفاتورة والقبض وحركة المحفظة وذمّة المزوّد وسجلّ التفاصيل ولقطة بيانات الطالب.
 *
 * المعالجة المحاسبية (§٦):
 *   • قيد `SALE` الاعتيادي بـ revenue = سعر البيع، cost = حصة المزوّد، profit = الهامش —
 *     يتحقّق بتمرير `unitCostOverride` لنواة البيع (§١٠.٣)، لا بتعديل `costPrice`.
 *   • **PREPAID:** خصم المحفظة + قيد `DIGITAL_WALLET_CONSUMPTION` **بصفر أثر P&L** (حركة أصل).
 *   • **POSTPAID:** قيد `PURCHASE` **يتيم** بصفر أثر P&L يرفع `suppliers.currentBalance`،
 *     **مُجمَّعٌ مرّةً واحدة لكل (فاتورة × مزوّد)** مهما تعدّدت كروته (§٦.٣).
 *
 * الأسعار والتكاليف تُقرأ من **النيّة المقفولة** في القاعدة حصراً — لا رقم من العميل.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  digitalOfferings,
  digitalProviders,
  digitalSaleDetails,
  digitalSaleIntentItems,
  digitalSaleIntents,
  digitalWalletReservations,
  digitalWalletTransactions,
  digitalWallets,
  invoices,
  products,
} from "../../../drizzle/schema";
import { digitalSaleReferenceLabel } from "../../../shared/digitalSale";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, sumMoney, toDbMoney } from "../money";
import { createSaleInTx, DIGITAL_SALE_CAPABILITY } from "../sale/create";
import type { PaymentMethod } from "../sale/types";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";

export interface FinalizeInput {
  intentId: number;
  /** مفتاح idempotency للفاتورة — إعادةُ نفسه تُعيد الفاتورة نفسها بلا أثرٍ ثانٍ. */
  clientRequestId: string;
  /** المبلغ المقبوض فعلاً؛ يجب أن يساوي إجمالي النيّة (لا بيع رقميّ جزئيّ). */
  paymentAmount: string;
  paymentMethod: PaymentMethod;
  customerId?: number | null;
}

/** لقطة كرتٍ للطباعة (§١٢.١) — **بلا حصة مزوّد ولا ربح ولا رصيد**؛ الحقول ببساطة غير موجودة. */
export interface DigitalPrintDetail {
  lineName: string;
  referenceLabel: string;
  providerReference: string | null;
  studentName: string | null;
  studentPhone: string | null;
  guardianPhone: string | null;
  studentAddress: string | null;
}

export interface FinalizeResult {
  intentId: number;
  invoiceId: number;
  invoiceNumber: string;
  total: string;
  idempotentReplay: boolean;
  /** §١٢.٣: الخادم مصدر حقيقة الطباعة — يعود جاهزاً فلا يبني العميل الإيصال من حالته. */
  printDetails: DigitalPrintDetail[];
}

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

export async function finalize(tx: Tx, input: FinalizeInput, actor: Actor): Promise<FinalizeResult> {
  /* ١. قفل النيّة وبنودها. */
  const [intent] = await tx
    .select()
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.id, input.intentId))
    .for("update");
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });

  // العزل والملكية يسبقان replay: لا تكشف فاتورة/طباعة نيّةٍ لمستخدم أو فرع آخر.
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (!elevated && Number(intent.createdBy) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه النيّة لمستخدم آخر" });
  }
  if (!elevated && Number(intent.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه النيّة تخصّ فرعاً آخر" });
  }
  if (input.paymentMethod !== intent.paymentMethod) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "طريقة الدفع تغيّرت بعد إعداد الكروت — ألغِ النيّة قبل الإصدار وابدأ من جديد",
    });
  }

  /* ٢. إعادة الفاتورة القائمة إن كانت مُثبَّتة (idempotency). */
  if (intent.status === "FINALIZED") {
    if (intent.invoiceId == null) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "نيّة مُثبَّتة بلا فاتورة — راجِع الدعم" });
    }
    const [inv] = await tx
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, total: invoices.total })
      .from(invoices)
      .where(eq(invoices.id, Number(intent.invoiceId)))
      .limit(1);
    return {
      intentId: input.intentId,
      invoiceId: Number(intent.invoiceId),
      invoiceNumber: inv?.invoiceNumber ?? "",
      total: inv?.total ?? intent.expectedTotal,
      idempotentReplay: true,
      printDetails: await buildPrintDetails(tx, Number(intent.invoiceId)),
    };
  }

  /* ٣. رفض نيّة من فرع/وردية/مستخدم غير صحيح، أو حالةٍ لا تقبل التثبيت. */
  if (intent.status !== "EXECUTED" && intent.status !== "NEEDS_REVIEW") {
    throw new TRPCError({
      code: "CONFLICT",
      message: `لا تُثبَّت نيّة حالتها ${intent.status} — يجب أن تنجح كل الكروت أوّلاً`,
    });
  }

  const items = await tx
    .select()
    .from(digitalSaleIntentItems)
    .where(eq(digitalSaleIntentItems.intentId, input.intentId))
    .orderBy(asc(digitalSaleIntentItems.id))
    .for("update");
  if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "النيّة بلا بنود" });

  /* ٤. رفض أيّ بند غير SUCCESS (حارسٌ ثانٍ فوق حالة النيّة). */
  const notSuccess = items.filter((i) => i.fulfillmentStatus !== "SUCCESS");
  if (notSuccess.length) {
    throw new TRPCError({ code: "CONFLICT", message: `${notSuccess.length} كرت لم ينجح تنفيذه — لا تُنشأ فاتورة` });
  }

  const expectedTotal = sumMoney(items.map((i) => i.sellPriceSnapshot));
  if (!money(input.paymentAmount).eq(expectedTotal)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `المقبوض لا يطابق إجمالي الكروت (${toDbMoney(expectedTotal)}) — لا بيع رقميّ جزئيّ`,
    });
  }

  /* معلومات العروض والمزوّدين والمحافظ (من القاعدة، لا من العميل). */
  const meta = new Map<
    number,
    {
      providerId: number;
      settlementMode: string;
      walletId: number | null;
      variantId: number;
      productUnitId: number;
      offeringType: string;
    }
  >();
  for (const it of items) {
    if (meta.has(Number(it.offeringId))) continue;
    const [row] = await tx
      .select({
        variantId: digitalOfferings.variantId,
        productUnitId: digitalOfferings.productUnitId,
        offeringType: digitalOfferings.offeringType,
      })
      .from(digitalOfferings)
      .where(eq(digitalOfferings.id, Number(it.offeringId)))
      .limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "بطاقة غير موجودة" });
    meta.set(Number(it.offeringId), {
      providerId: Number(it.providerId),
      settlementMode: "UNKNOWN",
      walletId: null,
      variantId: Number(row.variantId),
      productUnitId: Number(row.productUnitId),
      offeringType: row.offeringType,
    });
  }

  /* ٥. قفل المحافظ وحجوزاتها بترتيب walletId والتحقّق أنها ACTIVE وكافية. */
  const reservations = await tx
    .select()
    .from(digitalWalletReservations)
    .where(eq(digitalWalletReservations.intentId, input.intentId))
    .orderBy(asc(digitalWalletReservations.walletId))
    .for("update");
  if (reservations.some((r) => r.status !== "ACTIVE")) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "حجز المحفظة لهذه النيّة عولج مسبقاً — لا تُنشأ فاتورة ثانية",
    });
  }
  if (intent.status === "NEEDS_REVIEW" && !elevated) {
    throw new TRPCError({ code: "FORBIDDEN", message: "إكمال نيّة المراجعة قرارٌ مديريّ" });
  }

  const lockedWallets = new Map<number, { currentBalance: string; reservedBalance: string; providerId: number }>();
  const walletsByProvider = new Map<number, number[]>();
  for (const r of reservations) {
    const walletId = Number(r.walletId);
    const [w] = await tx
      .select({
        id: digitalWallets.id,
        name: digitalWallets.name,
        providerId: digitalWallets.providerId,
        branchId: digitalWallets.branchId,
        isActive: digitalWallets.isActive,
        currentBalance: digitalWallets.currentBalance,
        reservedBalance: digitalWallets.reservedBalance,
      })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update");
    if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
    if (Number(w.branchId) !== Number(intent.branchId)) {
      throw new TRPCError({ code: "CONFLICT", message: "حجز محفظة من فرع آخر — أوقف التثبيت وراجِع الربط" });
    }
    if (money(w.currentBalance).lt(money(r.amount))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `رصيد «${w.name}» لم يعد يكفي للاستهلاك المحجوز — راجِع المحفظة`,
      });
    }
    lockedWallets.set(walletId, {
      currentBalance: w.currentBalance,
      reservedBalance: w.reservedBalance,
      providerId: Number(w.providerId),
    });
    const providerWallets = walletsByProvider.get(Number(w.providerId)) ?? [];
    providerWallets.push(walletId);
    walletsByProvider.set(Number(w.providerId), providerWallets);
  }
  for (const [providerId, walletIds] of Array.from(walletsByProvider.entries())) {
    if (walletIds.length > 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `النيّة تربط المزوّد ${providerId} بأكثر من محفظة — يلزم توزيع محفوظ لكل كرت`,
      });
    }
  }
  // وجود reservation هو لقطة PREPAID ثابتة؛ لا نعيد تفسير النيّة بعد تغيير إعداد المزوّد.
  for (const [offeringId, m] of Array.from(meta)) {
    const walletId = walletsByProvider.get(m.providerId)?.[0] ?? null;
    meta.set(offeringId, {
      ...m,
      settlementMode: walletId == null ? "POSTPAID" : "PREPAID",
      walletId,
    });
  }

  /* ٦. نواة البيع داخل المعاملة نفسها — بيانات الطالب لقطة بيع فقط، بلا عقد أو ملف تشغيلي. */
  const sale = await createSaleInTx(
    tx,
    {
      branchId: Number(intent.branchId),
      shiftId: Number(intent.shiftId),
      customerId: input.customerId ?? null,
      sourceType: "POS",
      // namespace خادمي مشتق من النيّة؛ لا collision مع بيع POS عادي ولا اعتماد على مفتاح العميل.
      clientRequestId: `DIGITAL_INTENT:${input.intentId}`,
      payment: { amount: toDbMoney(expectedTotal), method: input.paymentMethod },
      lines: items.map((it) => {
        const m = meta.get(Number(it.offeringId))!;
        return {
          variantId: m.variantId,
          productUnitId: m.productUnitId,
          quantity: "1",
          unitPriceOverride: it.sellPriceSnapshot,
          unitCostOverride: it.providerShareSnapshot,
          internalLineToken: String(it.id),
        };
      }),
    },
    actor,
    DIGITAL_SALE_CAPABILITY,
  );

  /* ٨. سجلّ التفاصيل: الربط برمز السطر الداخلي، لا بموضعٍ يتغيّر عند ترتيب أقفال variantId. */
  const invoiceItemByIntentItem = new Map(
    (sale.createdLineItems ?? []).map((line) => [line.lineToken, line.invoiceItemId]),
  );
  if (invoiceItemByIntentItem.size !== items.length) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "عدد بنود الفاتورة لا يطابق بنود النيّة" });
  }

  /* ٩. استهلاك الحجوزات: خصم PREPAID، أو رفع ذمّة المزوّد للآجل. */
  const walletTxByWallet = new Map<number, number>();
  for (const r of reservations) {
    const walletId = Number(r.walletId);
    const w = lockedWallets.get(walletId)!;
    const consumed = money(r.amount);

    const txRes = await tx.insert(digitalWalletTransactions).values({
      walletId,
      branchId: Number(intent.branchId),
      type: "SALE_CONSUMPTION",
      direction: "OUT",
      amount: toDbMoney(consumed),
      balanceAfter: toDbMoney(money(w.currentBalance).minus(consumed)),
      transactionNumber: `DWT-${sale.invoiceId}-${walletId}`,
      // idempotency على مستوى المحفظة: إعادة تشغيلٍ لنفس النيّة لا تُنشئ حركةً ثانية.
      clientRequestId: `FIN:${input.intentId}:${walletId}`,
      invoiceId: sale.invoiceId,
      createdBy: actor.userId,
      notes: `استهلاك بيع كروت — فاتورة ${sale.invoiceNumber}`,
    });
    walletTxByWallet.set(walletId, extractInsertId(txRes));

    await tx
      .update(digitalWallets)
      .set({
        currentBalance: toDbMoney(money(w.currentBalance).minus(consumed)),
        reservedBalance: toDbMoney(
          money(w.reservedBalance).minus(consumed).lt(0) ? money(0) : money(w.reservedBalance).minus(consumed),
        ),
      })
      .where(eq(digitalWallets.id, walletId));

    await tx
      .update(digitalWalletReservations)
      .set({ status: "CONSUMED", consumedAt: new Date() })
      .where(and(eq(digitalWalletReservations.id, Number(r.id)), eq(digitalWalletReservations.status, "ACTIVE")));

    // حركة أصل: صفر أثر على P&L (§٥.١٢) — لا تدخل تقارير الإيراد ولا المصروف.
    await postEntry(tx, {
      entryType: "DIGITAL_WALLET_CONSUMPTION",
      branchId: Number(intent.branchId),
      invoiceId: sale.invoiceId,
      digitalWalletId: walletId,
      amount: consumed,
      revenue: money(0),
      cost: money(0),
      profit: money(0),
      dedupeKey: `DIGITAL:WCONS:${sale.invoiceId}:${walletId}`,
      notes: "استهلاك محفظة كروت",
      createdBy: actor.userId,
    });
  }

  // POSTPAID: استحقاق **مُجمَّع مرّةً واحدة لكل (فاتورة × مزوّد)** مهما تعدّدت كروته (§٦.٣).
  const postpaidByProvider = new Map<number, ReturnType<typeof money>>();
  for (const it of items) {
    const m = meta.get(Number(it.offeringId))!;
    if (m.settlementMode !== "POSTPAID") continue;
    const prev = postpaidByProvider.get(m.providerId) ?? money(0);
    postpaidByProvider.set(m.providerId, prev.plus(money(it.providerShareSnapshot)));
  }
  // ترتيب supplierId تصاعدياً — منع deadlock (نفس اصطلاح بضاعة الأمانة).
  const providerIds = Array.from(postpaidByProvider.keys()).sort((a, b) => a - b);
  for (const providerId of providerIds) {
    const amount = postpaidByProvider.get(providerId)!;
    if (amount.lte(0)) continue;
    const [prov] = await tx
      .select({ supplierId: digitalProviders.supplierId })
      .from(digitalProviders)
      .where(eq(digitalProviders.id, providerId))
      .limit(1);
    if (!prov) throw new TRPCError({ code: "NOT_FOUND", message: "المزوّد غير موجود" });
    const supplierId = Number(prov.supplierId);

    await postEntry(tx, {
      entryType: "PURCHASE",
      supplierId,
      invoiceId: sale.invoiceId,
      branchId: Number(intent.branchId),
      amount,
      revenue: money(0),
      cost: money(0),
      profit: money(0),
      dedupeKey: `DIGITAL:AP:${sale.invoiceId}:${providerId}`,
      notes: "استحقاق مزوّد كروت",
      createdBy: actor.userId,
    });
    await adjustSupplierBalance(tx, supplierId, amount);
  }

  /* ٨ (تتمّة). كتابة digitalSaleDetails بعد توفّر حركة المحفظة. */
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const m = meta.get(Number(it.offeringId))!;
    const invoiceItemId = invoiceItemByIntentItem.get(String(it.id));
    if (invoiceItemId == null) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر ربط كرت ببند فاتورته" });
    }
    const walletTxId = m.settlementMode === "PREPAID" && m.walletId != null
      ? walletTxByWallet.get(m.walletId) ?? null
      : null;
    if (m.settlementMode === "PREPAID" && walletTxId == null) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "بيعٌ مسبق الدفع بلا حركة محفظة" });
    }

    await tx.insert(digitalSaleDetails).values({
      invoiceId: sale.invoiceId,
      invoiceItemId,
      intentItemId: Number(it.id),
      offeringId: Number(it.offeringId),
      providerId: m.providerId,
      priceVersionId: Number(it.priceVersionId),
      settlementModeSnapshot: m.settlementMode as "PREPAID" | "POSTPAID",
      sellPriceSnapshot: it.sellPriceSnapshot,
      providerShareSnapshot: it.providerShareSnapshot,
      profitSnapshot: it.marginSnapshot,
      providerReference: it.providerReference,
      fulfillmentStatus: "ISSUED",
      studentCustomerId: null,
      studentNameSnapshot: it.studentNameSnapshot,
      studentPhoneSnapshot: it.studentPhoneSnapshot,
      guardianPhoneSnapshot: it.guardianPhoneSnapshot,
      studentAddressSnapshot: it.studentAddressSnapshot,
      walletTransactionId: walletTxId,
    });

  }

  /* ١٠. ربط النيّة بالفاتورة وجعلها FINALIZED. */
  await tx
    .update(digitalSaleIntents)
    .set({ status: "FINALIZED", invoiceId: sale.invoiceId })
    .where(eq(digitalSaleIntents.id, input.intentId));

  await auditLog(tx, actor, "digitalCards.intent.finalized", input.intentId, {
    invoiceId: sale.invoiceId,
    total: toDbMoney(expectedTotal),
    items: items.length,
  });

  /* ١١. بيانات الطباعة من الخادم (§١٢.٣). */
  return {
    intentId: input.intentId,
    invoiceId: sale.invoiceId,
    invoiceNumber: sale.invoiceNumber,
    total: sale.total,
    idempotentReplay: false,
    printDetails: await buildPrintDetails(tx, sale.invoiceId),
  };
}

/**
 * إكمال نيّة كل كروتها SUCCESS لكنها انتقلت للمراجعة بسبب انقطاع/إغلاق الواجهة.
 * القيم المالية وطريقة الدفع تُقرأ من النيّة؛ لا يختار المدير أرقاماً جديدة أثناء الإنقاذ.
 */
export async function recoverNeedsReview(tx: Tx, intentId: number, actor: Actor): Promise<FinalizeResult> {
  const [intent] = await tx
    .select({
      clientRequestId: digitalSaleIntents.clientRequestId,
      expectedTotal: digitalSaleIntents.expectedTotal,
      paymentMethod: digitalSaleIntents.paymentMethod,
    })
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.id, intentId))
    .limit(1);
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });
  if (intent.paymentMethod !== "CASH" && intent.paymentMethod !== "CARD") {
    throw new TRPCError({ code: "CONFLICT", message: "طريقة دفع النيّة غير قابلة للاسترداد" });
  }
  return finalize(
    tx,
    {
      intentId,
      clientRequestId: intent.clientRequestId,
      paymentAmount: intent.expectedTotal,
      paymentMethod: intent.paymentMethod,
    },
    actor,
  );
}

/**
 * لقطات الطباعة لفاتورة — تُقرأ من `digitalSaleDetails` المثبَّتة، لا من مدخلات العميل.
 * الإسقاط يستبعد عمداً `providerShareSnapshot`/`profitSnapshot` (§١٢.٢).
 */
async function buildPrintDetails(runner: DB | Tx, invoiceId: number, branchId?: number | null): Promise<DigitalPrintDetail[]> {
  await assertInvoiceBranch(runner, invoiceId, branchId);
  const rows = await runner
    .select({
      lineName: products.name,
      offeringType: digitalOfferings.offeringType,
      providerReference: digitalSaleDetails.providerReference,
      studentName: digitalSaleDetails.studentNameSnapshot,
      studentPhone: digitalSaleDetails.studentPhoneSnapshot,
      guardianPhone: digitalSaleDetails.guardianPhoneSnapshot,
      studentAddress: digitalSaleDetails.studentAddressSnapshot,
    })
    .from(digitalSaleDetails)
    .innerJoin(invoices, eq(digitalSaleDetails.invoiceId, invoices.id))
    .innerJoin(digitalOfferings, eq(digitalSaleDetails.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .where(and(
      eq(digitalSaleDetails.invoiceId, invoiceId),
      ...(branchId == null ? [] : [eq(invoices.branchId, branchId)]),
    ))
    .orderBy(asc(digitalSaleDetails.id));
  return rows.map((r) => ({
    lineName: r.lineName,
    referenceLabel: digitalSaleReferenceLabel(r.offeringType),
    providerReference: r.providerReference,
    studentName: r.studentName,
    studentPhone: r.studentPhone,
    guardianPhone: r.guardianPhone,
    studentAddress: r.studentAddress,
  }));
}

/** إعادة الطباعة من الخادم (§١٢.١-٤): نفس اللقطات لأي فاتورة مثبَّتة. */
export async function reprintDetails(db: DB, invoiceId: number, branchId?: number | null): Promise<DigitalPrintDetail[]> {
  return buildPrintDetails(db, invoiceId, branchId);
}

/** تفاصيل البيع الرقميّ لفاتورة — للطباعة والتقارير. */
export async function getSaleDetails(db: DB, invoiceId: number, branchId?: number | null) {
  await assertInvoiceBranch(db, invoiceId, branchId);
  return db
    .select({
      id: digitalSaleDetails.id,
      invoiceItemId: digitalSaleDetails.invoiceItemId,
      offeringId: digitalSaleDetails.offeringId,
      offeringName: products.name,
      offeringType: digitalOfferings.offeringType,
      settlementMode: digitalSaleDetails.settlementModeSnapshot,
      sellPrice: digitalSaleDetails.sellPriceSnapshot,
      providerShare: digitalSaleDetails.providerShareSnapshot,
      profit: digitalSaleDetails.profitSnapshot,
      providerReference: digitalSaleDetails.providerReference,
      fulfillmentStatus: digitalSaleDetails.fulfillmentStatus,
      studentName: digitalSaleDetails.studentNameSnapshot,
      studentPhone: digitalSaleDetails.studentPhoneSnapshot,
      walletTransactionId: digitalSaleDetails.walletTransactionId,
    })
    .from(digitalSaleDetails)
    .innerJoin(invoices, eq(digitalSaleDetails.invoiceId, invoices.id))
    .innerJoin(digitalOfferings, eq(digitalSaleDetails.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .where(and(
      eq(digitalSaleDetails.invoiceId, invoiceId),
      ...(branchId == null ? [] : [eq(invoices.branchId, branchId)]),
    ))
    .orderBy(asc(digitalSaleDetails.id));
}

async function assertInvoiceBranch(runner: DB | Tx, invoiceId: number, branchId?: number | null): Promise<void> {
  if (branchId == null) return;
  const [invoice] = await runner
    .select({ branchId: invoices.branchId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  if (Number(invoice.branchId) !== branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخص فرعاً آخر" });
  }
}

/** ثابت التحقّق: Σ(حصة المزوّد + الربح) = Σ(سعر البيع) لفاتورة. */
export async function assertDetailsBalanced(db: DB, invoiceId: number): Promise<boolean> {
  const [row] = await db
    .select({
      sell: sql<string>`COALESCE(SUM(${digitalSaleDetails.sellPriceSnapshot}), 0)`,
      share: sql<string>`COALESCE(SUM(${digitalSaleDetails.providerShareSnapshot}), 0)`,
      profit: sql<string>`COALESCE(SUM(${digitalSaleDetails.profitSnapshot}), 0)`,
    })
    .from(digitalSaleDetails)
    .where(eq(digitalSaleDetails.invoiceId, invoiceId));
  if (!row) return true;
  return money(row.share).plus(money(row.profit)).eq(money(row.sell));
}
