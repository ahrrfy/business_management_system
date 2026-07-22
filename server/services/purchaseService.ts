import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, inArray, like, sql } from "drizzle-orm";
import { branchStock, productUnits, productVariants, products, purchaseOrderItems, purchaseOrders, receipts, suppliers, users } from "../../drizzle/schema";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustSupplierBalance, postEntry } from "./ledgerService";
import { money, round2, sumMoney, toDateStr, toDbMoney } from "./money";
import { shiftIdForCashTx } from "./shiftService";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface PurchaseLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string; // in purchase unit
  unitPrice: string; // price per purchase unit
}
export interface CreatePurchaseOrderInput {
  supplierId: number;
  branchId: number;
  taxRatePercent?: string | null;
  status?: "DRAFT" | "SENT" | "CONFIRMED";
  items: PurchaseLineInput[];
  notes?: string | null;
  clientRequestId?: string;
  /** usd-po-reconcile: مطابقة سعر الشراء بالدولار (إعلامي بحت — لا يمسّ total/paidAmount الديناريَين). */
  agreedCurrency?: "IQD" | "USD";
  /** مبلغ فاتورة المورد الفعلية بالدولار — إلزامي فقط حين agreedCurrency=USD. */
  usdTotal?: string | null;
  /** landed-cost: تكلفة الشحن الكلّية على أمر الشراء (تُرسمَل في تكلفة المخزون عند الاستلام، لا مصروف P&L). */
  shippingCost?: string | null;
  /** landed-cost: تكلفة الكمرك الكلّية على أمر الشراء (تُرسمَل مثل الشحن تماماً). */
  customsCost?: string | null;
}

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

    const rows = [];
    const lineNets: string[] = [];
    for (const it of input.items) {
      // PROC-01: حدّ ثقة الخدمة — money() لا يَرفض السالب وحده، فنَفحص الإشارة صراحةً
      // (الخدمة تُستدعى أيضاً من importService/seed لا الراوتر فقط ⇒ دفاع متعمّق إلزامي).
      if (money(it.unitPrice).lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "سعر الشراء لا يصحّ أن يكون سالباً" });
      if (money(it.quantity).lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الشراء يجب أن تكون موجبة" });
      const { baseQuantity } = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
      const lineNet = round2(money(it.unitPrice).times(money(it.quantity)));
      lineNets.push(lineNet.toFixed(2));
      rows.push({
        variantId: it.variantId,
        productUnitId: it.productUnitId,
        quantity: money(it.quantity).toFixed(3),
        baseQuantity,
        unitPrice: toDbMoney(it.unitPrice),
        total: lineNet.toFixed(2),
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

    // usd-po-reconcile: usdTotal إلزامي وموجب حين agreedCurrency=USD؛ agreedRate ضمني = total/usdTotal
    // (سعر الصرف الذي يجعل الإجمالي الديناري المُدخَل مساوياً لفاتورة المورّد الدولارية الفعلية).
    const agreedCurrency = input.agreedCurrency ?? "IQD";
    let usdTotalVal: Decimal | null = null;
    let agreedRateVal: Decimal | null = null;
    if (agreedCurrency === "USD") {
      usdTotalVal = money(input.usdTotal ?? 0);
      if (usdTotalVal.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ بالدولار (فاتورة المورد) يجب أن يكون موجباً" });
      }
      agreedRateVal = total.dividedBy(usdTotalVal);
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

/** عزل الفرع: غير المدير/الأدمن يُجبر فرعه على أوامر الشراء (نمط productionService.assertProductionBranch). */
function assertPurchaseBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التعديل على فرع آخر" });
  }
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

export interface ReceiveLineInput {
  purchaseOrderItemId: number;
  receivedBaseQuantity: number;
}
export interface ReceivePurchaseInput {
  purchaseOrderId: number;
  lines: ReceiveLineInput[];
  payment?: { amount: string; method: PaymentMethod } | null;
  /** Idempotency: نفس المفتاح يُعاد تشغيله بنتيجة الاستلام الأول (لا تكرار للمخزون/AP). */
  clientRequestId?: string | null;
}

export async function receivePurchase(input: ReceivePurchaseInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    // Idempotency: تكرار الطلب نفسه يُعاد تشغيله بنتيجة الاستلام الأول بلا تكرار للمخزون أو AP.
    // قبل أيّ replay، نتحقّق أنّ المفتاح المخزَّن يخصّ نفس أمر الشراء وفرعه والكميات المطلوبة.
    // كان الـreplay يَعود بنتيجة مضلِّلة (receivedTotal=0.00) دون أيّ تحقّق ⇒ مفتاح يُعاد استعماله
    // على PO مختلف أو بكميات مختلفة كان يُرجع نجاحاً صامتاً ⇒ يَخفي تكرار طلب على كيان مختلف.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "purchase.receive", input.clientRequestId);
      if (existingRefId != null) {
        if (existingRefId !== input.purchaseOrderId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: المفتاح مستعمَل لاستلام أمر شراء مختلف",
          });
        }
        const replayPo = (
          await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1)
        )[0];
        if (!replayPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
        assertPurchaseBranch(replayPo, actor);
        const replayItems = await tx
          .select()
          .from(purchaseOrderItems)
          .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
        const replayItemById = new Map(replayItems.map((i) => [Number(i.id), i]));
        const replayInputSum = input.lines.reduce((acc, l) => acc + Number(l.receivedBaseQuantity), 0);
        const replayActualSum = input.lines.reduce((acc, l) => {
          const it = replayItemById.get(l.purchaseOrderItemId);
          if (!it) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "تعارض idempotency: بنود الاستلام لا تخص أمر الشراء المُسجَّل",
            });
          }
          return acc + Number(it.receivedBaseQuantity ?? 0);
        }, 0);
        if (replayActualSum < replayInputSum) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "تعارض idempotency: كميات الاستلام المطلوبة لا تطابق المسجَّل",
          });
        }
        const replayFully = replayItems.every((r) => (r.receivedBaseQuantity ?? 0) >= r.baseQuantity);
        return {
          purchaseOrderId: input.purchaseOrderId,
          fullyReceived: replayFully,
          receivedTotal: money(replayPo.total).toFixed(2),
          idempotentReplay: true as const,
        };
      }
    }

    const poRows = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .for("update")
      .limit(1);
    const po = poRows[0];
    if (!po) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء غير موجود" });
    assertPurchaseBranch(po, actor);
    if (po.status === "RECEIVED" || po.status === "CANCELLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء مستلَم أو ملغى" });
    }
    // SOD-06 (تدقيق ٢٠/٦، قرار المالك): اعتماد الشراء بفصل المهام — الاستلام يُلزِم الذمم الدائنة (AP)
    // ويُرحّل قيد PURCHASE، فيجب أن يَختلف المُستلِم (المُعتمِد) عن مُنشئ الأمر، إلّا للأدمن. يضمن
    // شخصين في الشراء الآجل (مُنشئ + مُعتمِد) — نفس نمط SOD-05 في cancelVoucher.
    const receiverRole =
      actor.role ?? (await tx.select({ role: users.role }).from(users).where(eq(users.id, actor.userId)).limit(1))[0]?.role ?? "";
    if (receiverRole !== "admin" && po.createdBy != null && Number(po.createdBy) === actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يجوز استلام أمر شراء أنشأته بنفسك — يلزم شخص آخر لاعتماده (فصل المهام).",
      });
    }

    const items = await tx
      .select()
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    const itemById = new Map(items.map((i) => [Number(i.id), i]));

    // landed-cost: توزيع (الشحن + الكمرك) على بنود الأمر بنسبة قيمة كلّ بند من المجموع الفرعي.
    // يُحسب من حقول الأمر المخزَّنة على **كلّ** البنود (لا المستلَمة فقط) ⇒ حصّة البند ثابتة طوال
    // حياته، والاستلام الجزئيّ يُرسمِل نصيبَه منها (انظر cumLanded أدناه). خوارزمية «آخر بندٍ ذي قيمة
    // يمتصّ فرق التقريب» تضمن ثابتاً صارماً: **Σ الحصص = totalLanded بالضبط** (لا انجراف سنتات).
    const totalLanded = round2(money(po.shippingCost).plus(money(po.customsCost)));
    const poSubtotalForLanded = money(po.subtotal);
    const landedByItemId = new Map<number, Decimal>();
    for (const it of items) landedByItemId.set(Number(it.id), new Decimal(0));
    if (totalLanded.gt(0) && poSubtotalForLanded.gt(0)) {
      const ordered = [...items].sort((a, b) => Number(a.id) - Number(b.id));
      let lastValued = -1;
      for (let i = 0; i < ordered.length; i++) if (money(ordered[i].total).gt(0)) lastValued = i;
      let allocated = new Decimal(0);
      for (let i = 0; i < ordered.length; i++) {
        const it = ordered[i];
        if (money(it.total).lte(0)) continue;
        if (i === lastValued) {
          landedByItemId.set(Number(it.id), round2(totalLanded.minus(allocated)));
        } else {
          const share = round2(totalLanded.times(money(it.total)).dividedBy(poSubtotalForLanded));
          landedByItemId.set(Number(it.id), share);
          allocated = allocated.plus(share);
        }
      }
    }

    // Validate, then sort received lines by variantId for deterministic locking.
    const work = input.lines.map((l) => {
      const item = itemById.get(l.purchaseOrderItemId);
      if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: `بند الشراء ${l.purchaseOrderItemId} لا يخص هذا الأمر` });
      if (!Number.isInteger(l.receivedBaseQuantity) || l.receivedBaseQuantity <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية المستلمة يجب أن تكون صحيحة موجبة" });
      }
      const alreadyReceived = item.receivedBaseQuantity ?? 0;
      if (alreadyReceived + l.receivedBaseQuantity > item.baseQuantity) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `الكمية المستلمة تتجاوز المطلوب للبند ${l.purchaseOrderItemId}` });
      }
      return { line: l, item };
    });
    work.sort((a, b) => Number(a.item.variantId) - Number(b.item.variantId));

    // Batch-load all required data before the loop (eliminates N×3 queries → 3 queries total).
    const variantIds = work.map(({ item }) => Number(item.variantId));
    const unitIds = work.map(({ item }) => Number(item.productUnitId));

    const unitRows = await tx
      .select({ id: productUnits.id, factor: productUnits.conversionFactor })
      .from(productUnits)
      .where(inArray(productUnits.id, unitIds));
    const unitFactorMap = new Map(unitRows.map((u) => [Number(u.id), u.factor]));

    // INV-004: التحقّق من قابلية الكمية المستلَمة للقسمة على معامل الوحدة (conversionFactor > 1).
    // مثال: وحدة «درزن» factor=12 ⇒ receivedBaseQuantity يجب أن يكون مضاعفاً لـ12.
    for (const { line, item } of work) {
      const factor = Number(unitFactorMap.get(Number(item.productUnitId)) ?? 1);
      if (factor > 1 && line.receivedBaseQuantity % factor !== 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `الكمية المستلَمة (${line.receivedBaseQuantity}) غير قابلة للقسمة على معامل الوحدة (${factor})` });
      }
    }

    // قفل صفوف branchStock للمتغيّرات المعنية قبل قراءة الـSUM:
    // يَسَلْسِل receive مع أي sale متزامن على نفس المتغيّرات (تلك تأخذ قفلاً على نفس الصفوف
    // عبر applyMovement). بدون هذا القفل، يمكن لـsale متزامن أن يُغيّر الكميات بين قراءة
    // الـSUM وكتابة costPrice ⇒ WAVG محسوب على رصيد قديم. القفل لا يمنع INSERT جديد، لكن
    // branchStock للـvariant موجود إذ بدونه لا يوجد sale (يعمل applyMovement على ضمان الصفّ).
    await tx
      .select({ id: branchStock.id })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .for("update");

    // Read existing stock per variant (sum across all branches) AFTER the row lock.
    const stockRows = await tx
      .select({
        variantId: branchStock.variantId,
        totalQty: sql<string>`COALESCE(SUM(${branchStock.quantity}), 0)`,
      })
      .from(branchStock)
      .where(inArray(branchStock.variantId, variantIds))
      .groupBy(branchStock.variantId);
    const stockMap = new Map(stockRows.map((s) => [Number(s.variantId), s.totalQty]));

    // Lock all variants for update in one query (deterministic order = ascending variantId).
    const variantRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds))
      .for("update");
    const costMap = new Map(variantRows.map((v) => [Number(v.id), v.cost]));

    let receivedNet = new Decimal(0);
    let receivedLanded = new Decimal(0);
    for (const { line, item } of work) {
      const factor = new Decimal(unitFactorMap.get(Number(item.productUnitId)) ?? "1");
      const costPerBase = round2(money(item.unitPrice).dividedBy(factor.lte(0) ? new Decimal(1) : factor));

      // landed-cost: حصّة البند من الشحن/الكمرك ÷ كمية البند الأساس = تكلفة مُرسمَلة لكلّ وحدة أساس،
      // تُضاف إلى تكلفة الشراء **قبل** حساب المتوسّط المرجّح ⇒ WAVG (ومنه COGS عند البيع) يعكس التكلفة
      // الحقيقية. تبقى بدقّة كاملة هنا (WAVG مُقرَّب في نهايته على أيّ حال) — نظير costPerBase تماماً.
      const lineLanded = landedByItemId.get(Number(item.id)) ?? new Decimal(0);
      const lineBaseQty = new Decimal(item.baseQuantity);
      const landedPerBase = lineBaseQty.gt(0) ? lineLanded.dividedBy(lineBaseQty) : new Decimal(0);
      const capCostPerBase = costPerBase.plus(landedPerBase);

      // WAVG (المتوسّط المرجّح): المخزون القائم + التكلفة القديمة مُقرآن قبل الحلقة.
      // التكلفة صفة عالمية للصنف ⇒ الوزن بإجمالي الأساس عبر الفروع.
      const existingQty = Decimal.max(new Decimal(stockMap.get(Number(item.variantId)) ?? "0"), 0);
      const oldCost = money(costMap.get(Number(item.variantId)) ?? "0");
      const recvQty = new Decimal(line.receivedBaseQuantity);
      const denom = existingQty.plus(recvQty);
      // لا مخزون قائم (أو تكلفة قديمة صفر) ⇒ المتوسّط = تكلفة الشراء الحالية (المُرسمَلة).
      const newCost =
        denom.lte(0) || oldCost.lte(0)
          ? round2(capCostPerBase)
          : round2(existingQty.times(oldCost).plus(recvQty.times(capCostPerBase)).dividedBy(denom));

      await applyMovement(tx, {
        variantId: Number(item.variantId),
        branchId: Number(po.branchId),
        baseQuantity: line.receivedBaseQuantity,
        movementType: "IN",
        referenceType: "PURCHASE_ORDER",
        referenceId: input.purchaseOrderId,
        createdBy: actor.userId,
      });
      await tx
        .update(purchaseOrderItems)
        .set({ receivedBaseQuantity: (item.receivedBaseQuantity ?? 0) + line.receivedBaseQuantity })
        .where(eq(purchaseOrderItems.id, Number(item.id)));
      // WAVG policy: تكلفة الصنف = المتوسّط المرجّح للمخزون القديم والمستلَم.
      await tx
        .update(productVariants)
        .set({ costPrice: newCost.toFixed(2) })
        .where(eq(productVariants.id, Number(item.variantId)));

      // حدّث الخريطتين بعد كل سطر ليُحسب المتوسّط المرجّح تسلسلياً لو تكرّر الصنف نفسه في أمر الشراء
      // (سطران لنفس المتغيّر) — وإلّا فالسطر الثاني يتجاهل كمية/تكلفة الأول ويطمس نتيجته.
      stockMap.set(Number(item.variantId), denom.toString());
      costMap.set(Number(item.variantId), newCost.toFixed(2));

      // Ledger/AP value derives from the stored line total (proportional to received).
      // مع عمود receivedNet المخزّن لتتبّع التراكم: عند الاستلام المُكمِل للكمية
      // (priorQty + thisQty === baseQuantity) نستعمل remainder = (total − receivedNet المخزّن سابقاً)
      // بدل round على portion ⇒ مجموع AP/PURCHASE يطابق إجمالي الـPO بالضبط (لا انجراف 0.01 IQD).
      const priorReceivedNet = money(item.receivedNet ?? "0");
      const priorQty = item.receivedBaseQuantity ?? 0;
      const isLastReceive = priorQty + line.receivedBaseQuantity === item.baseQuantity;
      let lineNet: Decimal;
      if (isLastReceive) {
        lineNet = round2(money(item.total).minus(priorReceivedNet));
      } else {
        const portion = new Decimal(line.receivedBaseQuantity).dividedBy(item.baseQuantity);
        lineNet = round2(money(item.total).times(portion));
      }
      await tx
        .update(purchaseOrderItems)
        .set({ receivedNet: toDbMoney(priorReceivedNet.plus(lineNet)) })
        .where(eq(purchaseOrderItems.id, Number(item.id)));
      receivedNet = receivedNet.plus(lineNet);

      // landed-cost: حصّة البند من الشحن/الكمرك المُرسمَلة في هذه الدفعة — cumulative مقرَّب بنفس
      // منطق «آخر استلامٍ يمتصّ الباقي» ⇒ Σ عبر كلّ الاستلامات = حصّة البند بالضبط (لا انجراف).
      const cumLanded = (k: number): Decimal =>
        k >= item.baseQuantity ? lineLanded : round2(lineLanded.times(k).dividedBy(item.baseQuantity));
      receivedLanded = receivedLanded.plus(cumLanded(priorQty + line.receivedBaseQuantity).minus(cumLanded(priorQty)));
    }
    receivedNet = round2(receivedNet);
    receivedLanded = round2(receivedLanded);

    // Proportional tax from the PO's effective rate.
    const poSubtotal = money(po.subtotal);
    const rate = poSubtotal.gt(0) ? money(po.taxAmount).dividedBy(poSubtotal) : new Decimal(0);
    const receivedTax = round2(receivedNet.times(rate));
    // landed-cost: الإجماليّ المستلَم = البضاعة + الضريبة + حصّة الشحن/الكمرك ⇒ AP يعكس التكلفة
    // الشاملة، ومجموعه عبر الاستلام الكامل يطابق po.total (البضاعة + الضريبة + الشحن + الكمرك).
    const receivedTotal = round2(receivedNet.plus(receivedTax).plus(receivedLanded));

    // Final status: fully received if every item meets its ordered base qty.
    const refreshed = await tx
      .select({ baseQuantity: purchaseOrderItems.baseQuantity, receivedBaseQuantity: purchaseOrderItems.receivedBaseQuantity })
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.purchaseOrderId, input.purchaseOrderId));
    const fullyReceived = refreshed.every((r) => (r.receivedBaseQuantity ?? 0) >= r.baseQuantity);
    await tx
      .update(purchaseOrders)
      .set({ status: fullyReceived ? "RECEIVED" : "CONFIRMED" })
      .where(eq(purchaseOrders.id, input.purchaseOrderId));

    // PURCHASE ledger entry + AP.
    // ⚠️ متابعة مؤجَّلة (Codex P2 — تحتاج قرار مالك، خارج نطاق v1): مرتجع الشراء المرجعيّ يعكس AP
    // بسعر البند المُدخَل (سقفه تكلفة WAVG الشاملة للرسملة في purchaseReturnsService). ردٌّ كامل بسعر
    // البضاعة وحده يُبقي حصّة الشحن/الكمرك في AP — هل الشحن الوارد مستردٌّ عند الإرجاع؟ قرارُ سياسةٍ
    // ماليّة يحسمه المالك. v1: الرسملة عند الاستلام فقط (نطاق هذه الشريحة).
    // landed-cost: cost = تكلفة المخزون المُرسمَلة (البضاعة + الشحن/الكمرك) — لا مصروف P&L: قيود
    // PURCHASE لا تدخل حساب الربح (reportsFinancialService يجمع cost لـSALE/RETURN فقط)، وقيمة
    // المخزون تعكس نفس الرسملة عبر costPrice (WAVG) ⇒ لا ازدواج، والاعتراف بالتكلفة مرّةً عند البيع.
    await postEntry(tx, {
      entryType: "PURCHASE",
      branchId: Number(po.branchId),
      purchaseOrderId: input.purchaseOrderId,
      supplierId: Number(po.supplierId),
      cost: round2(receivedNet.plus(receivedLanded)),
      taxAmount: receivedTax,
      amount: receivedTotal,
    });
    await adjustSupplierBalance(tx, Number(po.supplierId), receivedTotal);

    // Optional payment to supplier.
    const paidNow = money(input.payment?.amount ?? "0");
    if (paidNow.gt(0)) {
      // PROC-05 (تدقيق ٢/٧): السقف الأوّل — رصيد المورد الفعلي (منع AP سالبة على مستوى المورد).
      const supAfter = money(
        (await tx.select({ b: suppliers.currentBalance }).from(suppliers).where(eq(suppliers.id, Number(po.supplierId))).limit(1))[0]?.b ?? "0",
      );
      if (paidNow.gt(supAfter)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `الدفعة (${paidNow.toFixed(2)}) تتجاوز رصيد المورد المستحقّ (${supAfter.toFixed(2)})` });
      }
      // #7 (تدقيق التثبيت): سقف ثانٍ — المتبقّي على أمر الشراء نفسه. كان الدفع الداخلي يُنسب كاملاً
      // لـpo.paidAmount حتى لو تجاوز po.total، مضخّماً هذا PO ومُلوّثاً كل تقارير AP لكل PO (بمورد
      // له عدّة أوامر مفتوحة). الدفع الزائد المتعمَّد شأن سند صرف مستقلّ — لا مسار «استلام + دفع
      // إجمالي > المتبقّي».
      const poRemaining = money(po.total).minus(money(po.paidAmount));
      if (paidNow.gt(poRemaining)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الدفعة (${paidNow.toFixed(2)}) تتجاوز المتبقّي على أمر الشراء (${poRemaining.toFixed(2)}) — للمبالغ الزائدة استعمل سند صرف مستقلّاً`,
        });
      }
      // G14 (١٩/٦/٢٦): دفع نقدي للمورد يَلزم وردية مفتوحة — كان receipts.shiftId=null دائماً
      // ⇒ نقد يَخرج من الصندوق بلا تسوية Z-report ⇒ عجز وهمي عند الإغلاق.
      // shiftIdForCashTx: admin/manager ⇒ DRAWER أو TREASURY، cashier/warehouse ⇒ وردية إلزامية.
      // المعاملات غير النقدية (CARD/CHECK/TRANSFER/WALLET) لا تَمسّ الصندوق ⇒ shiftId=null مَشروع.
      const isCash = input.payment!.method === "CASH";
      let shiftId: number | null = null;
      let cashBucket: "DRAWER" | "TREASURY" | null = null;
      if (isCash) {
        const g = await shiftIdForCashTx(
          tx,
          { userId: actor.userId, branchId: Number(po.branchId), role: (actor as Actor & { role?: string }).role },
          Number(po.branchId),
          "دفع للمورد",
        );
        shiftId = g.shiftId;
        cashBucket = g.cashBucket;
      }
      const rRes = await tx.insert(receipts).values({
        branchId: Number(po.branchId),
        shiftId,
        cashBucket,
        direction: "OUT",
        amount: toDbMoney(paidNow),
        paymentMethod: input.payment!.method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_OUT",
        branchId: Number(po.branchId),
        purchaseOrderId: input.purchaseOrderId,
        supplierId: Number(po.supplierId),
        receiptId,
        amount: paidNow,
      });
      await adjustSupplierBalance(tx, Number(po.supplierId), paidNow.neg());
      await tx
        .update(purchaseOrders)
        .set({ paidAmount: toDbMoney(money(po.paidAmount).plus(paidNow)) })
        .where(eq(purchaseOrders.id, input.purchaseOrderId));
    }

    // Idempotency: سجّل المفتاح بعد نجاح الكتابة (refId = أمر الشراء).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "purchase.receive", input.clientRequestId, input.purchaseOrderId);
    }

    return { purchaseOrderId: input.purchaseOrderId, fullyReceived, receivedTotal: receivedTotal.toFixed(2) };
  });
}
