// نواة العرابين — دفترُ المال المحتجَز قبل الفاتورة (`orderPayments`): القراءة والتخصيص والربط.
//
// نُقلت هذه الدوالّ **ميكانيكياً بلا تغيير** من `reception/deposits.ts` (م٣ من برنامج v2): أجسامُها
// وتعليقاتُها كما كانت حرفياً، فالاختبارات القائمة (receptionDeposits · workOrderFulfillment ·
// pr495ReviewFixes …) تمرّ بلا لمس. ما بقي هناك هو كتّابُ الإيصالات الثلاثة (collectDeposit ·
// refundDeposit · refundAppliedCollectionsForWorkOrder) — مثبَّتون بجرد إدراج `receipts` في
// cashDayClosedWriteGate.test.ts؛ وهم يستوردون هذا الملفّ عبر البرميل، لا العكس.
//
// الحقيقة البنيوية في orderPayments (receiptId UNIQUE — الإصلاح الجذريّ لعلّة V3: لا مسح ظنّيّاً أبداً).
// ترتيب الأقفال الموحَّد (§٧.٤): مسوّدة ← وردية ← أمر شغل. القراءات القافلة هنا (FOR UPDATE) تُستدعى
// حصراً بعد قفل صفّ المسوّدة — انظر تعليق heldNetOfDraft.
//
// ⛔ اتّجاه التبعيّة: لا استيراد من `reception/` ولا `workOrder/` (النواة لا تعرف مستهلكيها) —
//    يحرسه `__tests__/isolation.test.ts`.
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { orderPayments, receipts, receptionDrafts, workOrders } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";

/** طرق العربون — TELECOM (رصيد زين، ش٥) خلف ضوابط §٩.٤ في telecom.ts. */
export type DepositMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM";

type Decimal = ReturnType<typeof money>;

/** صافي المحتجز على مسوّدة: Σ COLLECTION (غير المردودة كلياً تُحمل بصافيها) − Σ REFUND.
 *  ⚠️ قراءةٌ **قافلة** (FOR UPDATE) عمداً — فخّ MVCC أمسكه اختبار التزامن I2: القراءة العادية
 *  داخل معاملةٍ سبق فيها SELECT عاديّ (فحص idempotency) تقرأ من لقطةٍ أقدم من قفل الصفّ،
 *  فيمرّ قبضان متزامنان يتجاوزان الإجمالي معاً. القراءة القافلة ترى آخر الملتزم دائماً.
 *  تُستدعى حصراً بعد قفل صفّ المسوّدة (ترتيب الأقفال: مسوّدة ← صفوف المال). */
export async function heldNetOfDraft(tx: Tx, draftId: number): Promise<Decimal> {
  const rows = await tx
    .select({ kind: orderPayments.kind, amount: orderPayments.amount })
    .from(orderPayments)
    .where(and(eq(orderPayments.draftId, draftId), inArray(orderPayments.kind, ["COLLECTION", "REFUND"])))
    .for("update");
  let net = money(0);
  for (const r of rows) {
    net = r.kind === "COLLECTION" ? net.plus(money(r.amount)) : net.minus(money(r.amount));
  }
  return round2(net);
}

/** سجلّ عرابين مسوّدة (للشاشة): الصفوف + الصافي المحتجز.
 *  مراجعة ش٤ (IDOR): عزل الفرع إلزاميّ — كانت النقطة الوحيدة في الشريحة بلا حارس فرع،
 *  فتُقرأ مبالغ ومراجع بطاقات أيّ فرعٍ بمعرّفٍ متسلسل. */
