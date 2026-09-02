// دورة حياة أمر الشراء قبل الاستلام: الإنشاء (بالدينار أو بتثبيت دولاري) والإلغاء.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, inArray, like } from "drizzle-orm";
import { branches, productVariants, products, purchaseOrderItems, purchaseOrders, receipts, suppliers } from "../../../drizzle/schema";
import { isWithinPriceDecimals, priceDecimalsMessage, type PriceCurrency } from "../../../shared/moneyPrecision";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { convertToBaseQuantity } from "../inventoryService";
import { money, round2, sumMoney, toDateStr, toDbMoney } from "../money";
import {
  removeVariantsFromActiveOpeningStocktakes,
  restoreVariantsToActiveOpeningStocktakes,
} from "../stocktake/openingEligibility";
import type { Tx } from "../../db";
import { requireDb, withTx, type Actor } from "../tx";
import { assertPurchaseBranch } from "./internal";
import { postPurchaseInvoiceInTx, type PurchasePostingDetails } from "./receive";
import type { CreatePurchaseOrderInput, PurchaseDocumentInput, UpdatePurchaseOrderInput } from "./types";

/** تسلسل سعر ضمني لعمود decimal(15,4) — نظير toDbRate في exchangeHouseService. */
const toDbRate = (x: Decimal): string => x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

/**
 * حارس الأصناف القابلة للشراء — بكج أو صنف أمانة يُرفَض عند الإدخال لا عند الاستلام.
 * مُستخرَجٌ كي يحرس **الإنشاء والتعديل** معاً: تعديلٌ يُدخل بكجاً كان سيتجاوز حارس الإنشاء
 * ويتعثّر لاحقاً في `applyMovement` بعد جهد إدخالٍ كامل (بضاعةٌ على الرصيف بلا AP).
 */
async function assertPurchasableVariants(tx: Tx, uniqueVariantIds: number[]): Promise<void> {
  if (!uniqueVariantIds.length) return;
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

/**
 * تسمية صنفٍ مقروءة للرسائل — تُستدعى **في مسار الخطأ وحده** (استعلامٌ واحد لصنفٍ واحد) كي يعرف
 * المستخدم أيّ سطرٍ يُصحّح بدل رسالةٍ عامّة. تعذّر القراءة ⇒ المعرّف الخام (لا نُفشل رسالة خطأ).
 */
async function variantLabel(tx: Tx, variantId: number): Promise<string> {
  try {
    const [row] = await tx
      .select({ name: products.name, sku: productVariants.sku })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(productVariants.id, variantId))
      .limit(1);
    if (!row) return `الصنف #${variantId}`;
    return row.sku ? `${row.name} — ${row.sku}` : String(row.name);
  } catch {
    return `الصنف #${variantId}`;
  }
}

/**
 * ضابط **مطابقة فاتورة المورّد**: القيمة المُعلَنة على ورقة المورّد يجب أن تساوي الإجماليَّ
 * المشتقّ من البنود بالضبط، وإلّا رُفض الحفظ.
 *
 * **الجذر (بلاغ المالك ١٧/٨/٢٦):** كانت الرسالة الوحيدة «إجمالي فاتورة المورد بالدولار لا يطابق
 * مجموع البنود» — بلا الرقمين ولا الفرق ولا سببٍ محتمل، فلا يعرف الموظّف أين يُصحّح؛ حتى إنّ
 * الشاشتين امتنعتا عن إرسال القيمة أصلاً هرباً من الرفض، فضاع الضابط كلّه وصار الأمر يُحفَظ بلا
 * أيّ تحقّقٍ من مستنده. الرسالة الآن **تشخيصيّة**: الرقمان والفرق واتّجاهه وسببه المعتاد.
 */
function assertSupplierInvoiceMatch(declaredRaw: string, expected: Decimal, currency: "IQD" | "USD"): void {
  const declared = round2(money(declaredRaw));
  if (declared.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "قيمة فاتورة المورّد لا تصحّ أن تكون سالبة" });
  }
  const expectedR = round2(expected);
  if (declared.eq(expectedR)) return;
  const cur = currency === "USD" ? "$" : "د.ع";
  const diff = declared.minus(expectedR);
  const hint = diff.isNegative()
    ? "خصمٌ من المورّد لم يُدخَل، أو سعر وحدةٍ أعلى مما في الفاتورة"
    : "بندٌ لم يُدخَل، أو سعر وحدةٍ أقلّ مما في الفاتورة، أو أجرة شحنٍ مدرَجة في الفاتورة (تُدخَل في حقل الشحن)";
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      `قيمة فاتورة المورّد (${declared.toFixed(2)} ${cur}) لا تطابق مجموع البنود ` +
      `(${expectedR.toFixed(2)} ${cur}) — الفرق ${diff.abs().toFixed(2)} ${cur}. السبب المعتاد: ${hint}.`,
  });
}

