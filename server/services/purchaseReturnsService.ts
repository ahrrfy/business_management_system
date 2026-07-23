import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  inventoryMovements,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  receipts,
  suppliers,
} from "../../drizzle/schema";
import { escLike } from "../lib/sqlLike";
import { localDayStart } from "./dateRange";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustSupplierBalance, postEntry } from "./ledgerService";
import { money, round2, sumMoney, toDbMoney } from "./money";
import { shiftIdForCashTx } from "./shiftService";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface PurchaseReturnLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string; // بوحدة الشراء
  unitPrice: string; // سعر بوحدة الشراء (تكلفة الإرجاع)
}

export interface CreatePurchaseReturnInput {
  clientRequestId?: string;
  supplierId: number;
  branchId: number;
  /** أمر شراء مرجعي اختياري — يُحدّ من كمّيات الإرجاع بما لا يتجاوز المستلَم−المُرتجَع سابقاً */
  purchaseOrderRefId?: number;
  items: PurchaseReturnLineInput[];
  reason?: string | null;
  paymentMethod?: PaymentMethod; // CASH = استرداد فوري؛ غيره = خصم من ذمم المورد فقط
  /** افتراضياً CREDIT (خصم من رصيد المورد). CASH ⇒ يُسجَّل receipt OUT */
  settlement?: "CASH" | "CREDIT";
}

/**
 * مرتجع مشتريات (إرجاع بضاعة للمورد):
 *  - OUT حركة مخزون عن كل بند (بقفل ذرّي على branchStock).
 *  - قيد RETURN في الدفتر بقيم سالبة (cost سالب، amount سالب).
 *  - تخفيض ذمم المورد: AP موجب = نحن مدينون له ⇒ المرتجع يُنقصها ⇒ delta = -returnedTotal.
 *    (إن دفع المورد نقداً ⇒ نسجّل receipt IN ⇒ يزيد الصندوق، ويُلغى أثر تخفيض الذمم بمقدار النقد).
 *  - idempotency على clientRequestId عبر تخزينه في accountingEntries.notes (مفتاح فريد منطقي).
 */