export async function listDraftPayments(draftId: number, actor?: (Actor & { role?: string }) | null, tx?: Tx) {
  const run = async (t: Tx) => {
    if (actor) {
      const draft = (
        await t
          .select({ branchId: receptionDrafts.branchId })
          .from(receptionDrafts)
          .where(eq(receptionDrafts.id, draftId))
          .limit(1)
      )[0];
      if (!draft)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر العثور على الطلب المحفوظ",
          why: "الرقم المرسل يشير إلى مسوّدة استقبال محذوفة أو غير موجودة",
          doThis: "أعد تحميل قائمة الطلبات المحفوظة — الطلب قد يكون ثُبِّت أو أُلغي أو حُذف",
        }),
      });
      const elevated = actor.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
      if (!elevated && Number(draft.branchId) !== Number(actor.branchId)) {
        throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "لا تستطيع العمل على هذا الطلب",
          why: "الطلب يخص فرعاً غير فرعك، وصلاحية عبور الفروع محصورة بالإدارة (admin)",
          doThis: "افتح الطلب من الفرع الذي يخصّه، أو اطلب من الإدارة تنفيذ العملية",
        }),
      });
      }
    }
    const rows = await t
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.draftId, draftId))
      .orderBy(asc(orderPayments.id));
    let net = money(0);
    for (const r of rows) {
      if (r.kind === "COLLECTION") net = net.plus(money(r.amount));
      else if (r.kind === "REFUND") net = net.minus(money(r.amount));
    }
    return { rows, heldNet: toDbMoney(round2(net)) };
  };
  if (tx) return run(tx);
  return withTx(run);
}

export interface AllocationTarget {
  kind: "INVOICE" | "WORKORDER";
  id: number;
  /** حصّة هذا الهدف من المال المقبوض سلفاً (P) — من التوزيع الجشع في checkoutReceptionInTx. */
  preAmount: string;
}

/**
 * تخصيص المحتجز على المستندات لحظة التثبيت (تُستدعى داخل معاملة commitDraft بعد إنشاء
 * المستندات): صفوف APPLICATION لكل (قبضٍ × هدف) بالجشع نفسه (أقدم قبضٍ أولاً × ترتيب
 * الأهداف كما وزّعها checkout)، ثم COLLECTION ⇒ APPLIED. الإيصال الذي ذهب مالُه كلُّه
 * لفاتورةٍ واحدة يُختم عليها invoiceId (نمط deliver.ts — append-only، لا مسّ للقيود)؛
 * المُشظّى بين أهدافٍ يبقى بلا ختم — حقيقتُه في orderPayments (I4).
 */
export async function allocateAtCommit(
  tx: Tx,
  args: { draftId: number; targets: AllocationTarget[]; actor: Actor },
) {
  const collections = await tx
    .select()
    .from(orderPayments)
    .where(
      and(
        eq(orderPayments.draftId, args.draftId),
        eq(orderPayments.kind, "COLLECTION"),
        eq(orderPayments.status, "HELD"),
      ),
    )
    .orderBy(asc(orderPayments.id));
  if (!collections.length) return { appliedPayments: [] as Array<{ paymentId: number; appliedKind: "INVOICE" | "WORKORDER"; appliedId: number; amount: string }> };

  // صافي كل قبضٍ بعد ردوده الجزئية.
  const refundRows = await tx
    .select({ parentPaymentId: orderPayments.parentPaymentId, v: sql<string>`COALESCE(SUM(${orderPayments.amount}), 0)` })
    .from(orderPayments)
    .where(and(eq(orderPayments.draftId, args.draftId), eq(orderPayments.kind, "REFUND")))
    .groupBy(orderPayments.parentPaymentId);
  const refundedOf = new Map<number, string>(refundRows.map((r) => [Number(r.parentPaymentId), String(r.v)]));

  const targetLeft = args.targets.map((t) => ({ ...t, left: round2(money(t.preAmount)) }));
  const appliedPayments: Array<{ paymentId: number; appliedKind: "INVOICE" | "WORKORDER"; appliedId: number; amount: string }> = [];

  for (const c of collections) {
    let left = round2(money(c.amount).minus(money(refundedOf.get(Number(c.id)) ?? "0")));
    const touched: AllocationTarget[] = [];
    for (const t of targetLeft) {
      if (left.lte(0)) break;
      if (t.left.lte(0)) continue;
      const share = left.gte(t.left) ? t.left : left;
      t.left = round2(t.left.minus(share));
      left = round2(left.minus(share));
      await tx.insert(orderPayments).values({
        draftId: args.draftId,
        branchId: Number(c.branchId),
        customerId: c.customerId != null ? Number(c.customerId) : null,
        kind: "APPLICATION",
        amount: toDbMoney(share),
        parentPaymentId: Number(c.id),
        appliedKind: t.kind,
        appliedId: t.id,
        createdBy: args.actor.userId,
      });
      touched.push(t);
      appliedPayments.push({ paymentId: Number(c.id), appliedKind: t.kind, appliedId: t.id, amount: toDbMoney(share) });
    }
    await tx.update(orderPayments).set({ status: "APPLIED" }).where(eq(orderPayments.id, Number(c.id)));
    // ختم الفاتورة على الإيصال **الصادق كاملاً** فقط: هدفٌ واحد **وبلا أيّ ردٍّ جزئيّ** — الإيصال
    // المختوم يدخل سقف استرداد المرتجع بمبلغه الكامل (returnService)، فختمُ إيصال ٥٠٠ رُدّ منه
    // ٢٠٠ كان يسمح باسترداد ٥٠٠ لفاتورةٍ دفعت ٣٠٠ صافياً (مراجعة ش٤ — نزيف درجٍ حقيقيّ).
    // المشوب بردٍّ يبقى بلا ختمٍ وحقيقتُه في orderPayments (نفس عقيدة المُشظّى I4).
    const hadRefund = money(refundedOf.get(Number(c.id)) ?? "0").gt(0);
    if (touched.length === 1 && touched[0].kind === "INVOICE" && c.receiptId != null && !hadRefund) {
      await tx
        .update(receipts)
        .set({ invoiceId: touched[0].id })
        .where(and(eq(receipts.id, Number(c.receiptId)), sql`${receipts.invoiceId} IS NULL`));
    }
  }
  return { appliedPayments };
}