/**
 * توزيعُ مبلغٍ على بنودٍ **بنسبة قيمتها**، مع ضمانٍ صارم أنّ المجموع = الهدف بالضبط.
 *
 * التقريبُ لكلّ بندٍ على حدة يترك باقياً (سنتات) لا يصحّ أن يضيع ولا أن يُضاف من العدم (§٥:
 * «لا دينار يضيع بصمت»)، فيمتصّه **أكبرُ بندٍ قيمةً**. اختير الأكبر لا الأخير — كما في
 * `allocateLineTax` — لأنّ الباقي قد يفوق قيمةَ بندٍ صغيرٍ جداً في فاتورةٍ كثيرة البنود فيقلبه
 * سالباً؛ والأكبر يستوعبه دائماً. والاختيار حتميّ (أوّل أكبر) ⇒ إعادةُ حساب التعديل تُعطي نفس
 * التوزيع بالضبط، فلا ينجرف الأمر بمجرّد إعادة حفظه.
 */
function allocateByValue(grossLines: Decimal[], target: Decimal): Decimal[] {
  const grossTotal = grossLines.reduce((acc, g) => acc.plus(g), new Decimal(0));
  if (grossTotal.lte(0)) return grossLines.map(() => new Decimal(0));
  const allocated = grossLines.map((g) => round2(g.times(target).dividedBy(grossTotal)));
  let absorbIdx = -1;
  for (let i = 0; i < grossLines.length; i++) {
    if (grossLines[i].gt(0) && (absorbIdx < 0 || grossLines[i].gt(grossLines[absorbIdx]))) absorbIdx = i;
  }
  if (absorbIdx >= 0) {
    const sum = allocated.reduce((acc, a) => acc.plus(a), new Decimal(0));
    allocated[absorbIdx] = round2(allocated[absorbIdx].plus(target.minus(sum)));
  }
  return allocated;
}

/**
 * حساب أسطر أمر الشراء وإجمالياته — **مصدر الحقيقة الحسابيّ الوحيد للإنشاء والتعديل معاً.**
 *
 * استُخرِج من `createPurchaseOrder` بلا أيّ تغيير سلوكيّ. سببُ الاستخراج بنيويّ: تعديلُ الأمر
 * يُعيد اشتقاق نفس الأعمدة (subtotal/tax/total/usdTotal/agreedRate وأسعار البنود الدينارية)،
 * ونسخُ الحساب في دالّتين يضمن انجرافاً: أيّ تصحيحٍ لقاعدة تقريبٍ أو لسعر تثبيتٍ يُطبَّق على
 * مسارٍ واحد فيُنتِج أمرَين متطابقَي المدخلات مختلفَي الإجمالي — والاستلام يقرأ الأعمدة المخزَّنة
 * فيُرحّل AP لا يطابق ما رآه المستخدم.
 */
