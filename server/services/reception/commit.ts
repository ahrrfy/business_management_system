// ش٣ — تثبيت المسوّدة: تصير فاتورةً (+أوامر شغل) بذرّيةٍ كاملة وidempotency ثلاثيّ الطبقات.
// docs/reception-cashier-system-design-2026-08-05.md §٧.٣:
//   (أ) version تفاؤليّ للتحرير · (ب) FOR UPDATE تشاؤميّ للتثبيت · (ج) commitRequestId
//   **الخادميّ** يصير sourceId `{uuid}-sale` فيصطدم بـuq_invoice_source حتى لو سقط القفلان.
// إعادة التشغيل (ملاحظة ٢.١٠): النتيجة **تُعاد بناؤها من مفاتيح idempotency** لا من أعمدة
// الرأس — نفس منطق isCompleteReplay القائم، فلا تعود workOrderIds فارغةً أبداً.
import { toWorkOrderChannel } from "@shared/receptionChannel";
import { linkConversationToWorkOrderTx } from "../conversationService";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  invoices,
  orderPayments,
  productUnits,
  productVariants,
  products,
  receptionDraftLines,
  receptionDrafts,
  workOrders as workOrdersTable,
} from "../../../drizzle/schema";
import { findIdempotentRefId } from "../idempotency";
import { money, round2, roundCashIQD, toDbMoney } from "../money";
import {
  checkoutReceptionInTx,
  type ReceptionCheckoutInput,
} from "../receptionCheckoutService";
import { type Actor, withTx } from "../tx";
import type { Tx } from "../../db";
import { mixedAwarePaymentMethod } from "../sale/payment";
import { allocateAtCommit, heldNetOfDraft, type AllocationTarget } from "./deposits";

/**
 * صدق طريقة الدفع (١٨/٨) — يختم على كل فاتورة **مموَّلة من عربونٍ محتجَز** طريقةَ قبضها
 * الحقيقية المشتقّة من طرق القبضات المطبَّقة عليها (تعدّدٌ ⇒ MIXED، بنفس طيّ سائر المسارات).
 *
 * لماذا هنا: `checkoutReceptionInTx` لا يبني دفعةً لمالٍ قُبض سلفاً (إيصاله قائمٌ منذ قبضه —
 * I5)، فلولا هذا الختم لبقيت الفاتورة `paymentMethod = NULL` فتُقرأ «آجلة» وهي مقبوضة.
 * والكتابة **مشروطةٌ بـNULL** حصراً: لا تُلمَس فاتورةٌ ختمت طريقتها من نقدٍ جديد.
 */
async function stampDerivedPaymentMethods(
  tx: Tx,
  appliedPayments: Array<{ paymentId: number; appliedKind: "INVOICE" | "WORKORDER"; appliedId: number }>,
) {
  const invoiceTargets = appliedPayments.filter((p) => p.appliedKind === "INVOICE");
  if (!invoiceTargets.length) return;
  const methodRows = await tx
    .select({ id: orderPayments.id, method: orderPayments.method })
    .from(orderPayments)
    .where(inArray(orderPayments.id, Array.from(new Set(invoiceTargets.map((p) => p.paymentId)))));
  const methodOf = new Map(methodRows.map((r) => [Number(r.id), r.method]));

  const foldedByInvoice = new Map<number, string>();
  for (const p of invoiceTargets) {
    const method = methodOf.get(p.paymentId);
    if (!method) continue;
    foldedByInvoice.set(p.appliedId, mixedAwarePaymentMethod(foldedByInvoice.get(p.appliedId), method));
  }
  for (const [invoiceId, method] of Array.from(foldedByInvoice.entries())) {
    await tx
      .update(invoices)
      .set({ paymentMethod: method as never })
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.paymentMethod)));
  }
}

