/**
 * printSaleService — بيع خدمات قسم الطباعة والاستنساخ (نقطة بيع الخدمات).
 *
 * يختلف عن البيع العادي (saleService): المبيع **خدمة** (نسخة/طباعة/تصميم) لا بضاعة مخزنية،
 * فلا يُخصم مخزون الخدمة نفسها. بدلاً من ذلك تُربط كل خدمة بـ**وصفة إنتاج**
 * (productionRecipes.outputVariantId = متغيّر الخدمة) فتُخصم موادها الأولية (ورق/حبر) **بصمت**
 * عند البيع، وتُحتسَب كلفتها كـCOGS — تماماً كنموذج الورق المعتمد (الكلفة شأن إداري لا يراه الكاشير).
 *
 * يحافظ حرفياً على كل ثوابت المحرّك المالي المُدقّق (saleService): ذرّية withTx، قيد SALE
 * (revenue صافٍ، cost = كلفة المواد)، تقريب نقدي IQD + قيد ADJUST، PAYMENT_IN + إيصال + ذمم AR،
 * idempotency عبر invoices.sourceId، قفل الوردية/العميل، وفحص حدّ الائتمان.
 *
 * سلامة المخزون: استهلاك المواد عبر applyMovement (حركة OUT مُسجّلة لكل مادة) مع allowNegative —
 * فلا تُرفَض خدمة لأنّ النظام يُظهر نفاد الورق، والاستهلاك يبقى مُتعقَّباً بالكامل (رصيد سالب = إشارة تزويد).
 */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  customers,
  invoiceItems,
  invoices,
  productVariants,
  products,
  productionRecipeLines,
  productionRecipes,
  receipts,
  shifts,
} from "../../drizzle/schema";
import { computeInvoiceCost, computeInvoiceTotals, computeLineTotal } from "./billing";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, round2, roundCashIQD, toDbMoney } from "./money";
import { nextInvoiceNumber } from "./numbering";
import { getUnitPrice, resolveTier, type PriceTier } from "./pricing";
import { withTx, type Actor } from "./tx";

/** علامة نوع المنتج لخدمات الطباعة: لا مخزون ذاتي، والاستهلاك عبر وصفة المواد فقط.
 *  (مخزّنة في products.productType — لا تحتاج تغيير مخطّط.) */
export const PRINT_SERVICE_TYPE = "PRINT_SERVICE";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface PrintSaleLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  /** السعر اليدوي (سعر الخدمة قابل للتعديل من الكاشير). إن غاب يُؤخذ سعر الفئة. */
  unitPriceOverride?: string | null;
}

export interface CreatePrintSaleInput {
  branchId: number;
  shiftId?: number | null;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  lines: PrintSaleLineInput[];
  payment?: { amount: string; method: PaymentMethod } | null;
  clientRequestId?: string | null;
  notes?: string | null;
  /** موافقة مدير على تجاوز حدّ الائتمان (يضبطها الراوتر بعد التحقّق). */
  creditApproved?: boolean;
  dueDate?: string | null;
  /** تقريب نقدي عراقي للبيع النقدي الكامل (يضبطه POS). */
  cashRoundIQD?: boolean;
}

export interface CreatePrintSaleResult {
  invoiceId: number;
  invoiceNumber: string;
  total: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
  idempotentReplay?: boolean;
}

/** كمية مادة مستهلكة مُجمَّعة عبر كل أسطر الفاتورة (للخصم بحركة OUT واحدة لكل مادة). */
interface MaterialConsumption {
  variantId: number;
  baseQuantity: number; // عدد صحيح (وحدات أساس)
  unitCost: Decimal; // كلفة الوحدة الأساس (snapshot)
}