/**
 * حقيقة عربون أمر شغلٍ وُلد من مسوّدة: حصص القبضات المطبَّقة عليه (P) — يقرؤها deliver
 * (لختم أحاديّ الهدف) وcancel (لردّ P بطريقة قبض كلّ حصّة) بدل الاعتماد على إيصال
 * depositReceiptId وحده (يحمل N الجديد فقط، وقد يكون صفراً). V3 بصيغتها البنيوية النهائية.
 */
export async function appliedCollectionsForWorkOrder(tx: Tx, workOrderId: number) {
  const apps = await tx
    .select({
      applicationId: orderPayments.id,
      amount: orderPayments.amount,
      parentPaymentId: orderPayments.parentPaymentId,
    })
    .from(orderPayments)
    .where(
      and(
        eq(orderPayments.kind, "APPLICATION"),
        eq(orderPayments.appliedKind, "WORKORDER"),
        eq(orderPayments.appliedId, workOrderId),
      ),
    )
    .orderBy(asc(orderPayments.id));
  if (!apps.length) return [];
  const parentIds = Array.from(new Set(apps.map((a) => Number(a.parentPaymentId))));
  const parents = await tx
    .select()
    .from(orderPayments)
    .where(inArray(orderPayments.id, parentIds));
  const parentOf = new Map(parents.map((p) => [Number(p.id), p]));
  // أحاديّ الهدف = لقبضه الأمّ تطبيقٌ واحدٌ فقط (على هذا الأمر).
  const appCounts = await tx
    .select({ parentPaymentId: orderPayments.parentPaymentId, n: sql<number>`COUNT(*)` })
    .from(orderPayments)
    .where(and(inArray(orderPayments.parentPaymentId, parentIds), eq(orderPayments.kind, "APPLICATION")))
    .groupBy(orderPayments.parentPaymentId);
  const countOf = new Map(appCounts.map((r) => [Number(r.parentPaymentId), Number(r.n)]));
  // ردود الأمّهات — القبض المردود جزئياً لا يُختم إيصالُه أبداً (مبلغه الكامل يكذب على سقف المرتجع).
  const refundSums = await tx
    .select({ parentPaymentId: orderPayments.parentPaymentId, v: sql<string>`COALESCE(SUM(${orderPayments.amount}), 0)` })
    .from(orderPayments)
    .where(and(inArray(orderPayments.parentPaymentId, parentIds), eq(orderPayments.kind, "REFUND")))
    .groupBy(orderPayments.parentPaymentId);
  const refundOf = new Map(refundSums.map((r) => [Number(r.parentPaymentId), String(r.v)]));
  return apps.map((a) => {
    const parent = parentOf.get(Number(a.parentPaymentId));
    return {
      applicationId: Number(a.applicationId),
      collectionId: Number(a.parentPaymentId),
      amount: String(a.amount),
      method: (parent?.method ?? "CASH") as DepositMethod,
      receiptId: parent?.receiptId != null ? Number(parent.receiptId) : null,
      draftId: parent != null ? Number(parent.draftId) : null,
      /** عميل القبض لحظته — ساقا الردّ تُكتبان به لا بعميل المسوّدة الحاليّ (قابلٍ للتغيّر). */
      customerId: parent?.customerId != null ? Number(parent.customerId) : null,
      soleTarget:
        (countOf.get(Number(a.parentPaymentId)) ?? 0) === 1 &&
        !money(refundOf.get(Number(a.parentPaymentId)) ?? "0").gt(0),
    };
  });
}