async function computePurchaseDocument(tx: Tx, input: PurchaseDocumentInput) {
  const agreedCurrency = input.agreedCurrency ?? "IQD";
  const explicitUsdRate = agreedCurrency === "USD" && input.agreedRate != null
    ? money(input.agreedRate)
    : null;
  if (explicitUsdRate && explicitUsdRate.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سعر صرف تثبيت الفاتورة يجب أن يكون موجباً" });
  }

  // عملةُ **أسعار البنود** ليست دائماً عملةَ الأمر: المسار القديم (agreedCurrency=USD بلا سعر
  // تثبيت) يُدخل أسعاراً دينارية و`usdTotal` مرجعاً إجمالياً فقط. الحاسم هو وجود سعر التثبيت.
  const linePriceCurrency: PriceCurrency = explicitUsdRate ? "USD" : "IQD";

  // ═══ تمريرة ١: قيم البنود **قبل خصم الفاتورة** بعملة المستند ═══════════════════
  // الخصم فاتوريّ لا سطريّ (هكذا يُحرّره المورّد)، فيلزم معرفةُ المجموع الإجماليّ قبل توزيعه ⇒
  // تمريرتان: الأولى تتحقّق وتحسب القيم الأصلية، والثانية تُنتج الصفوف الصافية.
  const gross: Array<{
    it: (typeof input.items)[number];
    baseQuantity: number;
    qty: Decimal;
    grossUnitDoc: Decimal;
    grossLineDoc: Decimal;
  }> = [];
  for (const it of input.items) {
    // PROC-01: حدّ ثقة الخدمة — money() لا يَرفض السالب وحده، فنَفحص الإشارة صراحةً
    // (الخدمة تُستدعى أيضاً من importService/seed لا الراوتر فقط ⇒ دفاع متعمّق إلزامي).
    if (money(it.unitPrice).lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "سعر الشراء لا يصحّ أن يكون سالباً" });
    if (money(it.quantity).lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الشراء يجب أن تكون موجبة" });
    // دقّة السعر حسب عملته (`shared/moneyPrecision`): الدينار منزلتان (عمود decimal(15,2))
    // والدولار أربع (عمود usdUnitPrice decimal(15,4)). **رفضٌ صريح لا قصٌّ صامت**: قصُّ 3.4566
    // إلى 3.46 يبدو نجاحاً بينما يُنقص ذمّة المورّد ويُسمّم WAVG لكلّ بيعةٍ لاحقة من الصنف.
    //
    // ⚠️ الفحص على **قيمةٍ حاضرة فقط**: القيمة الغائبة/الفارغة يعاملها `money()` صفراً منذ الأصل
    // (والراوتر يجعل الحقل إلزامياً أصلاً، فلا يبلغها إلا مستدعٍ مباشر). إقحامُها في فحص الدقّة
    // يُنتج رسالة «يقبل منزلتين» عن حقلٍ لم يُرسَل إطلاقاً — تشخيصٌ مضلِّل. والصيغُ التالفة يردّها
    // `money()` أعلاه برسالتها الصحيحة («قيمة غير صالحة») قبل الوصول إلى هنا.
    const rawUnitPrice = it.unitPrice == null ? "" : String(it.unitPrice).trim();
    if (rawUnitPrice !== "" && !isWithinPriceDecimals(rawUnitPrice, linePriceCurrency)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: priceDecimalsMessage(linePriceCurrency, await variantLabel(tx, it.variantId), rawUnitPrice),
      });
    }
    const { baseQuantity } = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
    const qty = money(it.quantity);
    const grossUnitDoc = money(it.unitPrice);
    gross.push({ it, baseQuantity, qty, grossUnitDoc, grossLineDoc: round2(grossUnitDoc.times(qty)) });
  }

  // ═══ خصم فاتورة المورّد (0204) ═════════════════════════════════════════════════
  // يُدخَل بعملة المستند ويُوزَّع **بنسبة القيمة**، فتُخزَّن أعمدةُ المال صافيةً ⇒ الذمّة وتكلفةُ
  // المخزون ومرتجعُ الشراء تلتقطه بلا تغييرٍ في قرّائها (قرار المالك: «تكلفة الصنف = سعر المورّد
  // وحده» — وخصمُ المورّد جزءٌ من سعره، فيَنقص التكلفة لا يُسجَّل إيراداً).
  const grossSubtotalDoc = round2(sumMoney(gross.map((g) => g.grossLineDoc.toFixed(2))));
  const discountDoc = round2(money(input.invoiceDiscount ?? "0"));
  const docSym = linePriceCurrency === "USD" ? "$" : "د.ع";
  if (discountDoc.lt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "خصم فاتورة المورّد لا يصحّ أن يكون سالباً" });
  }
  if (discountDoc.gt(grossSubtotalDoc)) {
    // خصمٌ يتجاوز البضاعة يقلب الذمّة والتكلفة سالبتَين — رفضٌ بالرقمين لا رسالةٌ عامّة.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `خصم فاتورة المورّد (${discountDoc.toFixed(2)} ${docSym}) يتجاوز قيمة البضاعة ` +
        `(${grossSubtotalDoc.toFixed(2)} ${docSym}) — راجع الخصم أو أسعار البنود.`,
    });
  }
  const netTargetDoc = grossSubtotalDoc.minus(discountDoc);
  const netLinesDoc = allocateByValue(gross.map((g) => g.grossLineDoc), netTargetDoc);
  // نسبةُ الصافي إلى الإجماليّ: تُشتقّ منها **أسعار الوحدة** الصافية. لا نشتقّها من إجمالي السطر
  // مقسوماً على الكمّية: ذلك يُعيد تقريباً مركّباً يُزحزح سعر الدولار ذا الأربع منازل حتى بلا خصم.
  const discountRatio = grossSubtotalDoc.gt(0) ? netTargetDoc.dividedBy(grossSubtotalDoc) : new Decimal(1);
  const roundDocPrice = (x: Decimal) =>
    linePriceCurrency === "USD" ? x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP) : round2(x);

  // ═══ تمريرة ٢: الصفوف النهائية (صافيةً بعد الخصم) ══════════════════════════════
  const rows = [];
  const lineNets: string[] = [];
  const usdLineNets: string[] = [];
  const grossLineIqds: string[] = [];
  for (let i = 0; i < gross.length; i++) {
    const g = gross[i];
    // بلا خصم ⇒ النسبة ١ والسعر الصافي = الأصليّ **حرفياً** (صفر أثرٍ على السلوك القائم).
    const netUnitDoc = discountDoc.isZero() ? g.grossUnitDoc : roundDocPrice(g.grossUnitDoc.times(discountRatio));
    const netLineDoc = netLinesDoc[i];
    const usdUnitPrice = explicitUsdRate ? netUnitDoc : null;
    const usdLineNet = explicitUsdRate ? netLineDoc : null;
    // المسار الجديد: سعر البند المُدخل USD ويُحوّل بسعر التثبيت. المسار القديم بلا agreedRate
    // يبقى متوافقاً: unitPrice ديناري وusdTotal مرجع إجمالي فقط.
    // سعرُ الوحدة الدينارية يبقى ٢dp (عمودُه decimal(15,2)) — عرضٌ ومرجعُ تكلفةِ الوحدة عند الاستلام.
    const iqdUnitPrice = explicitUsdRate ? round2(netUnitDoc.times(explicitUsdRate)) : netUnitDoc;
    // إجماليُّ السطر بالدينار يُترجَم من **إجمالي السطر بالدولار**، لا من سعر الوحدة بعد تقريبه:
    // الالتزام دولاريّ والدينارُ ترجمتُه بسعر التثبيت. الضربُ بعد التقريب كان يُراكم فرقَ التقريب
    // × الكمية (٥٠٠٠ وحدة × فرق ٠٫٤ د.ع = ٢٠٠٠ د.ع) فيخالف إجماليُّ الأمر فاتورةَ المورّد وذمّته.
    const lineNet = explicitUsdRate ? round2(netLineDoc.times(explicitUsdRate)) : netLineDoc;
    lineNets.push(lineNet.toFixed(2));
    if (usdLineNet) usdLineNets.push(usdLineNet.toFixed(2));
    grossLineIqds.push(
      (explicitUsdRate ? round2(g.grossLineDoc.times(explicitUsdRate)) : g.grossLineDoc).toFixed(2),
    );
    rows.push({
      variantId: g.it.variantId,
      productUnitId: g.it.productUnitId,
      quantity: g.qty.toFixed(3),
      baseQuantity: g.baseQuantity,
      unitPrice: toDbMoney(iqdUnitPrice),
      total: lineNet.toFixed(2),
      usdUnitPrice: usdUnitPrice ? toDbRate(usdUnitPrice) : null,
      usdTotal: usdLineNet ? usdLineNet.toFixed(2) : null,
      // لقطةُ ورقة المورّد: السعر **قبل** الخصم. `null` بلا خصم ⇒ القارئ يسقط على `unitPrice`.
      listUnitPrice: discountDoc.isZero()
        ? null
        : toDbMoney(explicitUsdRate ? round2(g.grossUnitDoc.times(explicitUsdRate)) : g.grossUnitDoc),
      usdListUnitPrice: discountDoc.isZero() || !explicitUsdRate ? null : toDbRate(g.grossUnitDoc),
    });
  }
  // PROC-03: نسبة الضريبة في [٠، ١٠٠] — تَمنع ضريبة سالبة تُخفّض الإجمالي/AP، أو نسبة شاذّة.
  const taxRate = money(input.taxRatePercent ?? "0");
  if (taxRate.lt(0) || taxRate.gt(100)) throw new TRPCError({ code: "BAD_REQUEST", message: "نسبة الضريبة يجب أن تكون بين ٠ و١٠٠" });
  const subtotal = round2(sumMoney(lineNets));
  // الضريبة على الوعاء **بعد الخصم** (المعالجة القياسية: الخصم التجاريّ يُنقص وعاء الضريبة).
  const tax = round2(subtotal.times(taxRate).dividedBy(100));
  // الخصمُ بالدينار = فرقُ الإجماليَّين الدينارّيَين (للأمر الدولاريّ هو ترجمةُ خصمه بسعر التثبيت).
  const invoiceDiscountIqd = round2(round2(sumMoney(grossLineIqds)).minus(subtotal));
  const usdInvoiceDiscountVal = explicitUsdRate ? discountDoc : null;

  // landed-cost (تكلفة الشحن/الكمرك): قرار المالك (٥/٨/٢٦) — تُخزَّن على الأمر وتُسجَّل مصروفَ
  // نقلٍ مستقلاً لحظة الاستلام (`receive.ts`)، فهي **خارج الإجمالي وخارج ذمّة المورّد** ولا تدخل
  // تكلفة الصنف (WAVG). الطرحُ خادميٌّ دفاعيٌّ (money لا يرفض السالب وحده). قرّب المكوّنين إلى ٢dp
  // **قبل** الاشتقاق والتخزين ⇒ الأعمدة المخزَّنة تطابق ما يقرأه الاستلام تماماً (Codex P2).
  const shippingCost = round2(money(input.shippingCost ?? "0"));
  const customsCost = round2(money(input.customsCost ?? "0"));
  if (shippingCost.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "تكلفة الشحن لا تصحّ أن تكون سالبة" });
  if (customsCost.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "تكلفة الكمرك لا تصحّ أن تكون سالبة" });
  const landed = round2(shippingCost.plus(customsCost));
  // التوزيع بنسبة القيمة يتطلّب قيمة بضاعة موجبة — لا وعاء للتوزيع عند subtotal=0 (كلّ الأسعار صفر).
  if (landed.gt(0) && subtotal.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن توزيع الشحن/الكمرك على أمر بقيمة بضاعة صفر" });
  }
  const total = round2(subtotal.plus(tax));

  // USD الجديد: الإجمالي يُشتق من البنود الأصلية وسعر التثبيت صريح. يبقى المسار القديم مدعوماً
  // للفواتير التاريخية/الاستدعاءات التي ترسل إجمالياً دولارياً بعد إدخال أسعار دينارية.
  let usdTotalVal: Decimal | null = null;
  let agreedRateVal: Decimal | null = null;
  let expectedInvoiceTotal = total; // الإجماليّ بعملة الأمر — مرجعُ مطابقة فاتورة المورّد.
  if (agreedCurrency === "USD") {
    const usdGoods = round2(sumMoney(usdLineNets));
    const usdTax = round2(usdGoods.times(taxRate).dividedBy(100));
    const expectedUsdInvoiceTotal = round2(usdGoods.plus(usdTax));
    usdTotalVal = explicitUsdRate ? expectedUsdInvoiceTotal : money(input.usdTotal ?? 0);
    if (usdTotalVal.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ بالدولار (فاتورة المورد) يجب أن يكون موجباً" });
    }
    if (explicitUsdRate) {
      expectedInvoiceTotal = expectedUsdInvoiceTotal;
      // `usdTotal` مسارٌ قديمٌ يحمل نفس معنى `supplierInvoiceTotal` ⇒ يمرّ بالحارس نفسه برسالته
      // المُرقَّمة (كانت «لا يطابق مجموع البنود» عمياء: بلا رقمٍ ولا سببٍ ولا سبيلِ تسوية).
      if (input.usdTotal != null) {
        assertSupplierInvoiceMatch(input.usdTotal, expectedUsdInvoiceTotal, "USD");
      }
    }
    agreedRateVal = explicitUsdRate ?? total.dividedBy(usdTotalVal);
  }

  // ضابط مطابقة فاتورة المورّد: يُفحَص بعملة **أسعار البنود** لا بـ`agreedCurrency` — فالمسار
  // القديم (USD بلا سعر تثبيت) أسعارُه دينارية وإجماليّه دينارّي، فمقارنتُه بعلامة «$» كانت
  // ستقارن رقمين بعملتين وتُسمّي الدينار دولاراً. `linePriceCurrency` هو المعيار الصادق الوحيد.
  if (input.supplierInvoiceTotal != null && String(input.supplierInvoiceTotal).trim() !== "") {
    assertSupplierInvoiceMatch(input.supplierInvoiceTotal, expectedInvoiceTotal, linePriceCurrency);
  }

  return { rows, subtotal, tax, taxRate, shippingCost, customsCost, total, agreedCurrency, usdTotalVal, agreedRateVal, invoiceDiscountIqd, usdInvoiceDiscountVal };
}