export async function createPurchaseReturn(input: CreatePurchaseReturnInput, actor: Actor) {
  if (!input.items.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرتجع المشتريات بلا أصناف" });
  }

  return withTx(async (tx) => {
    // idempotency: جدول idempotencyKeys ذو القيد الفريد (operation,clientRequestId) — ذرّي بلا سباق TOCTOU
    // (بخلاف البحث القديم في notes غير المفهرس). نفس المفتاح ⇒ يُعاد بنتيجة المرتجع الأول.
    if (input.clientRequestId) {
      const existingRefId = await findIdempotentRefId(tx, "purchase.return", input.clientRequestId);
      if (existingRefId != null) {
        const prior = (await tx
          .select({
            amount: accountingEntries.amount,
            supplierId: accountingEntries.supplierId,
            branchId: accountingEntries.branchId,
          })
          .from(accountingEntries)
          .where(eq(accountingEntries.id, existingRefId))
          .limit(1))[0];
        // تحقّق البصمة (تدقيق ١٧/٧): نفس مفتاح idempotency بمورّد/فرع مختلف ⇒ CONFLICT — لا نعيد نتيجة
        // مرتجعٍ آخر (كان returnService يتحقّق بينما مسار الشراء يعيد الأول عمياءً). مرآةٌ لـsale.pay.
        if (prior && (Number(prior.supplierId) !== input.supplierId || Number(prior.branchId) !== input.branchId)) {
          throw new TRPCError({ code: "CONFLICT", message: "مفتاح idempotency مُستعمَل بمورّد أو فرع مختلف" });
        }
        return {
          purchaseReturnEntryId: existingRefId,
          returnedTotal: money(prior?.amount ?? "0").neg().toFixed(2),
          idempotent: true as const,
        };
      }
    }

    // إن وُجد أمر شراء مرجعي ⇒ تحقّق ملكية المورد/الفرع + سقف الكميّات.
    let refPo: typeof purchaseOrders.$inferSelect | undefined;
    if (input.purchaseOrderRefId) {
      const r = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderRefId))
        .for("update")
        .limit(1);
      refPo = r[0];
      if (!refPo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشراء المرجعي غير موجود" });
      if (Number(refPo.supplierId) !== input.supplierId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء لا يخصّ هذا المورد" });
      }
      if (Number(refPo.branchId) !== input.branchId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أمر الشراء لا يخصّ هذا الفرع" });
      }
    }

    // حضِّر العمل: حوِّل لوحدة الأساس + احسب صافي البند.
    type Work = {
      input: PurchaseReturnLineInput;
      baseQuantity: number;
      lineTotal: Decimal;
      /** التكلفة الدفترية (WAVG) لكلّ وحدة أساس — تُستعمَل لسقف خسارة الشحن/الكمرك (landed) عند الإرجاع. */
      bookCostPerBase: Decimal;
    };
    const work: Work[] = [];
    for (const it of input.items) {
      const { baseQuantity } = await convertToBaseQuantity(tx, it.productUnitId, it.quantity, it.variantId);
      // سقف القيمة: سعر إرجاع الوحدة لا يتجاوز التكلفة المسجّلة للصنف (book cost) ⇒ يمنع تضخيم تخفيض AP/الاسترداد
      //  بقيمة عشوائية (الثغرة الحرجة للمرتجع بلا أمر مرجعي). الكمية مُقيّدة بالمخزون المتاح في applyMovement.
      const v = (await tx.select({ costPrice: productVariants.costPrice }).from(productVariants).where(eq(productVariants.id, it.variantId)).limit(1))[0];
      if (!v) throw new TRPCError({ code: "NOT_FOUND", message: `المتغيّر ${it.variantId} غير موجود` });
      const bookCostPerBase = money(v.costPrice ?? "0");
      const factor = money(baseQuantity).dividedBy(money(it.quantity)); // وحدات الأساس لكل وحدة شراء
      const bookUnitCost = round2(bookCostPerBase.times(factor)); // تكلفة وحدة الشراء بالكتب
      const reqUnit = money(it.unitPrice);
      // PROC-02: سعر الإرجاع لا يصحّ أن يكون سالباً — السقف العلوي وحده أعمى عن الإشارة
      // (reqUnit.gt(bookUnitCost) يَمرّ على السالب) ⇒ كان سعرٌ سالب يَعكس اتجاه AP ويَحقن قيمة.
      if (reqUnit.lt(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "سعر إرجاع الشراء لا يصحّ أن يكون سالباً" });
      }
      if (reqUnit.gt(bookUnitCost)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `سعر إرجاع المتغيّر ${it.variantId} (${reqUnit.toFixed(2)}) يتجاوز تكلفته المسجّلة (${bookUnitCost.toFixed(2)}) — لا يُسمح بتضخيم قيمة المرتجع.`,
        });
      }
      const lineTotal = round2(reqUnit.times(money(it.quantity)));
      work.push({ input: it, baseQuantity, lineTotal, bookCostPerBase });
    }

    // سقف الكميّات حسب أمر الشراء المرجعي: لا يتجاوز (مستلم − مُرتجَع سابقاً) لكل (variantId).
    if (refPo) {
      const refItems = await tx
        .select()
        .from(purchaseOrderItems)
        .where(eq(purchaseOrderItems.purchaseOrderId, Number(refPo.id)));
      const receivedByVariant = new Map<number, number>();
      for (const ri of refItems) {
        receivedByVariant.set(
          Number(ri.variantId),
          (receivedByVariant.get(Number(ri.variantId)) ?? 0) + (ri.receivedBaseQuantity ?? 0)
        );
      }
      // كميّات مُرتجَعة سابقاً من نفس الأمر (مجموع OUT بحركات referenceType='PURCHASE_RETURN_REF' + referenceId=poId).
      const priorMoves = await tx
        .select({
          variantId: inventoryMovements.variantId,
          q: sql<number>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.referenceType, "PURCHASE_RETURN_REF"),
            eq(inventoryMovements.referenceId, Number(refPo.id)),
            eq(inventoryMovements.movementType, "OUT")
          )
        )
        .groupBy(inventoryMovements.variantId);
      const priorByVariant = new Map<number, number>();
      for (const m of priorMoves) {
        priorByVariant.set(Number(m.variantId), Number(m.q));
      }
      // اجمع الطلب الحالي حسب variantId.
      const requestedByVariant = new Map<number, number>();
      for (const w of work) {
        requestedByVariant.set(
          w.input.variantId,
          (requestedByVariant.get(w.input.variantId) ?? 0) + w.baseQuantity
        );
      }
      requestedByVariant.forEach((reqQty, vid) => {
        const received = receivedByVariant.get(vid) ?? 0;
        const priorReturned = priorByVariant.get(vid) ?? 0;
        const remaining = received - priorReturned;
        if (reqQty > remaining) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `كمية المرتجع للمتغيّر ${vid} تتجاوز المتبقّي القابل للإرجاع (المستلَم=${received}، المُرتجَع سابقاً=${priorReturned})`,
          });
        }
      });
    }

    // ترتيب حركات OUT حسب variantId (قفل حتمي ⇒ يمنع deadlock).
    const ordered = [...work].sort((a, b) => a.input.variantId - b.input.variantId);
    const refType = input.purchaseOrderRefId ? "PURCHASE_RETURN_REF" : "PURCHASE_RETURN";
    const refId = input.purchaseOrderRefId ?? undefined;
    for (const w of ordered) {
      await applyMovement(tx, {
        variantId: w.input.variantId,
        branchId: input.branchId,
        baseQuantity: w.baseQuantity,
        movementType: "OUT",
        referenceType: refType,
        referenceId: refId,
        createdBy: actor.userId,
      });
    }

    const returnedTotal = round2(sumMoney(work.map((w) => w.lineTotal.toFixed(2))));

    // قيد دفتر RETURN — الاتفاقية: قيم سالبة. cost سالب (تكلفة عُكست)، amount سالب.
    await postEntry(tx, {
      entryType: "RETURN",
      branchId: input.branchId,
      purchaseOrderId: input.purchaseOrderRefId ?? null,
      supplierId: input.supplierId,
      cost: returnedTotal.neg(),
      amount: returnedTotal.neg(),
      notes: input.reason ?? undefined,
    });

    // التقط معرف قيد المرتجع للإرجاع للعميل (للتتبّع/idempotency).
    const last = await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(
        and(
          eq(accountingEntries.entryType, "RETURN"),
          eq(accountingEntries.supplierId, input.supplierId),
          eq(accountingEntries.amount, toDbMoney(returnedTotal.neg()))
        )
      )
      .orderBy(sql`id DESC`)
      .limit(1);
    const purchaseReturnEntryId = Number(last[0]?.id ?? 0);

    // Idempotency: سجّل المفتاح (refId = قيد المرتجع). سباق نفس المفتاح ⇒ ER_DUP_ENTRY فيُعاد المحاولة replay.
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "purchase.return", input.clientRequestId, purchaseReturnEntryId);
    }

    // AP: المورد يدين لنا الآن بقيمة المرتجع ⇒ ننقص رصيده الدائن لدينا (suppliers.currentBalance) بالسالب.
    await adjustSupplierBalance(tx, input.supplierId, returnedTotal.neg());

    // الاسترداد النقدي اختياري: لو CASH ⇒ المورد ردّ النقد ⇒ receipt IN ⇒ يزيد الصندوق،
    // ولأنّنا أنقصنا الذمم بكامل القيمة فإن استلامنا نقداً يجب أن "يُعيد" قيمة النقد للذمم
    // كي يظل صافي الأثر: AP -= (returnedTotal − cashReceived). يُحقّق ذلك بـ PAYMENT_IN + adjustSupplier(+cash).
    const settlement = input.settlement ?? "CREDIT";
    if (settlement === "CASH") {
      const method = input.paymentMethod ?? "CASH";
      // G14 (١٩/٦/٢٦): استرداد نقدي من المورد يَلزم وردية مفتوحة (متّسق مع receivePurchase).
      const isCash = method === "CASH";
      let shiftId: number | null = null;
      let cashBucket: "DRAWER" | "TREASURY" | null = null;
      if (isCash) {
        const g = await shiftIdForCashTx(
          tx,
          { userId: actor.userId, branchId: input.branchId, role: (actor as Actor & { role?: string }).role },
          input.branchId,
          "استرداد من المورد",
        );
        shiftId = g.shiftId;
        cashBucket = g.cashBucket;
      }
      const rRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        shiftId,
        cashBucket,
        direction: "IN",
        amount: toDbMoney(returnedTotal),
        paymentMethod: method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        purchaseOrderId: input.purchaseOrderRefId ?? null,
        supplierId: input.supplierId,
        receiptId,
        amount: returnedTotal,
      });
      // العاكس: لأنّ النقد دخل صندوقنا، نُلغي خصم الذمم بمقدار النقد المُسترد.
      await adjustSupplierBalance(tx, input.supplierId, returnedTotal);
    }

    // ── landed-cost على مرتجع الشراء (متابعة Codex على #311، تصحيح #318 — قرار المالك ٢٢/٧/٢٦) ──
    // الشحن/الكمرك (landed) رُسمِل في تكلفة المخزون (WAVG) وأُضيف إلى ذمّة المورّد عند الاستلام (#311).
    // قرار المالك: الشحن الوارد **غير مسترد** عند الإرجاع ⇒ يُقيَّد **خسارةً** في الأرباح والخسائر.
    // ⚠️ تصحيح #318: كان يَعكس حصّة الشحن من AP فوق خصم RETURN (خصمٌ مزدوج) ⇒ انحرافُ مطابقةٍ دائم في
    // reconcileSupplierBalances + قائمةُ دخلٍ ≠ ميزانية (netProfit يُظهر الخسارة وحقوقُ الملكية لا تنخفض).
    // ⚠️ إصلاح #321: يُقيَّد في **كلا** المسارين (آجل CREDIT ونقديّ CASH) — الكتلة **محايدةٌ على AP** (تقيّد
    // خسارة P&L فقط بلا adjustSupplierBalance بعد #319). الآجل: قيد RETURN خصم قيمة البضاعة وحدها فتبقى
    // حصّةُ الشحن ديناً في AP تُسدَّد لاحقاً. النقديّ: صافي أثر AP صفر (خصم RETURN ثم عكسه عند استلام النقد)
    // والاسترداد بسعر البضاعة، فحصّةُ الشحن غير المُستردّة (uncredited) هي الخسارة. المخزون يخرج بـWAVG.
    if (refPo) {
      const totalLanded = round2(money(refPo.shippingCost ?? "0").plus(money(refPo.customsCost ?? "0")));
      if (totalLanded.gt(0)) {
        const poItems = await tx
          .select({
            id: purchaseOrderItems.id,
            variantId: purchaseOrderItems.variantId,
            total: purchaseOrderItems.total,
            baseQuantity: purchaseOrderItems.baseQuantity,
          })
          .from(purchaseOrderItems)
          .where(eq(purchaseOrderItems.purchaseOrderId, Number(refPo.id)));
        const poSubtotal = money(refPo.subtotal ?? "0");
        // توزيع الشحن/الكمرك على بنود الأمر **بنسبة القيمة** — مطابقٌ حرفياً لتوزيع #311 عند الاستلام
        // (آخر بندٍ ذي قيمة يمتصّ فرق التقريب ⇒ Σ الحصص = totalLanded بالضبط).
        const landedByItemId = new Map<number, Decimal>();
        for (const it of poItems) landedByItemId.set(Number(it.id), new Decimal(0));
        if (poSubtotal.gt(0)) {
          const ordered = [...poItems].sort((a, b) => Number(a.id) - Number(b.id));
          let lastValued = -1;
          for (let i = 0; i < ordered.length; i++) if (money(ordered[i].total).gt(0)) lastValued = i;
          let allocated = new Decimal(0);
          for (let i = 0; i < ordered.length; i++) {
            const it = ordered[i];
            if (money(it.total).lte(0)) continue;
            if (i === lastValued) {
              landedByItemId.set(Number(it.id), round2(totalLanded.minus(allocated)));
            } else {
              const share = round2(totalLanded.times(money(it.total)).dividedBy(poSubtotal));
              landedByItemId.set(Number(it.id), share);
              allocated = allocated.plus(share);
            }
          }
        }
        // حصّة الشحن/الكمرك لكلّ وحدة أساس على مستوى المتغيّر (تجميع بنود المتغيّر الواحد).
        const landedSumByVariant = new Map<number, Decimal>();
        const baseQtyByVariant = new Map<number, Decimal>();
        for (const it of poItems) {
          const vid = Number(it.variantId);
          landedSumByVariant.set(vid, (landedSumByVariant.get(vid) ?? new Decimal(0)).plus(landedByItemId.get(Number(it.id)) ?? new Decimal(0)));
          baseQtyByVariant.set(vid, (baseQtyByVariant.get(vid) ?? new Decimal(0)).plus(new Decimal(it.baseQuantity ?? 0)));
        }
        // خسارة الشحن الخام = Σ (حصّة الوحدة × الكمية المُرتجَعة بالأساس)؛ القيمة الدفترية للمرتجَع = Σ (WAVG × الأساس).
        let landedLossRaw = new Decimal(0);
        let fullBookValue = new Decimal(0);
        for (const w of work) {
          const vid = w.input.variantId;
          const totBase = baseQtyByVariant.get(vid) ?? new Decimal(0);
          const perBase = totBase.gt(0) ? (landedSumByVariant.get(vid) ?? new Decimal(0)).dividedBy(totBase) : new Decimal(0);
          landedLossRaw = landedLossRaw.plus(perBase.times(w.baseQuantity));
          fullBookValue = fullBookValue.plus(round2(w.bookCostPerBase.times(w.baseQuantity)));
        }
        landedLossRaw = round2(landedLossRaw);
        fullBookValue = round2(fullBookValue);
        // السقف: الخسارة لا تتجاوز حصّةَ الشحن غير المُعتمَدة = (القيمة الدفترية − ما اعتمده المورّد في
        // returnedTotal) ⇒ لو أُدخل سعرُ إرجاعٍ أعلى من سعر البضاعة (يعتمد المورّد جزءاً من الشحن) لا
        // تُقيَّد خسارةٌ على الجزء المُعتمَد، ولا تتجاوز الخسارةُ القيمةَ الدفترية غير المُستردّة للمرتجَع.
        const uncredited = Decimal.max(new Decimal(0), fullBookValue.minus(returnedTotal));
        const landedLoss = round2(Decimal.min(landedLossRaw, uncredited));
        if (landedLoss.gt(0)) {
          // قيّد الخسارة في P&L — ADJUST بمفتاح PURCHRET_LANDED (سطر مصروف مستقلّ في قائمة الدخل، خارج
          // SALE/RETURN فلا يمسّ إيراد/تكلفة المبيعات). cost موجب = خسارة تَخفض صافي الربح.
          // **بلا خصمٍ من ذمّة المورّد هنا** (تصحيح #318): خصمُ RETURN أعلاه غطّى قيمة البضاعة فقط، فتبقى
          // حصّةُ الشحن ديناً في AP (التزامٌ حقيقيّ تُسدّده لاحقاً) ⇒ reconcileSupplierBalances يبقى خالياً
          // والميزانية تتّزن مع قائمة الدخل. بلا supplierId ⇒ لا بندَ حركةٍ زائف في كشف المورّد (الالتزام بقيد PURCHASE).
          await postEntry(tx, {
            entryType: "ADJUST",
            branchId: input.branchId,
            purchaseOrderId: Number(refPo.id),
            cost: landedLoss,
            amount: landedLoss,
            dedupeKey: `PURCHRET_LANDED:${purchaseReturnEntryId}`,
            notes: "خسارة شحن/كمرك بضاعة مُرتجَعة للمورّد (غير مسترد)",
          });
        }
      }
    }

    return {
      purchaseReturnEntryId,
      returnedTotal: returnedTotal.toFixed(2),
      idempotent: false as const,
    };
  });
}