/** ربط إيصالات P أحاديّة الهدف بفاتورة تسليم أمر الشغل (نمط deliver.ts:161-185 حرفياً). */
export async function linkSoleTargetCollectionsToInvoice(tx: Tx, workOrderId: number, invoiceId: number) {
  const parts = await appliedCollectionsForWorkOrder(tx, workOrderId);
  for (const part of parts) {
    if (!part.soleTarget || part.receiptId == null) continue;
    await tx
      .update(receipts)
      .set({ invoiceId })
      .where(and(eq(receipts.id, part.receiptId), sql`${receipts.invoiceId} IS NULL`));
  }
}

/** إجمالي المحتجز غير المُثبَّت المقبوض على وردية (سطر إفصاح Z — I14). */
export async function heldDepositsOfShift(tx: Tx, shiftId: number) {
  // دلالة **الدرج** لا دلالة المسوّدة (مراجعة ش٤): تُطرح ردودُ **هذه الوردية نفسها** فقط —
  // ردٌّ لاحقٌ من درجِ ورديةٍ أخرى يخصّ درجَها هي، وطرحُه هنا كان يحوّر Z المؤرشف رجعياً
  // فيفقد تفسير فائض الدرج التاريخيّ. ولنفس السبب يُضمّ REFUNDED (قُبض على هذا الدرج فعلاً؛
  // ردودُه على هذا الدرج تُطرح بالقيد فيبقى الصافي صادقاً). APPLIED خارجٌ — تفسيرُه سطر
  // فواتير التثبيت على وردية التثبيت.
  const res = await tx.execute(sql`
    SELECT COUNT(DISTINCT op.draftId) AS c,
           CAST(COALESCE(SUM(op.amount - COALESCE(rf.s, 0)), 0) AS CHAR) AS t
    FROM ${orderPayments} op
    LEFT JOIN (
      SELECT parentPaymentId, SUM(amount) AS s
      FROM ${orderPayments}
      WHERE orderPayKind = 'REFUND' AND shiftId = ${shiftId}
      GROUP BY parentPaymentId
    ) rf ON rf.parentPaymentId = op.id
    WHERE op.shiftId = ${shiftId} AND op.orderPayKind = 'COLLECTION' AND op.orderPayStatus IN ('HELD','REFUNDED')
  `);
  const data = (res as unknown as [Array<{ c: number | string; t: string }>])[0] ?? res;
  const row = Array.isArray(data) ? data[0] : undefined;
  return { count: Number(row?.c ?? 0), total: String(row?.t ?? "0.00") };
}

/** أوامر الشغل المرتبطة بمسوّدة عبر تطبيقاتها — لرسالة الإلغاء المديريّ التي تسمّي البنود. */
export async function draftHasWorkOrderApplications(tx: Tx, draftId: number) {
  const rows = await tx
    .select({ appliedId: orderPayments.appliedId })
    .from(orderPayments)
    .where(
      and(eq(orderPayments.draftId, draftId), eq(orderPayments.kind, "APPLICATION"), eq(orderPayments.appliedKind, "WORKORDER")),
    );
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.appliedId));
  const wos = await tx
    .select({ id: workOrders.id, orderNumber: workOrders.orderNumber })
    .from(workOrders)
    .where(inArray(workOrders.id, ids));
  return wos.map((w) => ({ id: Number(w.id), orderNumber: String(w.orderNumber) }));
}
