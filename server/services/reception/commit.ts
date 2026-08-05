// ش٣ — تثبيت المسوّدة: تصير فاتورةً (+أوامر شغل) بذرّيةٍ كاملة وidempotency ثلاثيّ الطبقات.
// docs/reception-cashier-system-design-2026-08-05.md §٧.٣:
//   (أ) version تفاؤليّ للتحرير · (ب) FOR UPDATE تشاؤميّ للتثبيت · (ج) commitRequestId
//   **الخادميّ** يصير sourceId `{uuid}-sale` فيصطدم بـuq_invoice_source حتى لو سقط القفلان.
// إعادة التشغيل (ملاحظة ٢.١٠): النتيجة **تُعاد بناؤها من مفاتيح idempotency** لا من أعمدة
// الرأس — نفس منطق isCompleteReplay القائم، فلا تعود workOrderIds فارغةً أبداً.
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { invoices, receptionDraftLines, receptionDrafts, workOrders as workOrdersTable } from "../../../drizzle/schema";
import { findIdempotentRefId } from "../idempotency";
import { money, round2, roundCashIQD } from "../money";
import {
  checkoutReceptionInTx,
  type ReceptionCheckoutInput,
} from "../receptionCheckoutService";
import { type Actor, withTx } from "../tx";
import type { Tx } from "../../db";

export interface CommitDraftInput {
  draftId: number;
  version: number;
  /** إجمالي ما رآه الموظّف (خام قبل تقريب IQD) — الخادم يعيد الحساب من الأسطر ويرفض الاختلاف:
   *  يمسك ما لا يمسكه version وحده (تحديث صفحةٍ بين العرض والنقر — §٦). */
  expectedTotal: string;
  shiftId: number;
  /** المقبوض الآن (طريقة واحدة للسلة — F7). غيابه جائز لسلّة تخصيصٍ خالصة (م٥: لا شرط عربون). */
  collectNow?: { amount: string; method: "CASH" | "CARD" | "TRANSFER" | "WALLET"; reference?: string | null } | null;
  cashRoundIQD?: boolean;
  priceOverrideApproved?: boolean;
}

export interface CommitDraftResult {
  draftId: number;
  draftNumber: string;
  idempotentReplay: boolean;
  regularSale: { invoiceId: number; invoiceNumber: string } | null;
  printSale: { invoiceId: number; invoiceNumber: string } | null;
  workOrders: Array<{ workOrderId: number; orderNumber: string }>;
}