export interface CommitDraftInput {
  draftId: number;
  version: number;
  /** إجمالي ما رآه الموظّف (خام قبل تقريب IQD) — الخادم يعيد الحساب من الأسطر ويرفض الاختلاف:
   *  يمسك ما لا يمسكه version وحده (تحديث صفحةٍ بين العرض والنقر — §٦). */
  expectedTotal: string;
  shiftId: number;
  /** المقبوض الآن (طريقة واحدة للسلة — F7). غيابه جائز لسلّة تخصيصٍ خالصة (م٥: لا شرط عربون). */
  collectNow?: { amount: string; method: "CASH" | "CARD" | "TRANSFER" | "WALLET" | "TELECOM"; reference?: string | null } | null;
  cashRoundIQD?: boolean;
  priceOverrideApproved?: boolean;
  /** الاستقبال (٨/٨): تأكيد الموظّف توفّر الأصناف غير المجرودة فيزيائياً (بيع بالسالب لطلب COD في الافتتاح). */
  openingSellUnavailableConfirmed?: boolean;
  /** ش٦ (§٩.٣): هويّة مُقِرّ تجاوز السعر — يمرّرها الراوتر حين priceOverrideApproved صادقة. */
  priceApprovedBy?: number | null;
  /** ش٦ (V15): أجرة توصيل الطلب المقبوضة الآن أمانةً للمندوب (نقداً في الدرج) — تُكتب مع
   *  الفاتورة الحاملة إيصالاً وقيد DELIVERY_FEE_HELD، وبها يُسنَد الطلب COUNTER بعد التثبيت. */
  deliveryFeeHeld?: string | null;
  /** ش٧ (قرار المالك ٦/٨): إسناد الطلب لمندوبٍ **داخل معاملة التثبيت** — المتبقّي عهدةٌ عليه
   *  لا نقدٌ في الدرج ولا ذمّةٌ على زبونٍ عابر. */
  delivery?: ReceptionCheckoutInput["delivery"];
}

export interface CommitDraftResult {
  draftId: number;
  draftNumber: string;
  idempotentReplay: boolean;
  regularSale: { invoiceId: number; invoiceNumber: string; shiftId: number | null } | null;
  printSale: { invoiceId: number; invoiceNumber: string; shiftId: number | null } | null;
  /** deposit (ش٤): العربون الموزَّع على الأمر (P+N) — تطبعه التذكرة «مدفوعٌ مقدماً». */
  workOrders: Array<{ workOrderId: number; orderNumber: string; deposit: string }>;
  /** ش٤: تخصيصات المقبوض سلفاً على المستندات (I4) — للعرض والإثبات، لا لحساب لاحق. */
  appliedPayments: Array<{ paymentId: number; appliedKind: "INVOICE" | "WORKORDER"; appliedId: number; amount: string }>;
  /** ش٤: صافي المحتجز الذي طُبِّق في هذا التثبيت. */
  heldApplied: string;
  /** ش٧: الإرسالية المُنشأة في نفس المعاملة (إن أُسنِد الطلب لمندوب) — للطباعة والإشعار. */
  dispatch?: { consignmentNumber: string; codAmount: string; deliveryFee: string } | null;
}

/**
 * البيانات الوصفية اللازمة لبناء **مواد** أوامر الشغل من أسطر المسوّدة (مراجعة PR #495):
 *   • `conversionFactor` لوحدة البيع — بدونه يُستهلك «درزنان» بـ٢ وحداتٍ أساس لا ٢٤ ⇒ مخزونٌ
 *     مُبالَغ وCOGS منقوص (يخرق §٥: `baseQuantity = quantity × conversionFactor`).
 *   • `isService` — الخدمة الكتالوجية بلا مخزون: تسجيلُها مادةً يخلق صفّ `workOrderMaterials`
 *     كاذباً (والاستهلاك لاحقاً يبحث عن رصيد فرعٍ لا وجود له).
 * المسار المباشر في الواجهة يفعل هذا حرفياً منذ ٢٣/٦؛ مسار المسوّدة كان يفقده لأنّ السطر
 * المحفوظ لا يحمل إلا (variantId, productUnitId, quantity) ⇒ نُعيد الاستعلام هنا داخل المعاملة.
 */
