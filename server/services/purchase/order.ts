// دورة حياة أمر الشراء قبل الاستلام: الإنشاء (بالدينار أو بتثبيت دولاري) والإلغاء.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, inArray, like } from "drizzle-orm";
import { productVariants, products, purchaseOrderItems, purchaseOrders, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { convertToBaseQuantity } from "../inventoryService";
import { money, round2, sumMoney, toDateStr, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";
import type { CreatePurchaseOrderInput } from "./types";

/** تسلسل سعر ضمني لعمود decimal(15,4) — نظير toDbRate في exchangeHouseService. */
const toDbRate = (x: Decimal): string => x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

export async function createPurchaseOrder(input: CreatePurchaseOrderInput, actor: Actor) {
  return withTx(async (tx) => {
    // IDEM-06: idempotency check — نفس clientRequestId يعيد نفس المعرّف بدل إنشاء أمر مزدوج.
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "purchase.create", input.clientRequestId);
      if (existing != null) return { purchaseOrderId: existing, idempotent: true };
    }

    if (!input.items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء بلا أصناف" });

    // بضاعة الأمانة (§٥-ط، الحارس ١ — أخطر باب ازدواج AP): لا أمر شراء لمورّد من نوع CONSIGNOR —
    // بضاعته تُستلم بسند إيداع لا بأمر شراء (وإلا نشأ دين عند الاستلام + دين ثانٍ عند البيع).
    const [sup] = await tx.select({ kind: suppliers.supplierKind }).from(suppliers)
      .where(eq(suppliers.id, input.supplierId)).limit(1);
    if (sup?.kind === "CONSIGNOR")
      throw new TRPCError({ code: "BAD_REQUEST", message: "هذا مودِع أمانة — تُستلم بضاعته بسند إيداع من تبويب سندات الأمانة، لا بأمر شراء" });

    // gstack B5 (Bundle in PO ⇒ inventory limbo): البكج بلا مخزون ذاتي — تسجيله في أمر شراء يؤدّي إلى
    // فشل الاستلام بحاجز `applyMovement` بعد جهد إدخال كامل، وقد يترك بضاعة على الرصيف بلا AP. نرفض
    // عند الإدخال بدل التعثّر متأخّراً. `listForPurchase` يستبعده من المنتقيات، لكن الدفاع في العمق
    // على مستوى الخدمة يحرس المسارات الأخرى (استيراد/API خارجي/راوتر لا يمرّ بمنتقي الشاشة).
    const uniqueVariantIds = Array.from(new Set(input.items.map((it) => it.variantId)));
    if (uniqueVariantIds.length) {
      const flags = await tx
        .select({ isBundle: products.isBundle, isConsignment: products.isConsignment, productName: products.name, sku: productVariants.sku })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, uniqueVariantIds));
      for (const f of flags) {
        if (f.isBundle) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `لا يُشترى بكج مباشرةً: «${f.productName} — ${f.sku}». اشترِ مكوّناته فرادى.`,
          });
        }
        // بضاعة الأمانة: صنف أمانة يُستلم بسند إيداع لا بأمر شراء (يمنع ازدواج AP).
        if (f.isConsignment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `صنف أمانة: «${f.productName} — ${f.sku}» — يُستلم بسند إيداع لا بأمر شراء.`,
          });
        }
      }
    }

    const agreedCurrency = input.agreedCurrency ?? "IQD";
    const explicitUsdRate = agreedCurrency === "USD" && input.agreedRate != null
      ? money(input.agreedRate)
      : null;
    if (explicitUsdRate && explicitUsdRate.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سعر صرف تثبيت الفاتورة يجب أن يكون موجباً" });
    }

    const rows = [];
    const lineNets: string[] = [];
    const usdLineNets: string[] = [];
    for (const it of input.items) {
      // PROC-01: حدّ ثقة الخدمة — money() لا يَرفض السالب وحده، فنَفحص الإشارة صراحةً
      // (الخدمة تُستدعى أيضاً من importService/seed لا الراوتر فقط ⇒ دفاع متعمّق إلزامي).
      if (money(it.unitPrice).lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "سعر الشراء لا يصحّ أن يكون سالباً" });
      if (money(it.quantity).lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الشراء يجب أن تكون موجبة" });
      const { baseQuantity } = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
      const qty = money(it.quantity);
      const sourceUnitPrice = money(it.unitPrice);
      const usdUnitPrice = explicitUsdRate ? sourceUnitPrice : null;
      const usdLineNet = usdUnitPrice ? round2(usdUnitPrice.times(qty)) : null;
      // المسار الجديد: سعر البند المُدخل USD ويُحوّل بسعر التثبيت. المسار القديم بلا agreedRate
      // يبقى متوافقاً: unitPrice ديناري وusdTotal مرجع إجمالي فقط.
      const iqdUnitPrice = explicitUsdRate ? round2(sourceUnitPrice.times(explicitUsdRate)) : sourceUnitPrice;
      const lineNet = round2(iqdUnitPrice.times(qty));
      lineNets.push(lineNet.toFixed(2));
      if (usdLineNet) usdLineNets.push(usdLineNet.toFixed(2));
      rows.push({
        variantId: it.variantId,
        productUnitId: it.productUnitId,
        quantity: money(it.quantity).toFixed(3),
        baseQuantity,
        unitPrice: toDbMoney(iqdUnitPrice),
        total: lineNet.toFixed(2),
        usdUnitPrice: usdUnitPrice ? toDbRate(usdUnitPrice) : null,
        usdTotal: usdLineNet ? usdLineNet.toFixed(2) : null,
      });
    }
    // PROC-03: نسبة الضريبة في [٠، ١٠٠] — تَمنع ضريبة سالبة تُخفّض الإجمالي/AP، أو نسبة شاذّة.
    const taxRate = money(input.taxRatePercent ?? "0");
    if (taxRate.lt(0) || taxRate.gt(100)) throw new TRPCError({ code: "BAD_REQUEST", message: "نسبة الضريبة يجب أن تكون بين ٠ و١٠٠" });
    const subtotal = round2(sumMoney(lineNets));
    const tax = round2(subtotal.times(taxRate).dividedBy(100));

    // landed-cost (تكلفة الشحن/الكمرك): تُوزَّع على الأصناف بنسبة القيمة عند الاستلام وتُرسمَل في
    // تكلفة المخزون (WAVG) ⇒ تظهر لاحقاً في COGS عند البيع — لا تُسجَّل مصروفَ P&L (منعُ ازدواج:
    // وإلّا احتُسِبت مرّتين، مرّةً في COGS عبر WAVG الأعلى ومرّةً مصروفاً). v1: الافتراض أنّ فاتورة
    // المورّد شاملةٌ للشحن/الكمرك ⇒ تُضاف إلى ذمّة المورّد (AP) فيصير إجماليّ الأمر الفعليّ =
    // البضاعة + الضريبة + الشحن + الكمرك. (إن دُفِعا لطرفٍ آخر — شركة شحن/كمرك — يضبطه المالك
    // لاحقاً؛ v1 لا يفصلهما عن المورّد.) الطرحُ خادميٌّ دفاعيٌّ (money لا يرفض السالب وحده).
    // قرّب المكوّنين إلى ٢dp **قبل** اشتقاق landed/total وقبل التخزين ⇒ الأعمدة المخزَّنة تطابق
    // القيمة الداخلة في total تماماً. (استدعاءٌ مباشرٌ بقيمٍ دون السنت — import/seed/اختبار يتجاوز حارس
    // الراوتر nonNegMoneyString — كان يخزّن 0.01+0.01 بينما total يحمل round2(0.005+0.005)=0.01 فقط،
    // ثم receivePurchase يُعيد الحساب من الأعمدة فيُرحّل AP/مخزوناً لا يطابق po.total — Codex P2.)
    const shippingCost = round2(money(input.shippingCost ?? "0"));
    const customsCost = round2(money(input.customsCost ?? "0"));
    if (shippingCost.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "تكلفة الشحن لا تصحّ أن تكون سالبة" });
    if (customsCost.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "تكلفة الكمرك لا تصحّ أن تكون سالبة" });
    const landed = round2(shippingCost.plus(customsCost));
    // التوزيع بنسبة القيمة يتطلّب قيمة بضاعة موجبة — لا وعاء للتوزيع عند subtotal=0 (كلّ الأسعار صفر).
    if (landed.gt(0) && subtotal.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن توزيع الشحن/الكمرك على أمر بقيمة بضاعة صفر" });
    }
    const total = round2(subtotal.plus(tax).plus(landed));

    // USD الجديد: الإجمالي يُشتق من البنود الأصلية وسعر التثبيت صريح. يبقى المسار القديم مدعوماً
    // للفواتير التاريخية/الاستدعاءات التي ترسل إجمالياً دولارياً بعد إدخال أسعار دينارية.
    let usdTotalVal: Decimal | null = null;
    let agreedRateVal: Decimal | null = null;
    if (agreedCurrency === "USD") {
      const usdGoods = round2(sumMoney(usdLineNets));
      const usdTax = round2(usdGoods.times(taxRate).dividedBy(100));
      const expectedUsdInvoiceTotal = round2(usdGoods.plus(usdTax));
      usdTotalVal = explicitUsdRate ? expectedUsdInvoiceTotal : money(input.usdTotal ?? 0);
      if (usdTotalVal.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ بالدولار (فاتورة المورد) يجب أن يكون موجباً" });
      }
      if (explicitUsdRate && input.usdTotal != null && !round2(input.usdTotal).eq(expectedUsdInvoiceTotal)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "إجمالي فاتورة المورد بالدولار لا يطابق مجموع البنود" });
      }
      agreedRateVal = explicitUsdRate ?? total.dividedBy(usdTotalVal);
    }

    const ymd = toDateStr().replace(/-/g, "");
    const prefix = `PO-${input.branchId}-${ymd}-`;
    const lastRows = await tx
      .select({ n: purchaseOrders.poNumber })
      .from(purchaseOrders)
      .where(like(purchaseOrders.poNumber, `${prefix}%`))
      .orderBy(desc(purchaseOrders.id))
      .for("update")
      .limit(1);
    const seq = lastRows[0]?.n ? parseInt(lastRows[0].n.slice(prefix.length), 10) + 1 : 1;
    const poNumber = prefix + String(seq).padStart(5, "0");

    const insRes = await tx.insert(purchaseOrders).values({
      poNumber,
      supplierId: input.supplierId,
      branchId: input.branchId,
      subtotal: subtotal.toFixed(2),
      taxAmount: tax.toFixed(2),
      taxRatePercent: taxRate.toFixed(2),
      shippingCost: shippingCost.toFixed(2),
      customsCost: customsCost.toFixed(2),
      total: total.toFixed(2),
      status: input.status ?? "CONFIRMED",
      agreedCurrency,
      usdTotal: usdTotalVal ? usdTotalVal.toFixed(2) : null,
      agreedRate: agreedRateVal ? toDbRate(agreedRateVal) : null,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const purchaseOrderId = extractInsertId(insRes);

    for (const r of rows) {
      await tx.insert(purchaseOrderItems).values({ purchaseOrderId, ...r });
    }
    // IDEM-06: سجّل مفتاح الـidempotency — طلب متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK).
    if (input.clientRequestId) await recordIdempotencyKey(tx, "purchase.create", input.clientRequestId, purchaseOrderId);
    return { purchaseOrderId, poNumber, total: total.toFixed(2) };
  });
}