export interface ListPurchaseReturnsInput {
  supplierId?: number;
  branchId?: number;
  /** فترة على entryDate (YYYY-MM-DD) — عمود DATE بلا وقت ⇒ gte/lte شاملان مباشرة. */
  from?: string;
  to?: string;
  /** بحث نصّي خادمي: ملاحظات/رقم القيد/أمر الشراء/اسم المورد. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** قائمة مرتجعات الشراء (قيود RETURN ذات supplierId). */
export async function listPurchaseReturns(input: ListPurchaseReturnsInput = {}) {
  const { getDb } = await import("../db");
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const where = [eq(accountingEntries.entryType, "RETURN")];
  if (input.supplierId) where.push(eq(accountingEntries.supplierId, input.supplierId));
  if (input.branchId) where.push(eq(accountingEntries.branchId, input.branchId));
  // entryDate عمود DATE (بلا وقت) ⇒ gte/lte شاملان للطرفين — بمنتصف ليلٍ محلي
  // (new Date("YYYY-MM-DD") = منتصف ليل UTC يُسلسَل +03:00 فيستثني يوم from كاملاً).
  if (input.from) where.push(gte(accountingEntries.entryDate, localDayStart(input.from)));
  if (input.to) where.push(lte(accountingEntries.entryDate, localDayStart(input.to)));
  // فقط قيود الشراء (لها supplierId غير null) — تمييزها عن مرتجعات البيع.
  where.push(sql`${accountingEntries.supplierId} IS NOT NULL` as any);
  // بحث نصّي آمن (escLike + ESCAPE '!'): ملاحظات/رقم القيد/أمر الشراء/اسم المورد (عبر join).
  if (input.q) {
    const pat = `%${escLike(input.q.trim())}%`;
    where.push(
      or(
        sql`${accountingEntries.notes} LIKE ${pat} ESCAPE '!'`,
        sql`CAST(${accountingEntries.id} AS CHAR) LIKE ${pat} ESCAPE '!'`,
        sql`CAST(${accountingEntries.purchaseOrderId} AS CHAR) LIKE ${pat} ESCAPE '!'`,
        sql`${suppliers.name} LIKE ${pat} ESCAPE '!'`,
      ) as any,
    );
  }

  const rows = await db
    .select({
      id: accountingEntries.id,
      entryDate: accountingEntries.entryDate,
      supplierId: accountingEntries.supplierId,
      branchId: accountingEntries.branchId,
      purchaseOrderId: accountingEntries.purchaseOrderId,
      amount: accountingEntries.amount,
      notes: accountingEntries.notes,
    })
    .from(accountingEntries)
    .leftJoin(suppliers, eq(accountingEntries.supplierId, suppliers.id))
    .where(and(...where))
    .orderBy(sql`${accountingEntries.id} DESC`)
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(accountingEntries)
    .leftJoin(suppliers, eq(accountingEntries.supplierId, suppliers.id))
    .where(and(...where));

  return { rows, total: Number(totalRow[0]?.c ?? 0) };
}