/**
 * منشئ سجل أمر منخفض المستوى لمسودات إعادة الطلب واختبارات النواة التاريخية. التطبيق لا يستعمله
 * لحفظ فاتورة معتمدة؛ راوتر المشتريات يستعمل `createPurchaseInvoice` كي يكون الحفظ والترحيل ذريين.
 */
export async function createPurchaseOrder(input: CreatePurchaseOrderInput, actor: Actor) {
  return persistPurchaseOrder(input, actor, false);
}

/** حفظ فاتورة شراء: المسودة بلا أثر، والمعتمدة تُرحّل كاملةً إلى المخزون والدفتر في المعاملة نفسها. */
export async function createPurchaseInvoice(input: CreatePurchaseOrderInput, actor: Actor & { role?: string }) {
  return persistPurchaseOrder(input, actor, true);
}

async function persistPurchaseOrder(
  input: CreatePurchaseOrderInput,
  actor: Actor & { role?: string },
  autoPostConfirmed: boolean,
) {
  return withTx(async (tx) => {
    // IDEM-06: idempotency check — نفس clientRequestId يعيد نفس المعرّف بدل إنشاء أمر مزدوج.
    // المسار ج-٥ (١٧/٨): المفتاح وحده كان يُطابَق ⇒ طلبٌ بنفس المفتاح لكن **بمورّدٍ أو أسطرٍ أو
    // مبالغ مختلفة** يتلقّى «نجاحاً» ويُعاد له معرّف الأمر الأوّل بلا أن يُنفَّذ شيء: أمرُ شراءٍ
    // يظنّه المستخدم محفوظاً وهو غير موجود. صارت البصمة تشمل **كل حقلٍ يغيّر النتيجة** (الأسطر
    // مرتّبةً كي لا يُغيّر ترتيبُ العرض البصمةَ)، والاختلاف يُرفض صراحةً بـCONFLICT من
    // `checkIdempotency` بدل النجاح الكاذب.
    const payloadFingerprint = {
      supplierId: input.supplierId,
      branchId: input.branchId,
      settlementType: input.settlementType ?? "CREDIT",
      status: input.status ?? null,
      taxRatePercent: input.taxRatePercent ?? null,
      agreedCurrency: input.agreedCurrency ?? null,
      usdTotal: input.usdTotal ?? null,
      agreedRate: input.agreedRate ?? null,
      invoiceDiscount: input.invoiceDiscount ?? null,
      shippingCost: input.shippingCost ?? null,
      customsCost: input.customsCost ?? null,
      shippingPaymentMethod: input.shippingPaymentMethod ?? null,
      shippingPaymentReference: input.shippingPaymentReference ?? null,
      shippingCardLastFour: input.shippingCardLastFour ?? null,
      shippingBeneficiarySupplierId: input.shippingBeneficiarySupplierId ?? null,
      shippingBeneficiaryName: input.shippingBeneficiaryName ?? null,
      shippingEvidenceReference: input.shippingEvidenceReference ?? null,
      items: [...input.items]
        .map((i) => ({
          variantId: i.variantId,
          productUnitId: i.productUnitId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        }))
        .sort((a, b) =>
          a.variantId - b.variantId ||
          a.productUnitId - b.productUnitId ||
          a.quantity.localeCompare(b.quantity) ||
          a.unitPrice.localeCompare(b.unitPrice),
        ),
    };
    const payloadHash = idempotencyHash(payloadFingerprint);
    if (input.clientRequestId) {
      const existing = await checkIdempotency(
        tx,
        "purchase.create",
        input.clientRequestId,
        payloadHash,
        { requireStoredHash: true },
      );
      if (existing != null) {
        const [existingOrder] = await tx
          .select({
            poNumber: purchaseOrders.poNumber,
            total: purchaseOrders.total,
            usdTotal: purchaseOrders.usdTotal,
            status: purchaseOrders.status,
          })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, existing))
          .limit(1);
        if (!existingOrder) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعذّر استعادة فاتورة الشراء المحفوظة سابقاً",
          });
        }
        const [shippingRequest] = existingOrder.status === "RECEIVED"
          ? await tx
              .select({ id: receipts.id })
              .from(receipts)
              .where(like(receipts.referenceNumber, `SHIP-${existingOrder.poNumber}-%`))
              .orderBy(desc(receipts.id))
              .limit(1)
          : [];
        const [supplierRequest] = existingOrder.status === "RECEIVED"
          ? await tx
              .select({ id: receipts.id })
              .from(receipts)
              .where(like(receipts.referenceNumber, `PO-PAY-${existingOrder.poNumber}-%`))
              .orderBy(desc(receipts.id))
              .limit(1)
          : [];
        const posting = existingOrder.status === "RECEIVED"
          ? {
              purchaseOrderId: existing,
              fullyReceived: true,
              receivedTotal: existingOrder.total,
              receivedUsd: existingOrder.usdTotal ?? "0.00",
              shippingPaymentRequestReceiptId: shippingRequest ? Number(shippingRequest.id) : null,
              supplierPaymentRequestReceiptId: supplierRequest ? Number(supplierRequest.id) : null,
              idempotentReplay: true as const,
            }
          : null;
        return {
          purchaseOrderId: existing,
          poNumber: existingOrder.poNumber,
          total: existingOrder.total,
          status: existingOrder.status,
          posting,
          idempotent: true as const,
        };
      }
    }

    // نفس قفل الفرع الذي تبدأ به جلسة الجرد: يمنع سباق «التقاط نطاق OPENING ↔ إنشاء قائمة شراء».
    // إن سبق الجردُ، ينظف أمر الشراء العنصر الموجود أدناه؛ وإن سبق الشراءُ، يراه فلتر الجرد بعد القفل.
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, input.branchId))
      .for("update")
      .limit(1);
    if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });

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
    await assertPurchasableVariants(tx, uniqueVariantIds);

    const { rows, subtotal, tax, taxRate, shippingCost, customsCost, total, agreedCurrency, usdTotalVal, agreedRateVal, invoiceDiscountIqd, usdInvoiceDiscountVal } =
      await computePurchaseDocument(tx, input);
    const settlementType = input.settlementType ?? "CREDIT";
    if (agreedCurrency === "USD" && settlementType === "CASH") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "فاتورة المورد الدولارية تُسدَّد من مسار الصيرفة؛ اختر تسوية آجلة لأمر الشراء",
      });
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

    const requestedStatus = input.status ?? "CONFIRMED";
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
      settlementType,
      status: requestedStatus,
      agreedCurrency,
      usdTotal: usdTotalVal ? usdTotalVal.toFixed(2) : null,
      // خصم فاتورة المورّد (0204): إفصاحٌ وإعادةُ تحميلٍ للمحرّر — الأعمدة المالية مخزَّنة صافيةً
      // أصلاً، فلا يدخل هذا الحقل أيّ حساب (وإلّا خُصم مرّتين).
      invoiceDiscount: invoiceDiscountIqd.toFixed(2),
      usdInvoiceDiscount: usdInvoiceDiscountVal ? usdInvoiceDiscountVal.toFixed(2) : null,
      agreedRate: agreedRateVal ? toDbRate(agreedRateVal) : null,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const purchaseOrderId = extractInsertId(insRes);

    for (const r of rows) {
      await tx.insert(purchaseOrderItems).values({ purchaseOrderId, ...r });
    }
    // قائمة الشراء غير الملغاة تخرج الصنف فوراً من أي جرد افتتاحي نشط في الفرع، حتى لو بدأ العد.
    await removeVariantsFromActiveOpeningStocktakes(tx, input.branchId, uniqueVariantIds);
    const posting =
      autoPostConfirmed && requestedStatus === "CONFIRMED"
        ? await postPurchaseInvoiceInTx(tx, purchaseOrderId, actor, ["CONFIRMED"], {
            shippingPaymentMethod: input.shippingPaymentMethod,
            shippingPaymentReference: input.shippingPaymentReference,
            shippingCardLastFour: input.shippingCardLastFour,
            shippingBeneficiarySupplierId: input.shippingBeneficiarySupplierId,
            shippingBeneficiaryName: input.shippingBeneficiaryName,
            shippingEvidenceReference: input.shippingEvidenceReference,
          })
        : null;
    // IDEM-06: سجّل مفتاح الـidempotency — طلب متزامن مكرّر يصطدم بالقيد الفريد فيُلغى (ROLLBACK).
    if (input.clientRequestId)
      await recordIdempotencyKey(tx, "purchase.create", input.clientRequestId, purchaseOrderId, payloadHash);
    return {
      purchaseOrderId,
      poNumber,
      total: total.toFixed(2),
      status: posting ? ("RECEIVED" as const) : requestedStatus,
      posting,
    };
  });
}