export interface DraftLineMeta {
  /** productUnitId → معامل التحويل للوحدة الأساس. */
  factorByUnit: Map<number, number>;
  /** variantId → أهي خدمةٌ بلا مخزون؟ */
  serviceByVariant: Map<number, boolean>;
}

async function loadDraftLineMeta(
  tx: Tx,
  lines: Array<typeof receptionDraftLines.$inferSelect>,
): Promise<DraftLineMeta> {
  const customs = lines.filter((l) => l.lineKind === "CUSTOM" && l.variantId != null);
  const unitIds = Array.from(new Set(customs.map((l) => Number(l.productUnitId)).filter((n) => Number.isFinite(n) && n > 0)));
  const variantIds = Array.from(new Set(customs.map((l) => Number(l.variantId))));
  const factorByUnit = new Map<number, number>();
  const serviceByVariant = new Map<number, boolean>();
  if (unitIds.length) {
    const rows = await tx
      .select({ id: productUnits.id, factor: productUnits.conversionFactor })
      .from(productUnits)
      .where(inArray(productUnits.id, unitIds));
    for (const r of rows) factorByUnit.set(Number(r.id), Number(r.factor) || 1);
  }
  if (variantIds.length) {
    const rows = await tx
      .select({ id: productVariants.id, isService: products.isService })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    for (const r of rows) serviceByVariant.set(Number(r.id), !!r.isService);
  }
  return { factorByUnit, serviceByVariant };
}

