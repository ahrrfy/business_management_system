// إنشاء فاتورة بيع ذرّياً: idempotency + تسعير/تحويل الأسطر + بوّابة أقل-من-التكلفة +
// تقريب نقدي IQD + حدّ الائتمان + خصم المخزون + قيد SALE + الدفعة/الذمم.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { couponRedemptions, coupons, customers, invoiceItemBundleComponents, invoiceItems, invoices, openingModeSettings, productVariants, products, receipts, shifts } from "../../../drizzle/schema";
import {
  computeInvoiceCost,
  computeInvoiceTotals,
  computeLineTotal,
  isInvoiceBelowCost,
  snapshotUnitCost,
} from "../billing";
import { assertCreditLimit } from "../../lib/credit";
import { extractInsertId } from "../../lib/insertId";
import { consumeApproval, validateApproval } from "../creditApprovalService";
import {
  classifyVariants,
  computeBundleUnitCosts,
  getBundleDefinitions,
  type VariantKind,
} from "../bundleService";
import { applyMovement, convertToBaseQuantity } from "../inventoryService";
import { resolveContractPrices } from "../contractPriceService";
import {
  getProductCategoryIds,
  resolveCouponPromotionForLine,
  resolvePromotionForLine,
  type ResolvedPromotion,
} from "../salesPromotionService";
import { consumeCoupon, hashCouponCode, lockCouponForSale } from "../couponService";
import { adjustCustomerBalance, adjustSupplierBalance, computeInvoiceStatus, postEntry } from "../ledgerService";
import { money, round2, roundCashIQD, toDbMoney } from "../money";
import { nextInvoiceNumber } from "../numbering";
import { getUnitPrice, resolveTier, type PriceTier } from "../pricing";
import { type Actor, withTx } from "../tx";
import type { CreateSaleInput, CreateSaleResult } from "./types";

