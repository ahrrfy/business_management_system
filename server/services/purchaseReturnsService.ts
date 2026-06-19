import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  accountingEntries,
  inventoryMovements,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  receipts,
} from "../../drizzle/schema";
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
          .select({ amount: accountingEntries.amount })
          .from(accountingEntries)
          .where(eq(accountingEntries.id, existingRefId))
          .limit(1))[0];
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
      if (reqUnit.gt(bookUnitCost)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `سعر إرجاع المتغيّر ${it.variantId} (${reqUnit.toFixed(2)}) يتجاوز تكلفته المسجّلة (${bookUnitCost.toFixed(2)}) — لا يُسمح بتضخيم قيمة المرتجع.`,
        });
      }
      const lineTotal = round2(reqUnit.times(money(it.quantity)));
      work.push({ input: it, baseQuantity, lineTotal });
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
    .where(and(...where))
    .orderBy(sql`${accountingEntries.id} DESC`)
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(accountingEntries)
    .where(and(...where));

  return { rows, total: Number(totalRow[0]?.c ?? 0) };
}