/**
 * إلغاء أمر شراء لم يُستلم منه شيء — قلب حالة خالص (createPurchaseOrder لا يكتب
 * أي قيد دفتر/AP/مخزون/إيصال؛ كل التأثيرات المالية والمخزنية تحدث في receivePurchase فقط).
 * أمرٌ استُلمت منه بضاعة يُعالَج بمرتجع شراء لا بالإلغاء.
 */
export async function cancelPurchaseOrder(purchaseOrderId: number, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const po = (
      await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).for("update").limit(1)
    )[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(po, actor);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء مستلَم أو ملغى" });
    }

    const items = await tx
      .select({ receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, purchaseOrderId));
    if (items.some((i) => (i.receivedBaseQuantity ?? 0) > 0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إلغاء أمر استُلمت منه بضاعة — استعمل مرتجع شراء" });
    }
    // دفاع متعمّق: الدفع للمورد يحدث فقط عند الاستلام ⇒ أمرٌ بلا استلام لا يحمل دفعة.
    if (money(po.paidAmount).gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء عليه دفعة مسجَّلة — لا يمكن إلغاؤه" });
    }

    await tx.update(purchaseOrders).set({ status: "CANCELLED" }).where(eq(purchaseOrders.id, purchaseOrderId));
    return { purchaseOrderId, status: "CANCELLED" as const };
  });
}