/** اعتماد فاتورة شراء: يرحّل كامل المتبقّي إلى المخزون والدفتر في المعاملة نفسها. */
export async function confirmPurchaseOrder(
  purchaseOrderId: number,
  actor: Actor & { role?: string },
  postingDetails: PurchasePostingDetails = {},
) {
  return withTx(async (tx) => {
    const posting = await postPurchaseInvoiceInTx(
      tx,
      purchaseOrderId,
      actor,
      ["DRAFT", "SENT", "CONFIRMED"],
      postingDetails,
    );
    return { purchaseOrderId, status: "RECEIVED" as const, posting };
  });
}

/**
 * تعديل أمر شراء **قبل أيّ أثرٍ ماليّ أو مخزنيّ** — بنفس محرّر الإنشاء وبنفس الحساب.
 *
 * لماذا استبدالٌ كامل للبنود لا تعديلٌ سطراً سطراً: `createPurchaseOrder` لا يكتب قيداً ولا
 * مخزوناً ولا ذمّة — كلّ الأثر في `receivePurchase`. فما دام الأمر لم يُستلَم منه شيء ولا حمل
 * دفعة، فسطوره **مسوّدةٌ خالصة** لا مرجع لها من أيّ جدولٍ آخر، واستبدالها أبسط وأقلّ عرضةً
 * للانجراف من مطابقةٍ سطريّة. الحرّاس أدناه هي ما يضمن بقاءنا في تلك المنطقة الآمنة:
 *
 *   • الحالة ∈ {DRAFT, SENT, CONFIRMED} — المستلَم/الملغى يُعالَج بمرتجع شراء لا بتعديل.
 *   • لا سطر بكمّيةٍ مستلَمة — ولو جزئياً (وإلّا صار للسطر مخزونٌ وقيدٌ يشير إليه).
 *   • لا دفعة مسجَّلة (ديناراً أو دولاراً) — الدفع لا يحدث إلّا مع الاستلام، فوجوده يعني
 *     أنّ الأمر غادر منطقة المسوّدة ولو لم يُعلَم استلامه.
 *
 * القفل بترتيب الإنشاء نفسه (الفرع ← الأمر) فلا دورةَ انتظارٍ مع مسارٍ آخر.
 */
