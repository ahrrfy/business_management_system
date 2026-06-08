import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accountingEntries,
  inventoryMovements,
  purchaseOrderItems,
  purchaseOrders,
  receipts,
} from "../../drizzle/schema";
import { applyMovement, convertToBaseQuantity } from "./inventoryService";
import { adjustSupplierBalance, postEntry } from "./ledgerService";
import { money, round2, sumMoney, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

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
    // idempotency: ابحث عن قيد RETURN سابق بنفس clientRequestId.
    const idemKey = input.clientRequestId ? `purchaseReturn:${input.clientRequestId}` : null;
    if (idemKey) {
      const prior = await tx
        .select({ id: accountingEntries.id, amount: accountingEntries.amount })
        .from(accountingEntries)
        .where(
          and(
            eq(accountingEntries.entryType, "RETURN"),
            eq(accountingEntries.notes, idemKey)
          )
        )
        .limit(1);
      if (prior[0]) {
        return {
          purchaseReturnEntryId: Number(prior[0].id),
          returnedTotal: money(prior[0].amount).neg().toFixed(2),
          idempotent: true,
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
      const lineTotal = round2(money(it.unitPrice).times(money(it.quantity)));
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
      notes: idemKey ?? input.reason ?? undefined,
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

    // AP: المورد يدين لنا الآن بقيمة المرتجع ⇒ ننقص رصيده الدائن لدينا (suppliers.currentBalance) بالسالب.
    await adjustSupplierBalance(tx, input.supplierId, returnedTotal.neg());

    // الاسترداد النقدي اختياري: لو CASH ⇒ المورد ردّ النقد ⇒ receipt IN ⇒ يزيد الصندوق،
    // ولأنّنا أنقصنا الذمم بكامل القيمة فإن استلامنا نقداً يجب أن "يُعيد" قيمة النقد للذمم
    // كي يظل صافي الأثر: AP -= (returnedTotal − cashReceived). يُحقّق ذلك بـ PAYMENT_IN + adjustSupplier(+cash).
    const settlement = input.settlement ?? "CREDIT";
    if (settlement === "CASH") {
      const method = input.paymentMethod ?? "CASH";
      const rRes = await tx.insert(receipts).values({
        branchId: input.branchId,
        direction: "IN",
        amount: toDbMoney(returnedTotal),
        paymentMethod: method,
        status: "COMPLETED",
        createdBy: actor.userId,
      });
      const receiptId = Number((rRes as any)[0]?.insertId ?? (rRes as any).insertId);
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        purchaseOrderId: input.purchaseOrderRefId ?? null,
        supplierId: input.supplierId,
        receiptId,
        amount: returnedTotal,
        notes: idemKey ? `${idemKey}:cash` : undefined,
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