export async function createPrintSale(input: CreatePrintSaleInput, actor: Actor): Promise<CreatePrintSaleResult> {
  return withTx(async (tx) => {
    // ١. Idempotency: أعِد الفاتورة القائمة لنفس clientRequestId (نقرة مزدوجة/إعادة إرسال).
    if (input.clientRequestId) {
      const existing = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1);
      if (existing[0]) {
        return {
          invoiceId: Number(existing[0].id),
          invoiceNumber: existing[0].invoiceNumber,
          total: existing[0].total,
          status: existing[0].status as CreatePrintSaleResult["status"],
          idempotentReplay: true,
        };
      }
    }

    if (!input.lines.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء فاتورة بلا خدمات" });
    }

    // ٢. الوردية مفتوحة وتخصّ الفرع (قفل صفّ الوردية يُسلسِل البيع مع إغلاق الوردية).
    if (input.shiftId) {
      const s = await tx.select().from(shifts).where(eq(shifts.id, input.shiftId)).for("update").limit(1);
      if (!s[0] || s[0].status !== "OPEN" || Number(s[0].branchId) !== input.branchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية غير مفتوحة أو لا تخص هذا الفرع" });
      }
    }

    // ٣. فئة التسعير الفعّالة + قفل العميل (يُسلسِل البيوع الآجلة فلا يتجاوز اثنان حدّ الائتمان معاً).
    let customerTier: PriceTier | null = null;
    let customerCredit: { limit: Decimal; balance: Decimal } | null = null;
    if (input.customerId) {
      const c = await tx.select().from(customers).where(eq(customers.id, input.customerId)).for("update").limit(1);
      if (!c[0]) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      customerTier = c[0].defaultPriceTier as PriceTier;
      customerCredit = { limit: money(c[0].creditLimit ?? "0"), balance: money(c[0].currentBalance ?? "0") };
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier });

    // ٤. تحقّق أنّ كل سطر خدمةُ طباعة (productType=PRINT_SERVICE) — يمنع تمرير بضاعة مخزنية عبر
    //    مسار «بلا خصم مخزون ذاتي» (تسريب مخزون). يحمّل الكلفة/التفعيل من نفس الانضمام.
    const lineVarIds = Array.from(new Set(input.lines.map((l) => l.variantId)));
    const varRows = await tx
      .select({
        id: productVariants.id,
        isActive: productVariants.isActive,
        productType: products.productType,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, lineVarIds));
    const varMap = new Map(varRows.map((v) => [Number(v.id), v]));
    for (const l of input.lines) {
      const v = varMap.get(l.variantId);
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: `الخدمة ${l.variantId} غير موجودة` });
      if (v.isActive === false) throw new TRPCError({ code: "BAD_REQUEST", message: `الخدمة ${l.variantId} معطّلة` });
      if (v.productType !== PRINT_SERVICE_TYPE) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "هذه الشاشة تبيع خدمات الطباعة فقط" });
      }
    }

    // ٥. وصفات الخدمات (المواد المستهلكة) — استعلام مُجمَّع: وصفة فعّالة واحدة لكل خدمة.
    const recipeHeads = await tx
      .select({ id: productionRecipes.id, outputVariantId: productionRecipes.outputVariantId })
      .from(productionRecipes)
      .where(and(inArray(productionRecipes.outputVariantId, lineVarIds), eq(productionRecipes.isActive, true)))
      .orderBy(desc(productionRecipes.id)); // اختيار حتمي: الأحدث يفوز (لا اعتماد على ترتيب القاعدة)
    const recipeByOutput = new Map<number, number>(); // outputVariantId → recipeId (الأحدث = الأول بعد desc)
    for (const r of recipeHeads) if (!recipeByOutput.has(Number(r.outputVariantId))) recipeByOutput.set(Number(r.outputVariantId), Number(r.id));
    const recipeIds = Array.from(new Set(recipeByOutput.values()));
    const recLines = recipeIds.length
      ? await tx
          .select({
            recipeId: productionRecipeLines.recipeId,
            inputVariantId: productionRecipeLines.inputVariantId,
            qtyPerOutputBase: productionRecipeLines.qtyPerOutputBase,
          })
          .from(productionRecipeLines)
          .where(inArray(productionRecipeLines.recipeId, recipeIds))
      : [];
    const linesByRecipe = new Map<number, Array<{ inputVariantId: number; qtyPerOutputBase: string }>>();
    for (const rl of recLines) {
      const rid = Number(rl.recipeId);
      if (!linesByRecipe.has(rid)) linesByRecipe.set(rid, []);
      linesByRecipe.get(rid)!.push({ inputVariantId: Number(rl.inputVariantId), qtyPerOutputBase: String(rl.qtyPerOutputBase) });
    }
    // كلفة المواد المُستهلَكة (snapshot من costPrice).
    const materialVarIds = Array.from(new Set(recLines.map((rl) => Number(rl.inputVariantId))));
    const matCostRows = materialVarIds.length
      ? await tx.select({ id: productVariants.id, costPrice: productVariants.costPrice }).from(productVariants).where(inArray(productVariants.id, materialVarIds))
      : [];
    const matCostMap = new Map(matCostRows.map((m) => [Number(m.id), money(m.costPrice)]));

    // ٦. سعّر/حوّل كل سطر + احسب كلفة مواده (COGS) واجمع استهلاك المواد.
    const computed: Array<{
      variantId: number;
      productUnitId: number;
      baseQuantity: number;
      unitPrice: string;
      quantity: string;
      total: string;
      lineCost: Decimal; // كلفة مواد السطر
      unitCost: string; // كلفة الوحدة (للعرض) = lineCost / baseQuantity
    }> = [];
    const materialAgg = new Map<number, { baseQuantity: number; unitCost: Decimal }>();

    for (const l of input.lines) {
      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : await getUnitPrice(tx, l.productUnitId, tier);
      const lineRes = computeLineTotal({ unitPrice, quantity: money(l.quantity) });

      // كلفة المواد: وسّع وصفة الخدمة (إن وُجدت).
      let lineCost = new Decimal(0);
      const recipeId = recipeByOutput.get(l.variantId);
      if (recipeId != null) {
        for (const rl of linesByRecipe.get(recipeId) ?? []) {
          // الاستهلاك = qtyPerOutputBase × كمية الخدمة الأساس؛ يُدوَّر لعدد صحيح (وحدات مخزون صحيحة).
          const consumed = Math.max(0, Math.round(money(rl.qtyPerOutputBase).times(baseQuantity).toNumber()));
          if (consumed <= 0) continue;
          const unitCost = round2(matCostMap.get(rl.inputVariantId) ?? new Decimal(0));
          lineCost = lineCost.plus(round2(unitCost.times(consumed)));
          const agg = materialAgg.get(rl.inputVariantId) ?? { baseQuantity: 0, unitCost };
          agg.baseQuantity += consumed;
          materialAgg.set(rl.inputVariantId, agg);
        }
      }
      lineCost = round2(lineCost);
      const unitCost = baseQuantity > 0 ? round2(lineCost.div(baseQuantity)) : new Decimal(0);
      computed.push({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        baseQuantity,
        unitPrice: lineRes.unitPrice,
        quantity: lineRes.quantity,
        total: lineRes.total,
        lineCost,
        unitCost: unitCost.toFixed(2),
      });
    }

    // ٧. الإجماليات + COGS. costTotal = Σ(unitCost × baseQuantity) (نفس تعريف saleService بالضبط)
    //    ⇒ تقارير الكلفة/الربح تعيد إنتاج costTotal والدفتر من invoiceItems.unitCost بلا انحراف سنتيّ.
    const totals = computeInvoiceTotals({ lineTotals: computed.map((c) => c.total) });
    const costTotal = money(computeInvoiceCost(computed.map((c) => ({ unitCost: c.unitCost, baseQuantity: c.baseQuantity }))));

    // ٨. تقريب نقدي IQD للبيع النقدي الكامل (نفس سياسة saleService): يُقرَّب الإجمالي، النقد = المقرّب،
    //    والفرق قيد ADJUST ⇒ (SALE.amount + ADJUST.amount) = الإجمالي المقرّب = النقد المستلم.
    const roundCash = !!input.cashRoundIQD && input.payment?.method === "CASH";
    const grandTotalD = money(totals.total);
    const effectiveTotalD = roundCash ? roundCashIQD(grandTotalD) : grandTotalD;
    const cashRoundingAdj = effectiveTotalD.minus(grandTotalD);
    const paidNow = roundCash ? effectiveTotalD : money(input.payment?.amount ?? "0");
    const unpaid = effectiveTotalD.minus(paidNow);
    if (unpaid.gt(0) && !input.customerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البيع الآجل يتطلب عميلاً محدداً" });
    }
    if (unpaid.gt(0) && customerCredit && customerCredit.limit.gt(0) && !input.creditApproved) {
      const projected = customerCredit.balance.plus(unpaid);
      if (projected.gt(customerCredit.limit)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `تجاوز حدّ الائتمان: الرصيد بعد البيع ${projected.toFixed(2)} يتجاوز السقف ${customerCredit.limit.toFixed(2)} — تلزم موافقة مدير.`,
        });
      }
    }

    // ٩. رأس الفاتورة.
    const invoiceNumber = await nextInvoiceNumber(tx, input.branchId);
    const status = computeInvoiceStatus(toDbMoney(effectiveTotalD), toDbMoney(paidNow));
    const insRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "POS",
      sourceId: input.clientRequestId ?? null,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      customerId: input.customerId ?? null,
      priceTier: tier,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      discountAmount: totals.discountAmount,
      total: toDbMoney(effectiveTotalD),
      costTotal: toDbMoney(costTotal),
      cashRoundingAdjustment: toDbMoney(cashRoundingAdj),
      status,
      paidAmount: toDbMoney(paidNow),
      paymentMethod: input.payment?.method ?? null,
      paymentDate: paidNow.gt(0) ? new Date() : null,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const invoiceId = Number((insRes as any)[0]?.insertId ?? (insRes as any).insertId);

    // ١٠. الأصناف (الخدمات). لا خصم مخزون ذاتي للخدمة (متغيّر الخدمة بلا رصيد).
    for (const c of computed) {
      await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitPrice: c.unitPrice,
        unitCost: c.unitCost,
        total: c.total,
      });
    }

    // ١١. خصم المواد الأولية (ورق/حبر) بصمت — حركة OUT واحدة لكل مادة، بترتيب variantId حتمي،
    //     مع allowNegative (لا تُرفَض الخدمة عند نفاد المادة؛ الاستهلاك يبقى مُتعقَّباً).
    const materials: MaterialConsumption[] = Array.from(materialAgg.entries())
      .map(([variantId, m]) => ({ variantId, baseQuantity: m.baseQuantity, unitCost: m.unitCost }))
      .sort((a, b) => a.variantId - b.variantId);
    for (const m of materials) {
      if (m.baseQuantity <= 0) continue;
      await applyMovement(tx, {
        variantId: m.variantId,
        branchId: input.branchId,
        baseQuantity: m.baseQuantity,
        movementType: "OUT",
        referenceType: "PRINT_SALE",
        referenceId: invoiceId,
        createdBy: actor.userId,
        allowNegative: true,
      });
    }

    // ١٢. قيد البيع (revenue = صافٍ قبل الضريبة، cost = كلفة المواد المستهلكة).
    const revenue = money(totals.subtotal).minus(money(totals.discountAmount));
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`,
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue,
      cost: costTotal,
      profit: revenue.minus(costTotal),
      taxAmount: money(totals.taxAmount),
      amount: money(totals.total),
    });

    // ١٢.b تسوية التقريب النقدي.
    if (!cashRoundingAdj.isZero()) {
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: input.branchId,
        invoiceId,
        customerId: input.customerId ?? null,
        revenue: cashRoundingAdj,
        profit: cashRoundingAdj,
        amount: cashRoundingAdj,
        notes: "تقريب نقدي IQD",
      });
    }

    // ١٣. الدفع + الذمم.
    if (paidNow.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        invoiceId,
        branchId: input.branchId,
        shiftId: input.shiftId ?? null,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        invoiceId,
        receiptId,
        customerId: input.customerId ?? null,
        amount: paidNow,
      });
    }
    if (input.customerId) {
      await adjustCustomerBalance(tx, input.customerId, effectiveTotalD.minus(paidNow));
    }

    return { invoiceId, invoiceNumber, total: toDbMoney(effectiveTotalD), status };
  });
}