export async function updatePurchaseOrder(input: UpdatePurchaseOrderInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    if (!input.items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء بلا أصناف" });

    const poPreview = (
      await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1)
    )[0];
    if (!poPreview) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(poPreview, actor);

    // نفس قفل الفرع الذي يبدأ به الإنشاء والجرد: يحفظ ترتيب الأقفال (فرع ← أمر) ويمنع سباق
    // «التقاط نطاق OPENING ↔ تعديل قائمة الشراء».
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, Number(poPreview.branchId)))
      .for("update")
      .limit(1);
    if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });

    const po = (
      await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).for("update").limit(1)
    )[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(po, actor);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا تُعدَّل فاتورة شراء معتمدة ومضافة للمخزون أو ملغاة — استعمل مرتجع شراء أو أنشئ فاتورة جديدة",
      });
    }

    const existingItems = await tx
      .select({ variantId: purchaseOrderItems.variantId, receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    if (existingItems.some((i) => (i.receivedBaseQuantity ?? 0) > 0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أُضيفت بضاعة هذه الفاتورة إلى المخزون — لا تُعدّل بعد الاعتماد؛ استعمل مرتجع شراء",
      });
    }
    // دفاع متعمّق: الدفع للمورّد لا يقع إلّا مع الاستلام ⇒ وجودُه يعني أثراً مالياً قائماً.
    if (money(po.paidAmount).gt(0) || money(po.paidUsd ?? "0").gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء عليه دفعة مسجَّلة — لا يمكن تعديله" });
    }

    // بضاعة الأمانة: تبديل المورّد إلى مودِع أمانة يفتح باب ازدواج AP نفسه الذي يحرسه الإنشاء.
    const [sup] = await tx.select({ kind: suppliers.supplierKind }).from(suppliers)
      .where(eq(suppliers.id, input.supplierId)).limit(1);
    if (!sup) throw new TRPCError({ code: "BAD_REQUEST", message: "المورّد غير موجود" });
    if (sup.kind === "CONSIGNOR")
      throw new TRPCError({ code: "BAD_REQUEST", message: "هذا مودِع أمانة — تُستلم بضاعته بسند إيداع من تبويب سندات الأمانة، لا بأمر شراء" });

    const nextVariantIds = Array.from(new Set(input.items.map((it) => it.variantId)));
    await assertPurchasableVariants(tx, nextVariantIds);

    const { rows, subtotal, tax, taxRate, shippingCost, customsCost, total, agreedCurrency, usdTotalVal, agreedRateVal, invoiceDiscountIqd, usdInvoiceDiscountVal } =
      await computePurchaseDocument(tx, input);

    await tx.update(purchaseOrders).set({
      supplierId: input.supplierId,
      subtotal: subtotal.toFixed(2),
      taxAmount: tax.toFixed(2),
      taxRatePercent: taxRate.toFixed(2),
      shippingCost: shippingCost.toFixed(2),
      customsCost: customsCost.toFixed(2),
      total: total.toFixed(2),
      // الحالة تبقى كما هي: التعديل ليس اعتماداً ولا سحباً للاعتماد (لكلٍّ إجراؤه).
      agreedCurrency,
      usdTotal: usdTotalVal ? usdTotalVal.toFixed(2) : null,
      // خصم فاتورة المورّد (0204): إفصاحٌ وإعادةُ تحميلٍ للمحرّر — الأعمدة المالية مخزَّنة صافيةً
      // أصلاً، فلا يدخل هذا الحقل أيّ حساب (وإلّا خُصم مرّتين).
      invoiceDiscount: invoiceDiscountIqd.toFixed(2),
      usdInvoiceDiscount: usdInvoiceDiscountVal ? usdInvoiceDiscountVal.toFixed(2) : null,
      agreedRate: agreedRateVal ? toDbRate(agreedRateVal) : null,
      notes: input.notes ?? null,
    }).where(eq(purchaseOrders.id, input.purchaseOrderId));

    await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    for (const r of rows) {
      await tx.insert(purchaseOrderItems).values({ purchaseOrderId: input.purchaseOrderId, ...r });
    }

    // أهليّة الجرد الافتتاحيّ تتبع البنود لا الأمر: صنفٌ حُذف من الأمر يعود مؤهَّلاً للعدّ، وصنفٌ
    // أُضيف يخرج منه فوراً. الترتيب (استرجاعٌ ثمّ إخراج) يمنع إعادةَ إدخال صنفٍ باقٍ في الطرفين.
    const previousVariantIds = Array.from(new Set(existingItems.map((i) => Number(i.variantId))));
    const nextVariantSet = new Set(nextVariantIds);
    const droppedVariantIds = previousVariantIds.filter((id) => !nextVariantSet.has(id));
    if (droppedVariantIds.length) {
      await restoreVariantsToActiveOpeningStocktakes(tx, Number(po.branchId), droppedVariantIds);
    }
    await removeVariantsFromActiveOpeningStocktakes(tx, Number(po.branchId), nextVariantIds);

    return {
      purchaseOrderId: input.purchaseOrderId,
      poNumber: po.poNumber,
      total: total.toFixed(2),
      status: po.status,
    };
  });
}