/** تجسيد أسطر المسوّدة إلى مدخل حدّ الالتزام القائم — كل الحرّاس القائمة تعمل كما هي. */
function materialize(
  draft: typeof receptionDrafts.$inferSelect,
  lines: Array<typeof receptionDraftLines.$inferSelect>,
  input: CommitDraftInput,
): ReceptionCheckoutInput {
  const goods = lines.filter((l) => l.lineKind === "GOODS");
  const prints = lines.filter((l) => l.lineKind === "PRINT");
  const customs = lines.filter((l) => l.lineKind === "CUSTOM");

  const sum = (ls: typeof lines) =>
    round2(ls.reduce((s, l) => s.plus(money(l.lineTotal)), money("0")));

  // V1 (مرآة الواجهة حرفياً): عند سريان تقريب IQD (بيع مباشر خالص نقديّ) يُرسَل مبلغ البيع
  // **مقرَّباً** — أسطر المسوّدة خامٌ (سعر الحفظ) بينما الموظّف يقبض المقرَّب، وحارس التوزيع
  // في checkoutReceptionInTx يقارن بالمبالغ المُرسَلة ⇒ بلا هذا التقريب يُرفض «يتجاوز الإجمالي»
  // لكل مسوّدةٍ إجماليها ليس مضاعف ٢٥٠ (أمسكته الجولة الحيّة). createSaleInTx يعيد التقريب
  // بنفس الدالة فيتطابقان ويقيّد الفرق ADJUST.
  const roundActive =
    input.cashRoundIQD === true &&
    input.collectNow?.method === "CASH" &&
    goods.length > 0 && prints.length === 0 && customs.length === 0;
  const goodsAmount = roundActive ? roundCashIQD(sum(goods)) : sum(goods);

  const saleLine = (l: (typeof lines)[number]) => ({
    variantId: Number(l.variantId),
    productUnitId: Number(l.productUnitId),
    quantity: String(l.quantity),
    // سعر المسوّدة المخزَّن (الفعّال وقت الحفظ، والخصم اليدويّ مطويٌّ فيه) يُثبَّت صراحةً —
    // لا إعادة تسعيرٍ صامتة بين الحفظ والتثبيت (نفس عقيدة الالتقاط الأوفلاينيّ).
    unitPriceOverride: money(l.unitPrice).toFixed(2),
    ...(money(l.discountAmount).gt(0) ? { discountAmount: money(l.discountAmount).toFixed(2) } : {}),
  });

  /** CUSTOM: المواصفة الكاملة من printSpec (CustomizationData عدا الصور) + الصور من عمودها. */
  const workOrderOf = (l: (typeof lines)[number]) => {
    let spec: Record<string, unknown> = {};
    try { spec = l.printSpec ? JSON.parse(l.printSpec) : {}; } catch { /* مواصفة تالفة ⇒ الحدّ الأدنى */ }
    let images: Array<{ url: string; caption?: string | null; sortOrder?: number | null }> = [];
    try { images = l.designImages ? JSON.parse(l.designImages) : []; } catch { /* بلا صور */ }
    const s = spec as Partial<{
      laborCost: string; priority: "LOW" | "NORMAL" | "URGENT"; hasDelivery: boolean;
      deliveryAddress: string; deliveryPhone: string; deliveryCost: string;
      deliveryFeeCollection: "COURIER" | "COUNTER" | "SHOP";
    }>;
    return {
      baseVariantId: l.variantId != null ? Number(l.variantId) : null,
      title: l.title ?? "خدمة / أمر شغل",
      customizationText: l.customizationText ?? null,
      quantity: Math.max(1, Math.trunc(Number(l.quantity))),
      // المواد كنمط الواجهة الحالي: المنتج الأساس يستهلك كميته (خدمة خالصة بلا مواد).
      materials: l.variantId != null
        ? [{ variantId: Number(l.variantId), baseQuantity: Math.max(1, Math.trunc(Number(l.quantity))) }]
        : [],
      laborCost: s.laborCost ? money(s.laborCost).toFixed(2) : "0",
      salePrice: money(l.lineTotal).toFixed(2),
      dueDate: l.dueDate ? new Date(l.dueDate).toISOString().slice(0, 10) : null,
      priority: s.priority ?? "NORMAL",
      assignedTo: l.assignedTo ?? undefined,
      deposit: "0.00", // العرابين الحقيقية على المسوّدة تُخصَّص في ش٤ (orderPayments/allocateAtCommit)
      paymentMethod: null,
      paymentReference: null,
      receptionChannel: (draft.channel as never) ?? "WALK_IN",
      hasDelivery: !!s.hasDelivery,
      deliveryAddress: s.deliveryAddress || null,
      deliveryPhone: s.deliveryPhone || null,
      deliveryCost: s.hasDelivery && s.deliveryCost ? money(s.deliveryCost).toFixed(2) : "0",
      deliveryFeeCollection: s.hasDelivery ? (s.deliveryFeeCollection ?? "COURIER") : "COURIER",
      designImages: images.map((img, i) => ({ url: img.url, caption: img.caption ?? null, sortOrder: img.sortOrder ?? i })),
    };
  };

  return {
    branchId: Number(draft.branchId),
    shiftId: input.shiftId,
    customerId: draft.customerId != null ? Number(draft.customerId) : null,
    contactName: draft.customerId == null ? draft.contactName : null,
    contactPhone: draft.customerId == null ? draft.contactPhone : null,
    paymentMethod: input.collectNow?.method ?? "CASH",
    paymentReference: input.collectNow?.reference ?? null,
    paidAmount: input.collectNow ? money(input.collectNow.amount).toFixed(2) : null,
    clientRequestId: draft.commitRequestId,
    priceTier: draft.priceTier as never,
    couponCode: null, // مرفوضٌ بنيوياً على مسار التثبيت في v1 (ملاحظة ١.٨ — ينسف expectedTotal)
    cashRoundIQD: input.cashRoundIQD === true,
    regularSale: goods.length ? { lines: goods.map(saleLine), amount: goodsAmount.toFixed(2) } : null,
    printSale: prints.length ? { lines: prints.map(saleLine), amount: sum(prints).toFixed(2) } : null,
    workOrders: customs.map(workOrderOf),
    priceOverrideApproved: input.priceOverrideApproved === true,
  };
}

/** إعادة بناء نتيجة تثبيتٍ سبق التزامه — من مفاتيح idempotency لا من أعمدة الرأس (٢.١٠). */
async function rebuildResult(
  tx: Tx,
  draft: typeof receptionDrafts.$inferSelect,
  customCount: number,
): Promise<CommitDraftResult> {
  const bySource = async (suffix: string) => {
    const row = (
      await tx
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(eq(invoices.sourceId, `${draft.commitRequestId}${suffix}`))
        .limit(1)
    )[0];
    return row ? { invoiceId: Number(row.id), invoiceNumber: row.invoiceNumber } : null;
  };
  const regularSale = await bySource("-sale");
  const printSale = await bySource("-print");
  const workOrders: Array<{ workOrderId: number; orderNumber: string }> = [];
  for (let i = 0; i < customCount; i += 1) {
    const id = await findIdempotentRefId(tx, "workOrder.create", `${draft.commitRequestId}-wo-${i}`);
    if (id == null) break;
    const wo = (
      await tx
        .select({ orderNumber: workOrdersTable.orderNumber })
        .from(workOrdersTable)
        .where(eq(workOrdersTable.id, id))
        .limit(1)
    )[0];
    workOrders.push({ workOrderId: id, orderNumber: wo?.orderNumber ?? "" });
  }
  return {
    draftId: Number(draft.id),
    draftNumber: draft.draftNumber,
    idempotentReplay: true,
    regularSale,
    printSale,
    workOrders,
  };
}