/** تجسيد أسطر المسوّدة إلى مدخل حدّ الالتزام القائم — كل الحرّاس القائمة تعمل كما هي. */
function materialize(
  draft: typeof receptionDrafts.$inferSelect,
  lines: Array<typeof receptionDraftLines.$inferSelect>,
  input: CommitDraftInput,
  heldNet: ReturnType<typeof money>,
  meta: DraftLineMeta,
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
  // ش٤: لو أنزل التقريبُ الإجماليَّ تحت المقبوض سلفاً (عربونٌ = الإجمالي الخام بالضبط + تقريبٌ
  // لأسفل) لَما وُجد للفارق مخرجٌ (ردٌّ قسريّ لـ<=125 ديناراً) — نتخطّى التقريب حينها.
  const rawRound =
    input.cashRoundIQD === true &&
    input.collectNow?.method === "CASH" &&
    goods.length > 0 && prints.length === 0 && customs.length === 0;
  // `.lte` لا `.lt` (مراجعة ش٤): عند تساوي المحتجز مع المقرَّب بالضبط (عربون 5,000 على 5,100
  // تُقرَّب 5,000) كان التقريب يبقى فيصير applied=5,100 > 5,000 ⇒ طريقٌ نقديّ مسدود بلا مخرج.
  const roundActive = rawRound && !roundCashIQD(sum(goods)).lte(heldNet);
  let goodsAmount = roundActive ? roundCashIQD(sum(goods)) : sum(goods);
  let printAmount = sum(prints);

  // ش٦ — تقريب السلّة المختلطة: فرقُ تقريب السلّة **كلّها** (بضاعة+طباعة+تخصيص) يُحمَّل على
  // فاتورةٍ واحدةٍ حاملة (البيع المباشر ثم الطباعة) عبر cashRoundingOverride. شروطه:
  // نقديٌّ كامل الآن (المقبوض + المحتجز = المقرَّب بالضبط — دفعةٌ جزئية تجعل التقريب بلا معنى)،
  // وفاتورةٌ تحمل الفرق، وحاملُها لا ينقلب صفراً/سالباً، والمقرَّب فوق المحتجز (نفس مأزق ش٤).
  let mixedRoundTarget: "SALE" | "PRINT" | null = null;
  if (
    input.cashRoundIQD === true &&
    input.collectNow?.method === "CASH" &&
    !rawRound &&
    (goods.length > 0 || prints.length > 0)
  ) {
    const grandAll = round2(sum(goods).plus(sum(prints)).plus(sum(customs)));
    const roundedAll = roundCashIQD(grandAll);
    const delta = roundedAll.minus(grandAll);
    const carrier = goods.length > 0 ? "SALE" as const : "PRINT" as const;
    const carrierRaw = carrier === "SALE" ? sum(goods) : sum(prints);
    const fullCashNow = round2(money(input.collectNow.amount).plus(heldNet)).eq(roundedAll);
    if (!delta.isZero() && fullCashNow && !roundedAll.lte(heldNet) && carrierRaw.plus(delta).gt(0)) {
      mixedRoundTarget = carrier;
      if (carrier === "SALE") goodsAmount = round2(carrierRaw.plus(delta));
      else printAmount = round2(carrierRaw.plus(delta));
    }
  }

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
    // مواد الأمر — **مرآة المسار المباشر حرفياً** (مراجعة PR #495): الخدمة الكتالوجية بلا مواد،
    // وغيرها يستهلك `الكمية × معامل التحويل` بالوحدة الأساس (§٥) لا كمية وحدة البيع الخام.
    const qtyInt = Math.max(1, Math.trunc(Number(l.quantity)));
    const variantId = l.variantId != null ? Number(l.variantId) : null;
    const isServiceVariant = variantId != null && meta.serviceByVariant.get(variantId) === true;
    const factor = l.productUnitId != null ? (meta.factorByUnit.get(Number(l.productUnitId)) ?? 1) : 1;
    return {
      baseVariantId: variantId,
      title: l.title ?? "خدمة / أمر شغل",
      customizationText: l.customizationText ?? null,
      quantity: qtyInt,
      materials: variantId != null && !isServiceVariant
        ? [{ variantId, baseQuantity: Math.max(1, Math.round(qtyInt * factor)) }]
        : [],
      laborCost: s.laborCost ? money(s.laborCost).toFixed(2) : "0",
      salePrice: money(l.lineTotal).toFixed(2),
      dueDate: l.dueDate ? new Date(l.dueDate).toISOString().slice(0, 10) : null,
      priority: s.priority ?? "NORMAL",
      assignedTo: l.assignedTo ?? undefined,
      deposit: "0.00", // العرابين الحقيقية على المسوّدة تُخصَّص في ش٤ (orderPayments/allocateAtCommit)
      paymentMethod: null,
      paymentReference: null,
      // القناة مُضيَّقةٌ في العقد (١٩/٨) ⤇ لا `as never`. والمعرّف يُنقَل معها: كان عمود
      // `workOrders.channelHandle` ينتظر قيمةً والمسوّدة لا تحملها ⤇ طلبٌ من واتساب
      // يُثبّت فيفقد رقمَ مُرسِله كلّيّاً.
      receptionChannel: toWorkOrderChannel(draft.channel),
      channelHandle: draft.channelHandle ?? null,
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
    // صدق طريقة الدفع (١٨/٨): بلا قبضٍ الآن ⇒ **لا طريقة**. كان `?? "CASH"` يختلق «نقدي»
    // لتثبيتٍ صفريّ القبض (سلّة تخصيصٍ خالصة بلا عربون مسموحةٌ صراحةً) فتُقرأ الفاتورة مدفوعةً
    // نقداً وهي آجلة، وتسقط من فلتر «آجل» (paymentMethod IS NULL) — بلاغ المالك.
    paymentMethod: input.collectNow?.method ?? null,
    paymentReference: input.collectNow?.reference ?? null,
    paidAmount: input.collectNow ? money(input.collectNow.amount).toFixed(2) : null,
    // ش٤: صافي المحتجز على المسوّدة يدخل التوزيع أولاً — الإيصالات قائمة منذ القبض (I5).
    preCollected: heldNet.gt(0) ? { total: heldNet.toFixed(2) } : null,
    clientRequestId: draft.commitRequestId,
    priceTier: draft.priceTier as never,
    couponCode: null, // مرفوضٌ بنيوياً على مسار التثبيت في v1 (ملاحظة ١.٨ — ينسف expectedTotal)
    // العلم المُمرَّر هو المُشتقّ (roundActive) لا الخام — لو أُسقط التقريب لحماية المقبوض سلفاً
    // يجب ألّا يعيد createSaleInTx تقريبه من جهته فينحرف الطرفان.
    cashRoundIQD: roundActive,
    cashRoundingOverride: mixedRoundTarget,
    deliveryFeeHeld: input.deliveryFeeHeld ?? null,
    delivery: input.delivery ?? null,
    openingSellUnavailableConfirmed: input.openingSellUnavailableConfirmed === true,
    priceApprovedBy: input.priceApprovedBy ?? null,
    regularSale: goods.length ? { lines: goods.map(saleLine), amount: goodsAmount.toFixed(2) } : null,
    printSale: prints.length ? { lines: prints.map(saleLine), amount: printAmount.toFixed(2) } : null,
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
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, shiftId: invoices.shiftId })
        .from(invoices)
        .where(eq(invoices.sourceId, `${draft.commitRequestId}${suffix}`))
        .limit(1)
    )[0];
    return row
      ? { invoiceId: Number(row.id), invoiceNumber: row.invoiceNumber, shiftId: row.shiftId == null ? null : Number(row.shiftId) }
      : null;
  };
  const regularSale = await bySource("-sale");
  const printSale = await bySource("-print");
  const workOrders: Array<{ workOrderId: number; orderNumber: string; deposit: string }> = [];
  for (let i = 0; i < customCount; i += 1) {
    const id = await findIdempotentRefId(tx, "workOrder.create", `${draft.commitRequestId}-wo-${i}`);
    if (id == null) break;
    const wo = (
      await tx
        .select({ orderNumber: workOrdersTable.orderNumber, deposit: workOrdersTable.deposit })
        .from(workOrdersTable)
        .where(eq(workOrdersTable.id, id))
        .limit(1)
    )[0];
    workOrders.push({ workOrderId: id, orderNumber: wo?.orderNumber ?? "", deposit: String(wo?.deposit ?? "0.00") });
  }
  // ش٤: التخصيصات المكتوبة فعلاً — النتيجة المُعادة مطابقة تماماً للأولى (I8).
  const appRows = await tx
    .select()
    .from(orderPayments)
    .where(and(eq(orderPayments.draftId, Number(draft.id)), eq(orderPayments.kind, "APPLICATION")))
    .orderBy(asc(orderPayments.id));
  const appliedPayments = appRows.map((r) => ({
    paymentId: Number(r.parentPaymentId),
    appliedKind: (r.appliedKind ?? "INVOICE") as "INVOICE" | "WORKORDER",
    appliedId: Number(r.appliedId),
    amount: String(r.amount),
  }));
  const heldApplied = toDbMoney(
    round2(appRows.reduce((s, r) => s.plus(money(r.amount)), money("0"))),
  );
  return {
    draftId: Number(draft.id),
    draftNumber: draft.draftNumber,
    idempotentReplay: true,
    regularSale,
    printSale,
    workOrders,
    appliedPayments,
    heldApplied,
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
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛ المدير مقيَّدٌ بفرعه.
    const elevated = actor.role === "admin";
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
    // القاعدة ٧ (ش٤ — بالجمع الفعليّ من orderPayments تحت قفل المسوّدة): إجمالي المستند
    // المُعاد حسابه >= صافي المقبوض سلفاً، وإلا فالموظّف حذف/خفّض بعد القبض بما يجعل المال
    // بلا وعاء — يُردّ الفارق أولاً (refundDeposit) ثم يُثبَّت.
    const heldNet = await heldNetOfDraft(tx, input.draftId);
    if (heldNet.gt(recomputed)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `المقبوض سلفاً (${heldNet.toFixed(2)}) يتجاوز إجمالي الطلب (${recomputed.toFixed(2)}) — رُدَّ الفارق أولاً (ردّ عربون) ثم ثبّت`,
      });
    }
    // صمّام عميل القبض (مراجعة ش٤ — يغلق أيّ بابٍ مستقبليّ يغيّر العميل من غير syncDraft):
    // قيود العربون مختومة بعميل لحظة القبض؛ تثبيتٌ لعميلٍ مغاير يفصم القيد عن فاتورته.
    if (heldNet.gt(0)) {
      const heldRows = await tx
        .select({ customerId: orderPayments.customerId })
        .from(orderPayments)
        .where(and(
          eq(orderPayments.draftId, input.draftId),
          eq(orderPayments.kind, "COLLECTION"),
          eq(orderPayments.status, "HELD"),
        ));
      const draftCustomer = draft.customerId != null ? Number(draft.customerId) : null;
      const mismatch = heldRows.some(
        (r) => (r.customerId != null ? Number(r.customerId) : null) !== draftCustomer,
      );
      if (mismatch) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "عرابين الطلب مقبوضة باسم طرفٍ يخالف عميله الحاليّ — رُدَّ العربون ثم أعد قبضه بالاسم الصحيح",
        });
      }
    }
    // بضاعة/طباعة تُدفع كاملةً عند التثبيت: يلزم قبضٌ الآن **إلا إذا** غطّاها المحتجز سلفاً.
    const hasDirect = lines.some((l) => l.lineKind !== "CUSTOM");
    const directTotal = round2(
      lines.filter((l) => l.lineKind !== "CUSTOM").reduce((s, l) => s.plus(money(l.lineTotal)), money("0")),
    );
    // ش٧ (قرار المالك ٦/٨): طلبٌ يُسنَد لمندوبٍ **مُستثنى** — الزبون يدفع عند الاستلام، فلا
    // يُجبَر الكاشير على «قبض» مالٍ لم يستلمه (فائضُ درجٍ يُحاسَب عليه). المتبقّي عهدةُ مندوب.
    if (!input.delivery && hasDirect && !input.collectNow && heldNet.lt(directTotal)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: heldNet.gt(0)
          ? `المقبوض سلفاً (${heldNet.toFixed(2)}) لا يغطّي البضاعة/الطباعة (${directTotal.toFixed(2)}) — أدخل المبلغ المتبقّي ثم ثبّت`
          : "السلة فيها بضاعة/طباعة تُدفع الآن — أدخل المبلغ المقبوض ثم ثبّت",
      });
    }
    // مراجعة عدائية (٥/٨): أجرة «مقبوضة في الاستقبال» (COUNTER) على مسار المسوّدة —
    // createWorkOrderInTx يكتب إيصال IN بالأجرة **حتماً** بينما collectNow لا يستطيع شمولها
    // بنيوياً (الأجرة خارج grandTotal) ⇒ إيصالُ نقدٍ لم يُقبَض يمنع إغلاق الوردية. تُرفض هنا
    // حتى تعالجها ش٦ (deliveryFeeHeld على مستوى الطلب) — «المندوب يقبضها» و«على المكتبة» يمرّان.
    for (const l of lines) {
      if (l.lineKind !== "CUSTOM" || !l.printSpec) continue;
      try {
        const spec = JSON.parse(l.printSpec) as { hasDelivery?: boolean; deliveryFeeCollection?: string; deliveryCost?: string };
        if (spec.hasDelivery && spec.deliveryFeeCollection === "COUNTER" && money(spec.deliveryCost ?? "0").gt(0)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `بند «${l.title ?? "تخصيص"}»: أجرة التوصيل «مقبوضة في الاستقبال» غير مدعومة على الطلب المحفوظ بعد — اختر «المندوب يقبضها من الزبون» أو «على المكتبة»، أو أتمّ الطلب من السلة مباشرةً`,
          });
        }
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        /* مواصفة تالفة ⇒ بلا توصيل — تمرّ */
      }
    }

    const lineMeta = await loadDraftLineMeta(tx, lines);
    const checkoutInput = materialize(draft, lines, input, heldNet, lineMeta);
    const result = await checkoutReceptionInTx(tx, checkoutInput, actor);

    // ش٤ (§٧.٣ خطوة ٦): تخصيص المحتجز على المستندات بنفس حصص الجشع الخادميّ (preSplit) —
    // صفوف APPLICATION + COLLECTION⇒APPLIED + ختم الإيصال أحاديّ الهدف بفاتورته.
    const targets: AllocationTarget[] = [];
    if (result.regularSale && money(result.preSplit.sale).gt(0)) {
      targets.push({ kind: "INVOICE", id: result.regularSale.invoiceId, preAmount: result.preSplit.sale });
    }
    if (result.printSale && money(result.preSplit.print).gt(0)) {
      targets.push({ kind: "INVOICE", id: result.printSale.invoiceId, preAmount: result.preSplit.print });
    }
    result.workOrders.forEach((w, i) => {
      const pre = result.preSplit.workOrders[i] ?? "0.00";
      if (money(pre).gt(0)) targets.push({ kind: "WORKORDER", id: w.workOrderId, preAmount: pre });
    });
    const { appliedPayments } = targets.length
      ? await allocateAtCommit(tx, { draftId: input.draftId, targets, actor })
      : { appliedPayments: [] };

    // صدق طريقة الدفع (١٨/٨) — فاتورةٌ مموَّلةٌ من عربونٍ محتجَز: `checkoutReceptionInTx` لا
    // يبني لها دفعةً (المال قُبض سابقاً وله إيصاله — I5) فتُختَم NULL. لكنّها **ليست آجلة**:
    // قُبضت فعلاً بطريقة العربون. نشتقّها الآن من طرق القبضات المطبَّقة عليها — بعد
    // allocateAtCommit حيث تُعرف الحصص — بنفس طيّ `mixedAwarePaymentMethod` (تعدّد ⇒ MIXED).
    await stampDerivedPaymentMethods(tx, appliedPayments);

    // ربط المحادثة بأمر الشغل **داخل معاملة التثبيت** (١٩/٨): إمّا (أمر شغل +
    // محادثةٌ مربوطة) وإمّا لا شيء — لا ظنٌّ لاحق يسقط إن انقطعت الشبكة.
    // والأوّل وحده: العمود علاقةٌ واحدٌ-لواحد، وسلّةٌ فيها أوامرُ عدّة خيطُها واحد.
    if (draft.conversationId != null && result.workOrders.length > 0) {
      await linkConversationToWorkOrderTx(
        tx,
        Number(draft.conversationId),
        Number(result.workOrders[0].workOrderId),
        actor,
      );
    }

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
        ? {
            invoiceId: result.regularSale.invoiceId,
            invoiceNumber: result.regularSale.invoiceNumber,
            shiftId: result.regularSale.shiftId ?? null,
          }
        : null,
      printSale: result.printSale
        ? {
            invoiceId: result.printSale.invoiceId,
            invoiceNumber: result.printSale.invoiceNumber,
            shiftId: result.printSale.shiftId ?? null,
          }
        : null,
      workOrders: result.workOrders.map((w) => ({ workOrderId: w.workOrderId, orderNumber: w.orderNumber, deposit: w.deposit })),
      appliedPayments,
      heldApplied: toDbMoney(heldNet),
      dispatch: result.dispatch
        ? {
            consignmentNumber: result.dispatch.consignmentNumber,
            codAmount: result.dispatch.codAmount,
            deliveryFee: result.dispatch.deliveryFee,
          }
        : null,
    } satisfies CommitDraftResult;
  });
}