/**
 * إلغاء أمر شراء لم يُستلم منه شيء — قلب حالة خالص (createPurchaseOrder لا يكتب
 * أي قيد دفتر/AP/مخزون/إيصال؛ كل التأثيرات المالية والمخزنية تحدث في receivePurchase فقط).
 * أمرٌ استُلمت منه بضاعة يُعالَج بمرتجع شراء لا بالإلغاء.
 */
export async function cancelPurchaseOrder(purchaseOrderId: number, actor: Actor & { role?: string }) {
  // Resolve the immutable branch before opening the transaction. A normal read
  // inside a MySQL REPEATABLE READ transaction would freeze a snapshot *before*
  // waiting on the branch lock and could miss a concurrently committed second
  // purchase order. The transactional first read below is therefore the branch
  // locking read, and all later eligibility reads observe everything committed
  // before that lock was acquired.
  const initialPo = (
    await requireDb().select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).limit(1)
  )[0];
  if (!initialPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
  assertPurchaseBranch(initialPo, actor);

  return withTx(async (tx) => {
    const branch = (
      await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, initialPo.branchId))
        .for("update")
        .limit(1)
    )[0];
    if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "الفرع غير موجود" });

    const po = (
      await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).for("update").limit(1)
    )[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(po, actor);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فاتورة الشراء معتمدة ومضافة للمخزون أو ملغاة" });
    }

    const items = await tx
      .select({
        variantId: purchaseOrderItems.variantId,
        receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity,
      })
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
    await restoreVariantsToActiveOpeningStocktakes(
      tx,
      Number(po.branchId),
      items.map((item) => Number(item.variantId)),
    );
    return { purchaseOrderId, status: "CANCELLED" as const };
  });
}