export async function commitDraft(input: CommitDraftInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    // (ب) قفلٌ تشاؤميّ: تثبيتان متزامنان من جهازين ⇒ الثاني ينتظر ثم يجد COMMITTED فيُعيد
    // **نفس** النتيجة (I8) — لا مصفوفةً فارغة ولا مستندات مزدوجة.
    const draft = (
      await tx.select().from(receptionDrafts).where(eq(receptionDrafts.id, input.draftId)).for("update").limit(1)
    )[0];
    if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "المسوّدة غير موجودة" });
    const elevated = actor.role === "admin" || actor.role === "manager";
    if (!elevated && (actor.branchId == null || Number(draft.branchId) !== Number(actor.branchId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "المسوّدة تخصّ فرعاً آخر" });
    }

    const lines = await tx
      .select()
      .from(receptionDraftLines)
      .where(eq(receptionDraftLines.draftId, input.draftId))
      .orderBy(asc(receptionDraftLines.sortOrder), asc(receptionDraftLines.id));

    if (draft.status !== "OPEN") {
      if (draft.status === "COMMITTED") {
        return rebuildResult(tx, draft, lines.filter((l) => l.lineKind === "CUSTOM").length);
      }
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: draft.status === "CANCELLED" ? "المسوّدة أُلغيت — لا تُثبَّت" : "المسوّدة انقضت — أنشئ طلباً جديداً",
      });
    }
    if (lines.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المسوّدة فارغة — أضف بنوداً قبل التثبيت" });
    }
    // (أ) version: تحريرُ زميلٍ بين عرضك ونقرك ⇒ CONFLICT لا تثبيتُ ما لم تَرَه.
    if (Number(draft.version) !== input.version) {
      throw new TRPCError({ code: "CONFLICT", message: "حُدِّثت المسوّدة بعد عرضك — أُعيد تحميلها، راجع ثم ثبّت" });
    }
    // expectedTotal: يُعاد الحساب من الأسطر (لا من عمود الرأس — ذاكرة عرض).
    const recomputed = round2(lines.reduce((s, l) => s.plus(money(l.lineTotal)), money("0")));
    if (!recomputed.eq(round2(money(input.expectedTotal)))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `إجمالي المسوّدة تغيّر (${recomputed.toFixed(2)} لا ${money(input.expectedTotal).toFixed(2)}) — راجع الطلب ثم ثبّت`,
      });
    }
    // القاعدة ٧ (تُشحذ مالياً في ش٤ مع orderPayments): إجمالي المستند >= المقبوض سلفاً.
    // moneyLocked بلا orderPayments بعدُ ⇒ الحارس هيكليّ هنا؛ ش٤ تستبدله بالجمع الفعليّ.
    const hasDirect = lines.some((l) => l.lineKind !== "CUSTOM");
    if (hasDirect && !input.collectNow) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السلة فيها بضاعة/طباعة تُدفع الآن — أدخل المبلغ المقبوض ثم ثبّت",
      });
    }

    const checkoutInput = materialize(draft, lines, input);
    const result = await checkoutReceptionInTx(tx, checkoutInput, actor);

    await tx
      .update(receptionDrafts)
      .set({
        status: "COMMITTED",
        committedInvoiceId: result.regularSale?.invoiceId ?? result.printSale?.invoiceId ?? null,
        committedPrintInvoiceId: result.printSale?.invoiceId ?? null,
        committedAt: new Date(),
        updatedBy: actor.userId,
      })
      .where(eq(receptionDrafts.id, input.draftId));

    return {
      draftId: Number(draft.id),
      draftNumber: draft.draftNumber,
      idempotentReplay: false,
      regularSale: result.regularSale
        ? { invoiceId: result.regularSale.invoiceId, invoiceNumber: result.regularSale.invoiceNumber }
        : null,
      printSale: result.printSale
        ? { invoiceId: result.printSale.invoiceId, invoiceNumber: result.printSale.invoiceNumber }
        : null,
      workOrders: result.workOrders.map((w) => ({ workOrderId: w.workOrderId, orderNumber: w.orderNumber })),
    } satisfies CommitDraftResult;
  });
}