export async function createSale(input: CreateSaleInput, actor: Actor): Promise<CreateSaleResult> {
  return withTx(async (tx) => {
    // 1. Idempotency: replay the existing invoice for a repeated clientRequestId.
    //    SALES-04 (تدقيق ٢٣/٦/٢٦): البصمة كانت قاصرة على branchId ⇒ كاشير يُعيد استعمال المفتاح
    //    على بيع مختلف فيستلم فاتورة بيعٍ سابق ولا يُسجَّل البيع الجديد ⇒ منفذ سرقة نقد. الحلّ على
    //    نمط processPayment/voucherService: نتحقّق من (branch, customer, payment.method, عدد الأسطر)
    //    قبل إرجاع الفاتورة القديمة، وإلا CONFLICT صريح يُظهر للمستخدم أن المفتاح يخصّ بيعاً مغايراً.
    if (input.clientRequestId) {
      const existing = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1);
      if (existing[0]) {
        const ex = existing[0];
        // SALES-03: عزل الفرع — مفتاح idempotency يخصّ بيع فرع آخر لا يُكشَف للمستخدم (تعارض، لا تسريب فاتورة).
        if (Number(ex.branchId) !== input.branchId) {
          throw new TRPCError({ code: "CONFLICT", message: "مفتاح idempotency مستعمَل لبيع فرع آخر" });
        }
        const requestedCustomerId = input.customerId ?? null;
        const storedCustomerId = ex.customerId != null ? Number(ex.customerId) : null;
        if (storedCustomerId !== requestedCustomerId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع عميل مختلف",
          });
        }
        const requestedMethod = input.payment?.method ?? null;
        if ((ex.paymentMethod ?? null) !== requestedMethod) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع بطريقة دفع مختلفة",
          });
        }
        // SALES-04b (تدقيق ٢/٧): البصمة كانت تقارن «عدد» الأسطر فقط ⇒ بيع مختلف بنفس عدد الأصناف
        // يُصادَر بفاتورة قديمة بصمت (منفذ سرقة نقد: النقد يُقبض ولا يُسجَّل). الآن نقارن **محتوى**
        // الأسطر (الصنف + الوحدة + الكمية) كمجموعة مرتّبة. لا نقارن السعر/الخصم عمداً كي لا نُطلق
        // تعارضاً زائفاً عند إعادة محاولة نفس البيع بعد تغيّر تسعيرة — الصنف+الوحدة+الكمية بصمة كافية.
        const existingItems = await tx
          .select({
            variantId: invoiceItems.variantId,
            productUnitId: invoiceItems.productUnitId,
            quantity: invoiceItems.quantity,
          })
          .from(invoiceItems)
          .where(eq(invoiceItems.invoiceId, ex.id));
        const lineKey = (variantId: number | null, unitId: number | null, quantity: string) =>
          `${Number(variantId)}:${unitId == null ? "" : Number(unitId)}:${money(quantity).toFixed(3)}`;
        const existingKeys = existingItems
          .map((i) => lineKey(Number(i.variantId), i.productUnitId == null ? null : Number(i.productUnitId), i.quantity))
          .sort();
        const requestedKeys = input.lines
          .map((l) => lineKey(l.variantId, l.productUnitId, l.quantity))
          .sort();
        if (existingKeys.length !== requestedKeys.length) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع بعدد أصناف مختلف",
          });
        }
        if (existingKeys.some((k, i) => k !== requestedKeys[i])) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لبيع بأصناف أو كميات مختلفة",
          });
        }
        // الكوبون جزء من بصمة البيع: لا يجوز لمفتاح إعادة المحاولة نفسه تبديل الكوبون أو إسقاطه.
        const redemption = (await tx.select({ codeHash: coupons.codeHash })
          .from(couponRedemptions)
          .innerJoin(coupons, eq(couponRedemptions.couponId, coupons.id))
          .where(eq(couponRedemptions.invoiceId, ex.id))
          .limit(1))[0];
        const requestedCouponHash = input.couponCode ? hashCouponCode(input.couponCode) : null;
        if ((redemption?.codeHash ?? null) !== requestedCouponHash) {
          throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: الكوبون مختلف عن البيع الأصلي" });
        }
        return {
          invoiceId: Number(ex.id),
          invoiceNumber: ex.invoiceNumber,
          total: ex.total,
          status: ex.status as CreateSaleResult["status"],
          idempotentReplay: true,
        };
      }
    }

    if (!input.lines.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء فاتورة بلا أصناف" });
    }

    // 2. Shift must be OPEN and belong to the branch (when provided — POS).
    //    .for("update") يُسَلْسِل البيع مع closeShift على نفس الصفّ ⇒ إمّا يقفل البيع قبل
    //    الإغلاق ويُحتسَب، أو يُرفض إن سبق الإغلاق فلا يدخل receipt بعد قطع الـZ-report.
    const isCashPayment = input.payment?.method === "CASH" && money(input.payment?.amount ?? "0").gt(0);
    if (isCashPayment && (input.shiftId == null)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "يَلزم وردية مفتوحة للبيع النقدي",
      });
    }
    if (input.shiftId) {
      const s = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1);
      if (!s[0] || Number(s[0].branchId) !== input.branchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية غير مفتوحة أو لا تخص هذا الفرع" });
      }
      if (s[0].status !== "OPEN") {
        // أوفلاين (ش٤): بيع التُقط دون اتصال **قبل** إغلاق الوردية ووصل ترحيله بعده ⇒ يُقبل
        // في وردية مغلقة (النقد كان فعلياً في الدرج عند العدّ — الرفض يترك نقداً بلا فاتورة).
        // يُميَّز في Z-report بقسم «مبيعات مُزامنة لاحقاً» (invoices.createdAt > closedAt +
        // originatedOffline). سماحية ٥ دقائق لانحراف ساعة الجهاز. ما التُقط بعد الإغلاق يُرفض
        // (واجهة POS لا تبيع بلا وردية مفتوحة — التقاطٌ كهذا شذوذ يستحق مراجعة لا ترحيلاً).
        const closedAtMs = s[0].closedAt ? new Date(s[0].closedAt).getTime() : null;
        const lateSyncOk =
          !!input.offlineCapture &&
          closedAtMs != null &&
          input.offlineCapture.capturedAt.getTime() <= closedAtMs + 5 * 60_000;
        if (!lateSyncOk) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية غير مفتوحة أو لا تخص هذا الفرع" });
        }
      }
      // SHIFT-OWN (تدقيق ٢/٧): فرض ملكية الوردية — كما في processPayment. غياب هذا الفحص كان
      // يُتيح لكاشير تمرير shiftId لوردية زميلٍ في نفس الفرع فيُنسَب نقده لدرج الزميل (عجز مزوّر عند
      // إغلاق الضحية + غطاء اختلاس). المدير/الأدمن معفيان (يسجّلون على أي وردية للتسوية).
      const role = actor.role;
      if (role !== "admin" && role !== "manager" && Number(s[0].userId) !== Number(actor.userId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تَستطيع التسجيل على وردية مستخدم آخر" });
      }
    }

    // 3. Resolve the effective price tier.
    let customerTier: PriceTier | null = null;
    if (input.customerId) {
      // قفل صفّ العميل: يُسلسِل البيوع الآجلة المتزامنة فلا يتجاوز اثنان حدّ الائتمان معاً.
      const c = await tx.select().from(customers).where(eq(customers.id, input.customerId)).for("update").limit(1);
      if (!c[0]) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      customerTier = c[0].defaultPriceTier as PriceTier;
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier });

    // يوم بغداد هو مرجع صلاحية العرض والكوبون معاً؛ يُحسَب مرة واحدة داخل المعاملة.
    const _now = new Date();
    const _bag = new Date(_now.getTime() + 3 * 60 * 60 * 1000);
    const todayYmd = _bag.toISOString().slice(0, 10);
    const lockedCoupon = input.couponCode
      ? await lockCouponForSale(tx, { code: input.couponCode, branchId: input.branchId, customerId: input.customerId ?? null, todayYmd })
      : null;

    // 4. Price/cost/convert each line.
    // D1 (٣٠/٦): حلّ N+1 — قراءة كل المتغيّرات بـinArray دفعةً واحدةً قبل الحلقة بدل
    // round-trip لكل سطر. لا قفل (.for("update")) هنا (نقرأ تكلفة + isActive فقط — متغيّرات
    // الأسعار/التفعيل لا تتعارض مع البيع؛ الأقفال الفعليّة للمخزون لاحقاً عبر applyMovement).
    // قبل: ٢٠ سطر = ٢٠ استعلاماً متسلسلاً. بعد: استعلام واحد ⇒ زمن المعاملة ينخفض دراماتيكياً
    // ونافذة الأقفال على shifts/customers تَنكمش (انكماش هذه النافذة = أقلّ تنافس عند الذروة).
    const uniqueVariantIds = Array.from(new Set(input.lines.map((l) => l.variantId)));
    const variantRows = await tx
      .select({
        id: productVariants.id,
        costPrice: productVariants.costPrice,
        isActive: productVariants.isActive,
      })
      .from(productVariants)
      .where(inArray(productVariants.id, uniqueVariantIds));
    const variantById = new Map<number, { costPrice: string; isActive: boolean | null }>();
    for (const r of variantRows) {
      variantById.set(Number(r.id), { costPrice: String(r.costPrice), isActive: r.isActive });
    }
    // بضاعة الأمانة (ش٣): خريطة variantId → consignorId للأصناف الموسومة أمانةً — لالتقاط التزام المودِع
    // لحظة البيع (قيد PURCHASE يتيم) ولاستثنائها من البيع بالسالب في المسار الحيّ. راجع design §٢-ب/§٥-ج.
    const consignByVariant = new Map<number, number>();
    {
      const crows = await tx
        .select({ vid: productVariants.id, isConsign: products.isConsignment, cId: products.consignorId })
        .from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, uniqueVariantIds));
      for (const r of crows) if (r.isConsign && r.cId != null) consignByVariant.set(Number(r.vid), Number(r.cId));
    }

    // بند 12ب (٧/٧): الأسعار التعاقدية النشطة للعميل — استعلام واحد (نمط D1 نفسه، لا N+1).
    // أسبقية اختيار السعر تتبع البنية القائمة حرفياً: override صريح (سعرٌ قصده المستخدم ويعرضه
    // للزبون — POS يثبّته دائماً، وحارس أقل-من-التكلفة يحكمه) ← السعر التعاقدي ← سعر الفئة.
    // نفس `resolveContractPrices` تغذّي عرض POS في catalog/pos.ts ⇒ نقطة العرض = نقطة الفرض.
    const contractPrices = input.customerId
      ? await resolveContractPrices(tx, input.customerId, input.lines.map((l) => l.productUnitId))
      : new Map<number, string>();

    // bundles (٧/٧/٢٦): تصنيف المتغيّرات لتوجيه منطق التكلفة والمخزون. متغيّر BUNDLE:
    //   * تُحسب unitCost = Σ(componentCost × componentBaseQty) بدلاً من snapshotUnitCost(v.costPrice).
    //   * لا يُطبَّق applyMovement على المتغيّر نفسه (لا branchStock له) — يُطبَّق على مكوّناته لاحقاً.
    // القراءات دفعةً واحدة (لا N+1).
    const kindByVariant: Map<number, VariantKind> = await classifyVariants(tx, uniqueVariantIds);
    const bundleVariantIds = uniqueVariantIds.filter((vid) => kindByVariant.get(vid) === "BUNDLE");
    const bundleDefs = await getBundleDefinitions(tx, bundleVariantIds);
    const bundleUnitCosts = await computeBundleUnitCosts(tx, bundleVariantIds, bundleDefs);
    // حارس صحّة: كل بكجٍ ورد كسطر بيع يجب أن يملك وصفة (على الأقل مكوّناً واحداً) — منتج بلا وصفة
    // مسجَّل isBundle=true بحادثة سيّئة (ملفَّق يدوياً أو حالة سباق). نرفض البيع صراحةً بدل حساب صفر.
    for (const bid of bundleVariantIds) {
      const list = bundleDefs.get(bid);
      if (!list || !list.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `البكج (متغيّر ${bid}) بلا مكوّنات — أضف مكوّناته قبل البيع`,
        });
      }
    }
    // Codex #163 P2 (Block bundles whose components were later disabled): إن عُطِّل مكوّن بعد إنشاء
    // البكج، البكج يبقى قابلاً للبيع بلا فحصٍ لحيويّة مكوّناته ⇒ يخصم مكوّناً معطَّلاً (يخالف B2 من
    // bundleService لكنّه لا يفرضه في مسار البيع). الآن نلتقط كل مكوّنات البكجات المُباعة دفعةً واحدة
    // ونرفض البيع لو أيٌّ منها معطَّل (منتج أو متغيّر).
    if (bundleVariantIds.length) {
      const allComponentIds = new Set<number>();
      for (const bid of bundleVariantIds) {
        for (const c of bundleDefs.get(bid) ?? []) allComponentIds.add(c.componentVariantId);
      }
      if (allComponentIds.size) {
        const componentRows = await tx
          .select({
            id: productVariants.id,
            variantActive: productVariants.isActive,
            productActive: products.isActive,
            productName: products.name,
            sku: productVariants.sku,
          })
          .from(productVariants)
          .innerJoin(products, eq(productVariants.productId, products.id))
          .where(inArray(productVariants.id, Array.from(allComponentIds)));
        for (const cr of componentRows) {
          if (cr.variantActive === false || cr.productActive === false) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `مكوّن بكج معطَّل: «${cr.productName} — ${cr.sku}» — فعّله أو استبدله قبل البيع`,
            });
          }
        }
      }
    }

    // promotions v2: خرائط لتحقّق العرض بلا N+1.
    const productIdByVariant = new Map<number, number>();
    for (const r of variantRows) {
      productIdByVariant.set(Number(r.id), 0); // سيُملأ لاحقاً
    }
    // نحتاج productId لكل متغيّر. نستعمل استعلام إضافي واحد.
    let categoryByProduct = new Map<number, number | null>();
    const linesNeedingPromo = input.lines.filter((l) => l.promotionId != null);
    if (linesNeedingPromo.length) {
      const productRows = await tx
        .select({ variantId: productVariants.id, productId: productVariants.productId })
        .from(productVariants)
        .where(inArray(productVariants.id, Array.from(new Set(linesNeedingPromo.map((l) => l.variantId)))));
      for (const pr of productRows) productIdByVariant.set(Number(pr.variantId), Number(pr.productId));
      const productIds = Array.from(new Set(productRows.map((r) => Number(r.productId))));
      categoryByProduct = await getProductCategoryIds(tx, productIds);
    }
    const computed = [];
    for (const l of input.lines) {
      const v = variantById.get(l.variantId);
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${l.variantId} غير موجود` });
      if (v.isActive === false) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `المتغيّر ${l.variantId} معطّل` });
      }

      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId);
      const contractPrice = contractPrices.get(l.productUnitId);
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : contractPrice != null
            ? money(contractPrice)
            : await getUnitPrice(tx, l.productUnitId, tier);
      // bundles: تكلفة البكج محسوبة لحظياً من مجموع مكوّناته (لا `productVariants.costPrice`
      // لأن البكج نفسه بلا WAVG — تكلفته صافي مجموع مكوّناته الحيّ لحظة البيع، قرار مالك ٧/٧).
      const kind = kindByVariant.get(l.variantId) ?? "STOCKED";
      const unitCost = kind === "BUNDLE"
        ? snapshotUnitCost(bundleUnitCosts.get(l.variantId) ?? "0")
        : snapshotUnitCost(v.costPrice);
      const lineRes = computeLineTotal({
        unitPrice,
        quantity: money(l.quantity),
        discountPercent: l.discountPercent,
        discountAmount: l.discountAmount,
      });

      // promotions v2 (idempotent verification): إن مرّر POS `promotionId`، نُعيد الحلّ خادمياً
      // ونتحقّق أن `expectedPromoDiscount = discountForUnit × qty` يتّسق مع `discountAmount` (± 1 IQD).
      // إن اتّسق ⇒ نخزّن promotionId + promotionDiscount على invoiceItem. إن اختلف (تغيّر العرض بين
      // العرض والحفظ) ⇒ نعامل الخصم كيدوي بلا رفض — يحمي البيع من فشل بسبب تعديل عرض بين وقتين.
      let recordedPromotionId: number | null = null;
      let recordedPromoDiscount = "0.00";
      if (l.promotionId != null && kind !== "BUNDLE") {
        const productId = productIdByVariant.get(l.variantId);
        if (productId != null && productId > 0) {
          const categoryId = categoryByProduct.get(productId) ?? null;
          const resolveInput = {
            branchId: input.branchId,
            customerTier: tier,
            productId,
            variantId: l.variantId,
            categoryId,
            unitPrice: unitPrice.toFixed(2),
            lineAmount: unitPrice.mul(money(l.quantity)).toFixed(2),
            hasContractPrice: contractPrice != null,
            todayYmd,
          };
          const isCouponPromotion = !!lockedCoupon && Number(l.promotionId) === lockedCoupon.promotionId;
          const resolved: ResolvedPromotion | null = isCouponPromotion
            ? await resolveCouponPromotionForLine(tx, lockedCoupon.promotionId, resolveInput)
            : await resolvePromotionForLine(tx, resolveInput);
          if (resolved && Number(resolved.promotionId) === Number(l.promotionId)) {
            const expected = money(resolved.discountForUnit).mul(money(l.quantity));
            const actual = money(lineRes.discountAmount);
            // IQD في POS يُعرض كعدد صحيح لكل وحدة. فرق التقريب المشروع أقصاه دينار واحد لكل وحدة؛
            // للكوبون نسجل الخصم المعروض فعلياً (كي يطابق الإجمالي المقبوض)، وللتلقائي نبقي السلوك القديم.
            const tolerance = isCouponPromotion ? money(l.quantity) : money(1);
            if (actual.minus(expected).abs().lte(tolerance)) {
              recordedPromotionId = Number(l.promotionId);
              recordedPromoDiscount = isCouponPromotion ? actual.toFixed(2) : expected.toFixed(2);
            }
          }
        }
      }

      computed.push({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        baseQuantity,
        unitPrice: lineRes.unitPrice,
        unitCost,
        quantity: lineRes.quantity,
        discountAmount: lineRes.discountAmount,
        total: lineRes.total,
        kind,
        promotionId: recordedPromotionId,
        promotionDiscount: recordedPromoDiscount,
      });
    }

    const couponDiscount = lockedCoupon
      ? computed
          .filter((line) => line.promotionId === lockedCoupon.promotionId)
          .reduce((sum, line) => sum.plus(money(line.promotionDiscount)), money(0))
      : money(0);
    if (lockedCoupon && couponDiscount.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون صالح لكنه لا ينطبق على أصناف الفاتورة" });
    }

    // 5. Deterministic lock order: sort by variantId ascending.
    computed.sort((a, b) => a.variantId - b.variantId);

    // 6. Totals + COGS.
    const totals = computeInvoiceTotals({
      lineTotals: computed.map((c) => c.total),
      invoiceDiscount: input.invoiceDiscount,
      taxRatePercent: input.taxRatePercent,
      deliveryFee: input.deliveryFee,
    });
    const costTotal = computeInvoiceCost(
      computed.map((c) => ({ unitCost: c.unitCost, baseQuantity: c.baseQuantity }))
    );

    // 6.b SALES-01/02 — بوّابة البيع بأقل من التكلفة (سدّ حرج: كاشير يبيع بسعر/خصم صفر).
    //     المنطق مشترك في billing.isInvoiceBelowCost ⇒ لا تَنجرف سياسة POS عن قناة الطباعة.
    //     أيُّ بند/فاتورة تحت COGS يَلزمه موافقة مدير (الراوتر يَمنح المدير/الأدمن السلطة ذاتياً)؛
    //     الهدايا (تكلفة=صفر) تَبقى مسموحة.
    const belowCost = isInvoiceBelowCost(computed, totals.subtotal, totals.discountAmount, costTotal);
    if (belowCost && !input.priceOverrideApproved) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "بيع بأقل من التكلفة يتطلب موافقة مدير (سعر أو خصم تحت التكلفة).",
      });
    }

    // 7. تقريب نقدي IQD للبيع النقدي الكامل: يُقرَّب الإجمالي لفئة 250، فالنقد المستلم = الإجمالي المقرّب
    //    (لا فائض/عجز وهمي عند الرفع، ولا رفض بيع نقدي عند الخفض). الفرق يُسجَّل قيد ADJUST لاحقاً.
    const roundCash = !!input.cashRoundIQD && input.payment?.method === "CASH";
    const grandTotalD = money(totals.total);
    const effectiveTotalD = roundCash ? roundCashIQD(grandTotalD) : grandTotalD;
    const cashRoundingAdj = effectiveTotalD.minus(grandTotalD); // ± (صفر إن لا تقريب)
    const tendered = money(input.payment?.amount ?? "0");
    // SALES-05 (تدقيق ٢/٧): كان paidNow يُفرَض = الإجمالي المقرّب عند roundCash متجاهلاً المبلغ
    // المُسلَّم ⇒ بيع آجل جزئي بعلم cashRoundIQD=true يُسجَّل «مدفوعاً بالكامل» فتُمحى ذمة العميل
    // (والنقد الوهمي يظهر عجزاً بدرج الكاشير). الآن: التقريب يطبَّق على الإجمالي دائماً، لكن نعامل
    // البيع كمدفوعٍ بالكامل (paidNow = الإجمالي المقرّب) فقط إذا كان المُسلَّم يغطّي الإجمالي فعلاً؛
    // وإلا فهي دفعة جزئية ⇒ paidNow = المُسلَّم بالضبط والباقي ذمّة على العميل.
    const paidNow = roundCash && tendered.gte(grandTotalD) ? effectiveTotalD : tendered;
    const unpaid = effectiveTotalD.minus(paidNow);
    if (unpaid.gt(0) && !input.customerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "البيع الآجل يتطلب عميلاً محدداً" });
    }
    // 7.b فحص حدّ الائتمان (H4): null=بلا حدّ، 0=حظر آجل، >0=فحص الإسقاط.
    //     B5 (١٩/٦/٢٦): الموافقة لم تعد blanket — تحتاج إمّا (أ) creditApprovalId جاهز، أو (ب) managerOverrideByUserId
    //     يكون الـrouter قد وثّق هويته. الخدمة في حالة (ب) تُنشئ approval ذرّياً داخل نفس withTx.
    let effectiveApprovalId = input.creditApprovalId;
    if (unpaid.gt(0) && input.customerId) {
      if (input.creditApproved) {
        if (!input.creditApprovalId && !input.managerOverrideByUserId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "تجاوز السقف يحتاج موافقة مُسجَّلة (creditApprovalId) أو هوية مدير مُتحقَّق منها — لا تُقبل موافقة بلا سقف.",
          });
        }
        if (!effectiveApprovalId && input.managerOverrideByUserId) {
          // تَنشئ Approval تلقائياً، مرتبطة بهذا العميل + سقف=unpaid (تماماً)، single-use.
          const created = await (await import("../creditApprovalService")).createApproval(tx, {
            customerId: input.customerId,
            maxAmount: unpaid.toFixed(2),
            approvedBy: input.managerOverrideByUserId,
            ttlMinutes: 5,
            notes: "manager-verified override via sale router (auto-generated)",
          });
          effectiveApprovalId = created.id;
        }
        // SELECT FOR UPDATE داخل validateApproval ⇒ لا double-spend عبر سباق.
        await validateApproval(tx, effectiveApprovalId!, input.customerId, unpaid);
      } else {
        await assertCreditLimit(tx, input.customerId, unpaid, input.branchId);
      }
    }

    // 8. Invoice header.
    const invoiceNumber = await nextInvoiceNumber(tx, input.branchId);
    const status = computeInvoiceStatus(toDbMoney(effectiveTotalD), toDbMoney(paidNow));
    const insRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: input.sourceType,
      // TX-01: clientRequestId فارغ ("") يُخزَّن null لا "" — وإلا اصطدم على uq_invoice_source وحجب
      // كل بيعٍ لاحق بلا مفتاح. (|| يَلتقط "" بخلاف ?? الذي يُمرّره.)
      sourceId: input.clientRequestId || null,
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      customerId: input.customerId ?? null,
      priceTier: tier,
      // dueDate يُحفظ كـDate إن وُرد، وإلا null. يستعمله AR aging والتنبيهات.
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      discountAmount: totals.discountAmount,
      total: toDbMoney(effectiveTotalD),
      costTotal,
      cashRoundingAdjustment: toDbMoney(cashRoundingAdj),
      // أجرة الشحن كإيراد (مُضمَّنة في total ومُعترَف بها في revenue أدناه) — تُخزَّن صراحةً ليعكسها
      // المرتجع الكامل بدقّة (returnService) فيبقى Σ(revenue)=Σ(profit)=0.
      deliveryFee: toDbMoney(round2(money(input.deliveryFee ?? "0"))),
      status,
      paidAmount: toDbMoney(paidNow),
      paymentMethod: input.payment?.method ?? null,
      paymentDate: paidNow.gt(0) ? new Date() : null,
      notes: input.notes ?? null,
      // أوفلاين (ش٣): وسم المنشأ + الرقم المؤقّت المطبوع + لحظة الالتقاط الحقيقية —
      // يضبطها offline.replaySale حصراً (saleRouter لا يعرض offlineCapture).
      originatedOffline: !!input.offlineCapture,
      offlineReceiptNumber: input.offlineCapture?.offlineReceiptNumber ?? null,
      capturedAt: input.offlineCapture?.capturedAt ?? null,
      createdBy: actor.userId,
    });
    const invoiceId = extractInsertId(insRes);

    // B5: استهلاك الموافقة (يربطها بالفاتورة الفعلية بعد إنشائها — single-use).
    if (effectiveApprovalId) {
      await consumeApproval(tx, effectiveApprovalId, invoiceId);
    }

    // 9. Items.
    for (const c of computed) {
      const itemInsRes = await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitPrice: c.unitPrice,
        unitCost: c.unitCost,
        discountAmount: c.discountAmount,
        total: c.total,
        // promotions v2: الأثر متجمّد على المستند — تعديل عرضٍ لاحقاً لا يمسّ سجلّ فواتير سابقة.
        promotionId: c.promotionId,
        promotionDiscount: c.promotionDiscount,
      });
      // gstack B6: لقطة مكوّنات البكج لحظة البيع. المرتجع يقرأ منها حصراً بدل الوصفة الحيّة —
      // يحمي من انحراف مخزون صامت لو عُدّلت الوصفة بين البيع والإرجاع.
      if (c.kind === "BUNDLE") {
        const invoiceItemId = extractInsertId(itemInsRes);
        const def = bundleDefs.get(c.variantId) ?? [];
        for (const bc of def) {
          await tx.insert(invoiceItemBundleComponents).values({
            invoiceItemId,
            componentVariantId: bc.componentVariantId,
            componentBaseQuantity: bc.componentBaseQuantity,
          });
        }
      }
    }

    // الاسترداد جزء من نفس المعاملة: فشل أي قيد/مخزون لاحق يعيد الكوبون كما كان تلقائياً.
    if (lockedCoupon) {
      await consumeCoupon(tx, lockedCoupon, {
        invoiceId,
        customerId: input.customerId ?? null,
        branchId: input.branchId,
        discountAmount: couponDiscount.toFixed(2),
        userId: actor.userId,
      });
    }

    // 10. Deduct stock (OUT) per line.
    //     bundles (٧/٧/٢٦): البكج لا يملك branchStock — نتخطّاه لصالح **مكوّناته**. نبني قائمة العمليات
    //     المخزنيّة الفعلية أوّلاً ثم نجمّعها بالمتغيّر (بكجان يتشاركان مكوّناً ⇒ حركة واحدة مجمَّعة)
    //     ثم نطبّقها بترتيب variantId التصاعدي — يحافظ على ترتيب القفل الحتميّ (بند 5 أعلاه).
    //     ⚠️ نفس الترتيب مهم للسلامة تحت التزامن: تجميع قبل التطبيق يمنع سباق قفل على نفس الصفّ.
    interface StockOp { variantId: number; baseQuantity: number; }
    const stockOps: StockOp[] = [];
    for (const c of computed) {
      if (c.kind === "BUNDLE") {
        const def = bundleDefs.get(c.variantId) ?? [];
        // في هذه النقطة تحقّقنا سابقاً أن الوصفة غير فارغة (حارس PRECONDITION أعلاه).
        for (const comp of def) {
          stockOps.push({
            variantId: comp.componentVariantId,
            baseQuantity: comp.componentBaseQuantity * c.baseQuantity,
          });
        }
      } else {
        // STOCKED / SERVICE — applyMovement تعرف كيف تتعامل مع الخدمة (لا branchStock).
        stockOps.push({ variantId: c.variantId, baseQuantity: c.baseQuantity });
      }
    }
    // تجميع بحسب variantId (لتحاشي حركتين على نفس الصنف من بكجين مختلفين — كذلك سطر بكج + سطر مفرد
    // من نفس الصنف يُجمعان في قفلٍ واحد). حساب decimal-free (كل الكميّات صحيحة موجبة).
    const aggregated = new Map<number, number>();
    for (const op of stockOps) {
      aggregated.set(op.variantId, (aggregated.get(op.variantId) ?? 0) + op.baseQuantity);
    }
    const sortedVariantIds = Array.from(aggregated.keys()).sort((a, b) => a - b);

    // «وضع الافتتاح» (ش٢ ١٩/٧): بيعٌ نقدي كامل من قناة POS يُسمح له بالنزول تحت الصفر للصنف
    // **غير المُفتتَح** (openedAt IS NULL — يُفحص داخل applyMovement تحت القفل) حتى يُجرَد افتتاحياً.
    // شرطا الأمان الصنفيان (مراجعة عدائية ١٨/٧): تكلفة مُدخلة (>0) — سالبٌ بلا COGS = تسريب غير
    // قابل للكشف — وسقف كمية للسطر يصدّ خطأ الإدخال والاحتيال. قناة الأوفلاين (allowNegativeStock)
    // مستقلة تماماً ولا تتراكب. القراءة كسولة: البيع العادي المكتفي المخزون لا يدفع أي استعلام إضافي.
    const openingBaseEligible =
      !input.allowNegativeStock &&
      (input.sourceType ?? "POS") === "POS" &&
      input.payment?.method === "CASH" &&
      unpaid.lte(0);
    const readOpeningWindow = async () => {
      const om = (await tx.select().from(openingModeSettings).where(eq(openingModeSettings.id, 1)).limit(1))[0];
      return om?.enabled && om.endsAt != null && om.endsAt.getTime() > Date.now()
        ? { maxQty: om.maxNegativeQtyPerLine }
        : null;
    };
    let openingWindow: { maxQty: number } | null = null;
    const deductCosts = new Map<number, string>();
    if (openingBaseEligible) {
      openingWindow = await readOpeningWindow();
      if (openingWindow && sortedVariantIds.length) {
        // تكاليف الأصناف المخصومة فعلياً (مكوّنات البكج لا البكج نفسه).
        const costRows = await tx
          .select({ id: productVariants.id, cost: productVariants.costPrice })
          .from(productVariants)
          .where(inArray(productVariants.id, sortedVariantIds));
        for (const r of costRows) deductCosts.set(Number(r.id), String(r.cost ?? "0"));
      }
    }
    const negativeDips: { variantId: number; newQuantity: number }[] = [];

    for (const vid of sortedVariantIds) {
      const qty = aggregated.get(vid)!;
      if (qty <= 0) continue; // احترازي — تجميع كميّات صفريّة لا يجب أن يحصل.
      const openingAllow =
        openingWindow != null && qty <= openingWindow.maxQty && money(deductCosts.get(vid) ?? "0").gt(0)
        // بضاعة الأمانة (§٥-ج): لا بيع بالسالب لصنف أمانة في المسار الحيّ — تلفيقُ التزامٍ لبضاعةٍ لم تُودَع.
        && !consignByVariant.has(vid);
      try {
        const moved = await applyMovement(tx, {
          variantId: vid,
          branchId: input.branchId,
          baseQuantity: qty,
          movementType: "OUT",
          referenceType: "INVOICE",
          referenceId: invoiceId,
          createdBy: actor.userId,
          notes: openingAllow ? "وضع الافتتاح — بيع نقدي مسموح بالسالب لصنف غير مُفتتَح" : undefined,
          // أوفلاين (ش٣): البيع الملتقَط دون اتصال يُسجَّل ولو هبط الرصيد تحت الصفر — البضاعة
          // خرجت فعلاً (قرار مالك: سالب موسوم بـoriginatedOffline، يظهر في تقرير المراجعة).
          // **استثناء بضاعة الأمانة (§٥-ج، مرآة حارس وضع الافتتاح أعلاه):** لا بيع بالسالب لصنف
          // أمانة حتى عبر الأوفلاين — بيعُ ما لم يُودَع يُلفّق التزاماً للمودِع (AP) لوحداتٍ لم تصل
          // (استحقاق PURCHASE يتيم أدناه). يُرفض بـCONFLICT فيرتدّ ويُعلَّق لمراجعة المدير كالمسار الحيّ.
          allowNegative: (input.allowNegativeStock ?? false) && !consignByVariant.has(vid),
          allowNegativeUnopened: openingAllow,
        });
        // معلومة استشارية للمحاولة الفائزة فقط (لا تُعاد في replay الـidempotency — لا حالة دائمة عليها).
        if (openingAllow && moved.newQuantity < 0) negativeDips.push({ variantId: vid, newQuantity: moved.newQuantity });
      } catch (e) {
        // إثراء رسالة الرفض أثناء نافذة الافتتاح: يشرح للكاشير لماذا لم يُسمح بالسالب لهذا السطر.
        if (e instanceof TRPCError && e.code === "CONFLICT" && e.message.includes("المخزون غير كافٍ")) {
          const win = openingWindow ?? (await readOpeningWindow());
          if (win) {
            const hint = !openingBaseEligible
              ? "وضع الافتتاح فعّال، لكن البيع بالسالب للصنف غير المجرود يتطلّب بيعاً نقدياً مدفوعاً بالكامل من قناة البيع المباشر — الآجل والدفعة الجزئية وغير النقدي وقنوات الطلبات تبقى صارمة"
              : qty > win.maxQty
                ? `الكمية تتجاوز سقف السطر السالب في وضع الافتتاح (${win.maxQty} وحدة أساس)`
                : !money(deductCosts.get(vid) ?? "0").gt(0)
                  ? "البيع بالسالب في وضع الافتتاح يتطلّب تكلفة مُدخلة للصنف — أدخِل تكلفته أولاً"
                  : "الصنف مُفتتَح (مجرود) — رصيده مثبّت والبيع فوقه يخضع للفحص الصارم";
            throw new TRPCError({ code: "CONFLICT", message: `${e.message} — ${hint}` });
          }
        }
        throw e;
      }
    }

    // 11. SALE ledger entry (revenue = net before tax + أجرة الشحن كإيراد بلا تكلفة).
    const revenue = money(totals.subtotal).minus(money(totals.discountAmount)).plus(money(input.deliveryFee ?? "0"));
    const cost = money(costTotal);
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`, // حارس بنيوي: قيد SALE واحد لكل فاتورة
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue,
      cost,
      profit: revenue.minus(cost),
      taxAmount: money(totals.taxAmount),
      amount: money(totals.total),
    });

    // 11.أ بضاعة الأمانة (ش٣): التقاط التزام المودِع لحظة البيع. طريقة الإجمالي — قيد SALE أعلاه لم يُمسّ
    // (revenue كامل، الربح=الهامش لأن الحصة داخل unitCost). لكل مودِع: قيد PURCHASE **يتيم** بـinvoiceId
    // (المميّز البنيوي PURCHASE∧invoiceId فارغ تاريخياً) بصفر أثر P&L (amount فقط) + رفع رصيده (AP). §٢-ب.
    {
      const byConsignor = new Map<number, ReturnType<typeof money>>();
      for (const c of computed) {
        const cId = consignByVariant.get(c.variantId);
        if (cId == null) continue;
        const share = money(c.unitCost).times(c.baseQuantity); // الحصة بوحدة الأساس (unitCost×baseQty).
        byConsignor.set(cId, (byConsignor.get(cId) ?? money(0)).plus(share));
      }
      // ترتيب supplierId تصاعدياً — منع deadlock (مرآة ترتيب variantId في حركات المخزون).
      for (const cId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
        const amount = byConsignor.get(cId)!;
        if (amount.lte(0)) continue;
        await postEntry(tx, {
          entryType: "PURCHASE", supplierId: cId, invoiceId, branchId: input.branchId,
          amount, revenue: money(0), cost: money(0), profit: money(0),
          dedupeKey: `CONSIG:${invoiceId}:${cId}`, notes: "استحقاق أمانة",
        });
        await adjustSupplierBalance(tx, cId, amount);
      }
    }

    // 11.b تسوية التقريب النقدي: قيد ADJUST بفرق التقريب ⇒ (SALE.amount + ADJUST.amount) = الإجمالي المقرّب = النقد المستلم.
    // G6 (١٩/٦/٢٦): dedupeKey حارس ضدّ تكرار ADJUST لو حدثت إعادة محاولة بعد ER_DUP_ENTRY
    // (tx.atomicity تحمي نظرياً، لكن dedupeKey defense-in-depth صريح).
    if (!cashRoundingAdj.isZero()) {
      await postEntry(tx, {
        entryType: "ADJUST",
        dedupeKey: `ADJUST:IQD:${invoiceId}`,
        branchId: input.branchId,
        invoiceId,
        customerId: input.customerId ?? null,
        revenue: cashRoundingAdj,
        profit: cashRoundingAdj,
        amount: cashRoundingAdj,
        notes: "تقريب نقدي IQD",
      });
    }

    // 12. Payment + AR.
    if (paidNow.gt(0)) {
      const rRes = await tx.insert(receipts).values({
        invoiceId,
        branchId: input.branchId,
        shiftId: input.shiftId ?? null,
        // cashBucket=DRAWER للنقد (يدخل تسوية Z-report)، NULL لغير النقد (لا يَمسّ صندوقاً).
        // مرآة لنمط voucherService — يَحرس مستقبلاً صيَغ reconcile/cashOrphans التي تَفلتر بـcashBucket.
        cashBucket: input.payment!.method === "CASH" ? "DRAWER" : null,
        direction: "IN",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
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

    return {
      invoiceId,
      invoiceNumber,
      total: toDbMoney(effectiveTotalD),
      status,
      priceOverride: belowCost,
      ...(negativeDips.length ? { negativeDips } : {}),
    };
  });
}
