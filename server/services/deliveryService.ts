import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import {
  accountingEntries,
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryRemittances,
  invoiceItems,
  invoices,
  productUnits,
  receipts,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import type { Tx } from "../db";
import { money, round2, toDbMoney, toDateStr } from "./money";
import { withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { adjustDeliveryBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { nextInvoiceNumber } from "./numbering";
import { shiftIdForCashTx } from "./shiftService";
import { applyMovement } from "./inventoryService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
/** فاعل التحوّلات: يَحمل الدور لقرار درج/خزينة وعزل الفرع. */
type DeliveryTxActor = { userId: number; branchId?: number | null; role?: string };

/** الفاعل خفيف: branchId اختياري/فارغ (admin بلا فرع) بخلاف Actor الصارم. */
type DeliveryActor = { userId: number; branchId?: number | null };

/**
 * خدمة التوصيل (COD) — جهات التوصيل وعهدها.
 *
 * النموذج المحاسبي (٣ سجلّات لا تختلط): نقد الدرج / عهدة جهة التوصيل / ذمّة العميل (AR).
 * الإيراد يُعترف مرّة واحدة بقيد SALE عند الإرسال؛ COD يُوقَف على عهدة الجهة (currentBalance) لا على AR
 * (فاتورة COD بـcustomerId=NULL ⇒ مطابقة AR لا تتلوّث). التسوية بخصم الأجرة وتوريد الصافي (D8).
 *
 * هذا الملف (Slice 1): الترقيم + CRUD. التحوّلات (dispatch/remittance/settle/writeoff/return)
 * تُضاف في الشرائح التالية.
 */

export type DeliveryPartyKind = "INDIVIDUAL" | "COMPANY";

/** CN-{branchId}-{YYYYMMDD}-{seq} — ترقيم إرسالية ذرّي (نمط nextInvoiceNumber بـGET_LOCK). */
export async function nextConsignmentNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CN-${branchId}-${ymd}-`;
  const lockName = `numbering:consignment:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) throw new Error(`numbering lock timeout for ${lockName}`);
  try {
    const rows = await tx
      .select({ n: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments)
      .where(like(deliveryConsignments.consignmentNumber, `${prefix}%`))
      .orderBy(desc(deliveryConsignments.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** DR-{branchId}-{YYYYMMDD}-{seq} — ترقيم دفعة ترحيل ذرّي. */
export async function nextRemittanceNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `DR-${branchId}-${ymd}-`;
  const lockName = `numbering:remittance:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) throw new Error(`numbering lock timeout for ${lockName}`);
  try {
    const { deliveryRemittances } = await import("../../drizzle/schema");
    const rows = await tx
      .select({ n: deliveryRemittances.remittanceNumber })
      .from(deliveryRemittances)
      .where(like(deliveryRemittances.remittanceNumber, `${prefix}%`))
      .orderBy(desc(deliveryRemittances.id))
      .for("update")
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

// ───────────────────────── CRUD جهات التوصيل ─────────────────────────

export interface CreateDeliveryPartyInput {
  partyType: DeliveryPartyKind;
  name: string;
  phone?: string | null;
  phone2?: string | null;
  branchId?: number | null;
  nationalId?: string | null;
  vehicleInfo?: string | null;
  defaultFee?: string | null;
  floatLimit?: string | null;
  notes?: string | null;
}

export async function createDeliveryParty(input: CreateDeliveryPartyInput, actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx.insert(deliveryParties).values({
      partyType: input.partyType,
      name: input.name.trim(),
      phone: input.phone ?? null,
      phone2: input.phone2 ?? null,
      branchId: input.branchId ?? actor.branchId ?? null,
      nationalId: input.nationalId ?? null,
      vehicleInfo: input.vehicleInfo ?? null,
      defaultFee: toDbMoney(input.defaultFee ?? "0"),
      floatLimit: input.floatLimit != null && input.floatLimit !== "" ? toDbMoney(input.floatLimit) : null,
      notes: input.notes ?? null,
      isActive: true,
    });
    return { id: extractInsertId(res) };
  });
}

export interface UpdateDeliveryPartyInput {
  id: number;
  partyType?: DeliveryPartyKind;
  name?: string;
  phone?: string | null;
  phone2?: string | null;
  branchId?: number | null;
  nationalId?: string | null;
  vehicleInfo?: string | null;
  defaultFee?: string | null;
  floatLimit?: string | null;
  notes?: string | null;
}

export async function updateDeliveryParty(input: UpdateDeliveryPartyInput, _actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.partyType !== undefined) patch.partyType = input.partyType;
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.phone2 !== undefined) patch.phone2 = input.phone2;
    if (input.branchId !== undefined) patch.branchId = input.branchId;
    if (input.nationalId !== undefined) patch.nationalId = input.nationalId;
    if (input.vehicleInfo !== undefined) patch.vehicleInfo = input.vehicleInfo;
    if (input.defaultFee !== undefined) patch.defaultFee = toDbMoney(input.defaultFee ?? "0");
    if (input.floatLimit !== undefined) patch.floatLimit = input.floatLimit != null && input.floatLimit !== "" ? toDbMoney(input.floatLimit) : null;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (Object.keys(patch).length === 0) return { id: input.id };
    await tx.update(deliveryParties).set(patch).where(eq(deliveryParties.id, input.id));
    return { id: input.id };
  });
}

/** تعطيل/تفعيل جهة. الحظر عند وجود عهدة قائمة (currentBalance != 0) لمنع إخفاء ذمّة مفتوحة. */
export async function setDeliveryPartyActive(id: number, isActive: boolean, _actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    if (!isActive) {
      const p = (await tx.select({ balance: deliveryParties.currentBalance }).from(deliveryParties).where(eq(deliveryParties.id, id)).limit(1))[0];
      if (p && money(p.balance ?? "0").abs().gt("0.01")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعطيل جهة عليها عهدة قائمة — سوِّ الرصيد أولاً" });
      }
    }
    await tx.update(deliveryParties).set({ isActive }).where(eq(deliveryParties.id, id));
    return { id };
  });
}

export interface ListPartiesOpts {
  branchId?: number | null; // عزل الفرع لغير المرتفعين
  activeOnly?: boolean;
  search?: string | null;
}

/** قائمة جهات التوصيل + عهدتها + عدد شحناتها المفتوحة (لشاشة /delivery/parties). */
export async function listDeliveryParties(opts: ListPartiesOpts) {
  const db = getDb();
  if (!db) return [];
  const conds = [];
  if (opts.branchId != null) conds.push(eq(deliveryParties.branchId, opts.branchId));
  if (opts.activeOnly) conds.push(eq(deliveryParties.isActive, true));
  if (opts.search && opts.search.trim()) {
    const s = `%${opts.search.trim()}%`;
    conds.push(or(like(deliveryParties.name, s), like(deliveryParties.phone, s)));
  }
  const where = conds.length ? and(...conds) : undefined;
  const parties = await db
    .select({
      id: deliveryParties.id,
      partyType: deliveryParties.partyType,
      name: deliveryParties.name,
      phone: deliveryParties.phone,
      branchId: deliveryParties.branchId,
      defaultFee: deliveryParties.defaultFee,
      currentBalance: deliveryParties.currentBalance,
      floatLimit: deliveryParties.floatLimit,
      isActive: deliveryParties.isActive,
    })
    .from(deliveryParties)
    .where(where)
    .orderBy(desc(deliveryParties.isActive), deliveryParties.name);

  // عدد الشحنات المفتوحة + أقدم إرسالية لكل جهة (عهدة قائمة).
  const openAgg = await db
    .select({
      partyId: deliveryConsignments.partyId,
      openCount: sql<number>`COUNT(*)`,
      oldest: sql<string | null>`MIN(${deliveryConsignments.dispatchedAt})`,
    })
    .from(deliveryConsignments)
    .where(sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`)
    .groupBy(deliveryConsignments.partyId);
  const openMap = new Map(openAgg.map((r) => [Number(r.partyId), { openCount: Number(r.openCount), oldest: r.oldest }]));

  return parties.map((p) => ({
    ...p,
    openConsignments: openMap.get(Number(p.id))?.openCount ?? 0,
    oldestOutstanding: openMap.get(Number(p.id))?.oldest ?? null,
  }));
}

export async function getDeliveryParty(id: number) {
  const db = getDb();
  if (!db) return null;
  const rows = await db.select().from(deliveryParties).where(eq(deliveryParties.id, id)).limit(1);
  return rows[0] ?? null;
}

// ═══════════════════════════ التحوّلات (محاسبة العهدة) ═══════════════════════════
// ترتيب أقفال موحّد لمنع الجمود: الإرسالية → الجهة → الفاتورة → الوردية.

/** READY → DELIVERED + إرسالية: فاتورة (customerId=NULL) + SALE + عهدة COD على الجهة (D3). */
export interface DispatchInput {
  workOrderId: number;
  partyId: number;
  deliveryFee?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  clientRequestId?: string | null;
}

export async function dispatchToDelivery(input: DispatchInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.dispatch", input.clientRequestId);
      if (existingId != null) {
        const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, existingId)).limit(1))[0];
        return {
          consignmentId: existingId,
          consignmentNumber: cn?.consignmentNumber ?? "",
          invoiceId: Number(cn?.invoiceId ?? 0),
          invoiceNumber: "",
          codAmount: String(cn?.codAmount ?? "0"),
          deliveryFee: String(cn?.deliveryFee ?? "0"),
          idempotentReplay: true as const,
        };
      }
    }

    const wo = (await tx.select().from(workOrders).where(eq(workOrders.id, input.workOrderId)).for("update").limit(1))[0];
    if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "أمر الشغل غير موجود" });
    const elevated = actor.role === "admin" || actor.role === "manager";
    if (!elevated && actor.branchId != null && Number(wo.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إرسال أمر فرعٍ آخر" });
    }
    if (wo.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "الأمر ليس جاهزاً للإرسال" });

    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل غير متاحة" });

    const salePrice = money(wo.salePrice);
    const quantity = wo.quantity;
    const costTotal = round2(money(wo.materialsCost).plus(money(wo.laborCost)));
    const depositPaid = round2(money(wo.deposit ?? "0"));
    if (depositPaid.gt(salePrice)) throw new TRPCError({ code: "BAD_REQUEST", message: "العربون يتجاوز إجمالي الأمر" });
    const codAmount = round2(salePrice.minus(depositPaid)); // >= 0
    const fee = round2(money(input.deliveryFee ?? party.defaultFee ?? "0"));

    // فاتورة COD: customerId=NULL (الطرف المقابل = جهة التوصيل، عهدة لا AR ⇒ مطابقة AR/الائتمان سليمة).
    const invoiceNumber = await nextInvoiceNumber(tx, Number(wo.branchId));
    const invStatus = computeInvoiceStatus(salePrice.toFixed(2), toDbMoney(depositPaid));
    const invRes = await tx.insert(invoices).values({
      invoiceNumber,
      sourceType: "WORKORDER",
      sourceId: `WO-${wo.id}`,
      branchId: Number(wo.branchId),
      customerId: null,
      priceTier: "RETAIL",
      subtotal: salePrice.toFixed(2),
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: salePrice.toFixed(2),
      costTotal: costTotal.toFixed(2),
      status: invStatus,
      paidAmount: toDbMoney(depositPaid),
      paymentMethod: null,
      paymentDate: depositPaid.gt(0) ? new Date() : null,
      notes: `توصيل طلب خدمة ${wo.orderNumber}: ${wo.title}`,
      createdBy: actor.userId,
    });
    const invoiceId = extractInsertId(invRes);

    if (wo.baseVariantId != null) {
      const baseUnit = (await tx.select({ id: productUnits.id }).from(productUnits).where(eq(productUnits.variantId, Number(wo.baseVariantId))).limit(1))[0];
      const unitPrice = round2(salePrice.dividedBy(quantity));
      await tx.insert(invoiceItems).values({
        invoiceId,
        variantId: Number(wo.baseVariantId),
        productUnitId: baseUnit ? Number(baseUnit.id) : null,
        workOrderId: Number(wo.id),
        quantity: Number(quantity).toFixed(3),
        baseQuantity: quantity,
        unitPrice: unitPrice.toFixed(2),
        unitCost: round2(costTotal.dividedBy(quantity)).toFixed(2),
        discountAmount: "0",
        total: salePrice.toFixed(2),
      });
    }

    // SALE: الإيراد يُعترف عند الإرسال (D3). customerId=NULL على القيد أيضاً.
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`,
      branchId: Number(wo.branchId),
      invoiceId,
      revenue: salePrice,
      cost: costTotal,
      profit: round2(salePrice.minus(costTotal)),
      amount: salePrice,
    });

    // ربط إيصال العربون بالفاتورة (كان workOrderId-only) — append-only على القيد كـdeliverWorkOrder.
    if (depositPaid.gt(0)) {
      const depRcpt = (await tx.select({ id: receipts.id }).from(receipts)
        .where(and(eq(receipts.workOrderId, Number(wo.id)), isNull(receipts.invoiceId))).limit(1))[0];
      if (depRcpt) await tx.update(receipts).set({ invoiceId }).where(eq(receipts.id, Number(depRcpt.id)));
    }

    const consignmentNumber = await nextConsignmentNumber(tx, Number(wo.branchId));
    const codPositive = codAmount.gt(0);
    const cnRes = await tx.insert(deliveryConsignments).values({
      consignmentNumber,
      branchId: Number(wo.branchId),
      partyId: input.partyId,
      invoiceId,
      workOrderId: Number(wo.id),
      endCustomerId: wo.customerId ?? null,
      codAmount: toDbMoney(codAmount),
      collectedAmount: "0",
      deliveryFee: toDbMoney(fee),
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? wo.deliveryAddress ?? null,
      // codAmount=0 (مدفوع كامل بالعربون) ⇒ إرسالية تسليم فقط بلا عهدة.
      status: codPositive ? "DISPATCHED" : "DELIVERED",
      settledAt: codPositive ? null : new Date(),
      dispatchedBy: actor.userId,
    });
    const consignmentId = extractInsertId(cnRes);

    if (codPositive) {
      await adjustDeliveryBalance(tx, input.partyId, codAmount);
      await postEntry(tx, {
        entryType: "DELIVERY_DISPATCH",
        dedupeKey: `DELIVERY_DISPATCH:${consignmentId}`,
        branchId: Number(wo.branchId),
        invoiceId,
        deliveryPartyId: input.partyId,
        amount: codAmount,
        notes: `إرسالية ${consignmentNumber}`,
      });
    }

    await tx.update(workOrders).set({ status: "DELIVERED", invoiceId, deliveredAt: new Date() }).where(eq(workOrders.id, Number(wo.id)));
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.dispatch", input.clientRequestId, consignmentId);

    return { consignmentId, consignmentNumber, invoiceId, invoiceNumber, codAmount: codAmount.toFixed(2), deliveryFee: fee.toFixed(2) };
  });
}

/** ترحيل (D8): خصم الأجرة وتوريد الصافي. gross-up: PAYMENT_IN=COD كامل + DELIVERY_FEE=أجرة ⇒ صافي الدرج=المورَّد. */
export interface RemittanceLineInput {
  consignmentId: number;
  collectedAmount: string; // المُحصَّل لهذه الإرسالية (0..المتبقّي)
}
export interface RemittanceInput {
  branchId: number;
  partyId: number;
  lines: RemittanceLineInput[];
  shiftType?: "RECEPTION" | "RETAIL";
  clientRequestId?: string | null;
}

export async function recordDeliveryRemittance(input: RemittanceInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.remit", input.clientRequestId);
      if (existingId != null) {
        const rm = (await tx.select().from(deliveryRemittances).where(eq(deliveryRemittances.id, existingId)).limit(1))[0];
        return {
          remittanceId: existingId,
          remittanceNumber: rm?.remittanceNumber ?? "",
          collectedTotal: String(rm?.collectedTotal ?? "0"),
          feesTotal: String(rm?.feesTotal ?? "0"),
          netRemitted: String(rm?.netRemitted ?? "0"),
          shortfallTotal: String(rm?.shortfallTotal ?? "0"),
          status: rm?.status ?? "BALANCED",
          idempotentReplay: true as const,
        };
      }
    }
    if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "لا إرساليات للتسوية" });

    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });

    // المرور ١: قفل + تحقّق + حساب (بلا كتابة) — ترتيب أقفال الإرساليات تصاعدياً يمنع الجمود.
    type Work = { id: number; invoiceId: number; collected: Decimal; newCollected: Decimal; delivered: boolean; fee: Decimal; remaining: Decimal };
    const work: Work[] = [];
    let collectedTotal = new Decimal(0);
    let feesTotal = new Decimal(0);
    let expectedTotal = new Decimal(0);
    const sortedLines = [...input.lines].sort((a, b) => a.consignmentId - b.consignmentId);
    for (const line of sortedLines) {
      const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, line.consignmentId)).for("update").limit(1))[0];
      if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: `إرسالية ${line.consignmentId} غير موجودة` });
      if (Number(cn.partyId) !== input.partyId) throw new TRPCError({ code: "BAD_REQUEST", message: "إرسالية لجهة أخرى" });
      if (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL") throw new TRPCError({ code: "BAD_REQUEST", message: `إرسالية ${cn.consignmentNumber} غير قابلة للتسوية` });
      const collected = round2(money(line.collectedAmount));
      if (collected.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ سالب" });
      const remaining = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
      if (collected.gt(remaining)) throw new TRPCError({ code: "BAD_REQUEST", message: `أكثر من المتبقّي للإرسالية ${cn.consignmentNumber}` });
      const newCollected = round2(money(cn.collectedAmount).plus(collected));
      const delivered = newCollected.gte(money(cn.codAmount));
      const fee = delivered ? round2(money(cn.deliveryFee)) : new Decimal(0); // الأجرة تُحقَّق عند التسليم الكامل فقط
      work.push({ id: Number(cn.id), invoiceId: Number(cn.invoiceId), collected, newCollected, delivered, fee, remaining });
      collectedTotal = collectedTotal.plus(collected);
      feesTotal = feesTotal.plus(fee);
      expectedTotal = expectedTotal.plus(remaining);
    }
    collectedTotal = round2(collectedTotal);
    feesTotal = round2(feesTotal);
    const netRemitted = round2(collectedTotal.minus(feesTotal));
    const shortfallTotal = round2(round2(expectedTotal).minus(collectedTotal)); // عجز يبقى عهدة (D4)
    const status: "BALANCED" | "SHORT" | "OVER" = shortfallTotal.gt("0.01") ? "SHORT" : shortfallTotal.lt("-0.01") ? "OVER" : "BALANCED";

    // درج المُستلِم (RECEPTION افتراضياً): صافي النقد (collected − fee) يدخله فعلياً.
    const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, input.branchId, "توريد مندوب", input.shiftType ?? "RECEPTION");
    const remittanceNumber = await nextRemittanceNumber(tx, input.branchId);

    const rmRes = await tx.insert(deliveryRemittances).values({
      remittanceNumber,
      branchId: input.branchId,
      partyId: input.partyId,
      shiftId,
      collectedTotal: toDbMoney(collectedTotal),
      feesTotal: toDbMoney(feesTotal),
      netRemitted: toDbMoney(netRemitted),
      shortfallTotal: toDbMoney(shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal),
      status,
      receivedBy: actor.userId,
    });
    const remittanceId = extractInsertId(rmRes);

    // إيصال درج IN = COD المُحصَّل كاملاً (سلامة الفاتورة)، وOUT = الأجور (مصروف) ⇒ صافي الدرج = المورَّد.
    let receiptInId: number | null = null;
    let receiptOutId: number | null = null;
    if (collectedTotal.gt(0)) {
      const rIn = await tx.insert(receipts).values({
        branchId: input.branchId, shiftId, direction: "IN", amount: toDbMoney(collectedTotal),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", referenceNumber: remittanceNumber,
        partyType: "OTHER", description: `توريد تحصيلات مندوب ${remittanceNumber}`, createdBy: actor.userId,
      });
      receiptInId = extractInsertId(rIn);
    }
    if (feesTotal.gt(0)) {
      const rOut = await tx.insert(receipts).values({
        branchId: input.branchId, shiftId, direction: "OUT", amount: toDbMoney(feesTotal),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", referenceNumber: remittanceNumber,
        partyType: "OTHER", description: `أجور توصيل ${remittanceNumber}`, createdBy: actor.userId,
      });
      receiptOutId = extractInsertId(rOut);
    }
    await tx.update(deliveryRemittances).set({ receiptInId, receiptOutId }).where(eq(deliveryRemittances.id, remittanceId));

    // المرور ٢: تطبيق لكل إرسالية.
    for (const w of work) {
      const newStatus = w.delivered ? "DELIVERED" : "PARTIAL";
      await tx.update(deliveryConsignments).set({
        collectedAmount: toDbMoney(w.newCollected),
        status: newStatus,
        remittanceId,
        settledAt: w.delivered ? new Date() : null,
      }).where(eq(deliveryConsignments.id, w.id));

      if (w.collected.gt(0)) {
        // تسوية الفاتورة بالـCOD المُحصَّل كاملاً (PAYMENT_IN) — يربط إيصال IN الدفعة.
        await postEntry(tx, {
          entryType: "PAYMENT_IN", branchId: input.branchId, invoiceId: w.invoiceId, receiptId: receiptInId,
          amount: w.collected, notes: `توريد ${remittanceNumber}`,
        });
        const inv = (await tx.select({ total: invoices.total, paidAmount: invoices.paidAmount }).from(invoices).where(eq(invoices.id, w.invoiceId)).limit(1))[0];
        if (inv) {
          const newPaid = round2(money(inv.paidAmount).plus(w.collected));
          await tx.update(invoices).set({ paidAmount: toDbMoney(newPaid), status: computeInvoiceStatus(String(inv.total), toDbMoney(newPaid)), paymentDate: new Date() }).where(eq(invoices.id, w.invoiceId));
        }
        // خفض العهدة بالـCOD المُحصَّل كاملاً (الأجرة netting لا تَمسّ العهدة).
        await adjustDeliveryBalance(tx, input.partyId, w.collected.neg());
        await postEntry(tx, {
          entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_REMIT:${w.id}:${remittanceId}`,
          branchId: input.branchId, invoiceId: w.invoiceId, deliveryPartyId: input.partyId, amount: w.collected,
        });
      }
      // مصروف الأجرة عند التسليم الكامل (cost-only؛ يربط إيصال OUT الدفعة).
      if (w.fee.gt(0)) {
        await postEntry(tx, {
          entryType: "DELIVERY_FEE", branchId: input.branchId, invoiceId: w.invoiceId, receiptId: receiptOutId,
          deliveryPartyId: input.partyId, amount: w.fee, cost: w.fee, profit: w.fee.neg(),
          notes: `أجرة توصيل ${remittanceNumber}`,
        });
      }
    }

    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.remit", input.clientRequestId, remittanceId);
    return {
      remittanceId, remittanceNumber,
      collectedTotal: collectedTotal.toFixed(2), feesTotal: feesTotal.toFixed(2),
      netRemitted: netRemitted.toFixed(2), shortfallTotal: (shortfallTotal.lt(0) ? new Decimal(0) : shortfallTotal).toFixed(2),
      status,
    };
  });
}

/** إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون. مقيَّد بـDISPATCHED (collected==0). */
export async function returnConsignment(consignmentId: number, actor: DeliveryTxActor & { clientRequestId?: string | null }) {
  return withTx(async (tx) => {
    if (actor.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.return", actor.clientRequestId);
      if (existingId != null) return { consignmentId, reversed: true as const, idempotentReplay: true as const };
    }
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (cn.status !== "DISPATCHED") throw new TRPCError({ code: "BAD_REQUEST", message: "يُرجَع فقط إرسالٌ لم يُحصَّل منه شيء (للجزئي استعمل المرتجعات)" });
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, Number(cn.partyId))).for("update").limit(1))[0];
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });

    const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, Number(cn.invoiceId)));
    // إعادة المخزون (حركة IN) لكل بند له صنف.
    for (const it of items) {
      await applyMovement(tx, {
        variantId: Number(it.variantId), branchId: Number(cn.branchId), baseQuantity: Number(it.baseQuantity),
        movementType: "IN", referenceType: "DELIVERY_RETURN", referenceId: consignmentId, createdBy: actor.userId,
      });
    }

    // عكس البيع: قيد RETURN بقيم سالبة (لا AR — customerId=NULL على فاتورة COD).
    const total = money(inv.total);
    const costTotal = money(inv.costTotal);
    await postEntry(tx, {
      entryType: "RETURN", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
      revenue: total.neg(), cost: costTotal.neg(), profit: round2(total.minus(costTotal)).neg(), amount: total.neg(),
      notes: `إرجاع إرسالية ${cn.consignmentNumber}`,
    });
    await tx.update(invoices).set({ status: "RETURNED", returnedTotal: toDbMoney(total) }).where(eq(invoices.id, Number(cn.invoiceId)));

    // عكس العهدة بالـCOD القائم (collected==0 ⇒ = codAmount).
    const outstanding = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
    if (outstanding.gt(0)) {
      await adjustDeliveryBalance(tx, Number(cn.partyId), outstanding.neg());
      await postEntry(tx, {
        entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_RETURN:${consignmentId}`,
        branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId), deliveryPartyId: Number(cn.partyId),
        amount: outstanding, notes: `عكس عهدة — إرجاع ${cn.consignmentNumber}`,
      });
    }

    // رد العربون نقداً إن وُجد (paidAmount على فاتورة COD = العربون).
    const deposit = round2(money(inv.paidAmount));
    if (deposit.gt(0)) {
      const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, Number(cn.branchId), "رد عربون إرجاع", "RECEPTION");
      const rOut = await tx.insert(receipts).values({
        branchId: Number(cn.branchId), shiftId, direction: "OUT", amount: toDbMoney(deposit),
        paymentMethod: "CASH", cashBucket, status: "COMPLETED", invoiceId: Number(cn.invoiceId),
        referenceNumber: `RET-${cn.consignmentNumber}`, description: `رد عربون إرجاع ${cn.consignmentNumber}`, createdBy: actor.userId,
      });
      await postEntry(tx, {
        entryType: "PAYMENT_OUT", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        receiptId: extractInsertId(rOut), amount: deposit, notes: `رد عربون ${cn.consignmentNumber}`,
      });
      await tx.update(invoices).set({ paidAmount: "0.00" }).where(eq(invoices.id, Number(cn.invoiceId)));
    }

    await tx.update(deliveryConsignments).set({ status: "RETURNED", settledAt: new Date() }).where(eq(deliveryConsignments.id, consignmentId));
    if (actor.clientRequestId) await recordIdempotencyKey(tx, "delivery.return", actor.clientRequestId, consignmentId);
    void party;
    return { consignmentId, reversed: true as const, invoiceId: Number(cn.invoiceId) };
  });
}

/** تسوية عهدة: الجهة تدفع نقداً لخفض رصيدها (مثل عجز سُوّي لاحقاً). */
export interface SettleInput {
  branchId: number;
  partyId: number;
  amount: string;
  shiftType?: "RECEPTION" | "RETAIL";
  notes?: string | null;
  clientRequestId?: string | null;
}
export async function settleDeliveryBalance(input: SettleInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.settle", input.clientRequestId);
      if (existingId != null) return { receiptId: existingId, idempotentReplay: true as const };
    }
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    const amount = round2(money(input.amount));
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    const { shiftId, cashBucket } = await shiftIdForCashTx(tx, { userId: actor.userId, branchId: actor.branchId ?? undefined, role: actor.role }, input.branchId, "تسوية عهدة مندوب", input.shiftType ?? "RECEPTION");
    const rIn = await tx.insert(receipts).values({
      branchId: input.branchId, shiftId, direction: "IN", amount: toDbMoney(amount),
      paymentMethod: "CASH", cashBucket, status: "COMPLETED", partyType: "OTHER",
      referenceNumber: `DLV-SETTLE-${input.partyId}`, description: input.notes ?? `تسوية عهدة جهة توصيل #${input.partyId}`, createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rIn);
    await adjustDeliveryBalance(tx, input.partyId, amount.neg());
    await postEntry(tx, {
      entryType: "DELIVERY_REMIT", dedupeKey: `DELIVERY_SETTLE:${receiptId}`,
      branchId: input.branchId, deliveryPartyId: input.partyId, receiptId, amount, notes: "تسوية عهدة جهة توصيل",
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.settle", input.clientRequestId, receiptId);
    return { receiptId, partyBalanceAfter: round2(money(party.currentBalance).minus(amount)).toFixed(2) };
  });
}

/** شطب عجز عهدة كمصروف (مدير فقط، بلا نقد). */
export interface WriteOffInput {
  branchId: number;
  partyId: number;
  amount: string;
  reason: string;
  clientRequestId?: string | null;
}
export async function writeOffDeliveryShortfall(input: WriteOffInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "delivery.writeoff", input.clientRequestId);
      if (existingId != null) return { partyId: input.partyId, idempotentReplay: true as const };
    }
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party) throw new TRPCError({ code: "NOT_FOUND", message: "جهة التوصيل غير موجودة" });
    const amount = round2(money(input.amount));
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });
    if (amount.gt(round2(money(party.currentBalance)))) throw new TRPCError({ code: "BAD_REQUEST", message: "الشطب يتجاوز العهدة القائمة" });
    if (!input.reason || input.reason.trim().length < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الشطب مطلوب" });

    await adjustDeliveryBalance(tx, input.partyId, amount.neg());
    // شطبٌ بلا نقد: خسارة فقط (cost-only) ⇒ لا إيصال درج (Z-report والصندوق لا يتأثّران).
    await postEntry(tx, {
      entryType: "DELIVERY_WRITEOFF", branchId: input.branchId, deliveryPartyId: input.partyId,
      amount, cost: amount, profit: amount.neg(), notes: `شطب عهدة: ${input.reason.trim()}`,
    });
    if (input.clientRequestId) await recordIdempotencyKey(tx, "delivery.writeoff", input.clientRequestId, input.partyId);
    return { partyId: input.partyId, partyBalanceAfter: round2(money(party.currentBalance).minus(amount)).toFixed(2) };
  });
}

// ───────────────────────── قراءات الشاشة ─────────────────────────

/** أوامر الشغل الجاهزة (READY) القابلة للإرسال عبر مندوب — تبويب «جاهز للإرسال». */
export async function listReadyForDispatch(branchId: number | null) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(workOrders.status, "READY")];
  if (branchId != null) conds.push(eq(workOrders.branchId, branchId));
  return db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      title: workOrders.title,
      salePrice: workOrders.salePrice,
      deposit: workOrders.deposit,
      branchId: workOrders.branchId,
      customerId: workOrders.customerId,
      customerName: customers.name,
      deliveryAddress: workOrders.deliveryAddress,
      hasDelivery: workOrders.hasDelivery,
      dueDate: workOrders.dueDate,
    })
    .from(workOrders)
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .where(and(...conds))
    .orderBy(desc(workOrders.id))
    .limit(200);
}

/** الإرساليات المفتوحة (DISPATCHED/PARTIAL) لجهة — لشاشة التسوية. */
export async function listOpenConsignments(partyId: number) {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      deliveryFee: deliveryConsignments.deliveryFee,
      status: deliveryConsignments.status,
      endCustomerId: deliveryConsignments.endCustomerId,
      customerName: customers.name,
      recipientName: deliveryConsignments.recipientName,
      dispatchedAt: deliveryConsignments.dispatchedAt,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .where(and(eq(deliveryConsignments.partyId, partyId), sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`))
    .orderBy(deliveryConsignments.dispatchedAt);
}

/** كل إرساليات جهة (تبويب «قيد التوصيل» / تفاصيل الجهة). */
export async function listConsignmentsForParty(partyId: number, openOnly = false) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(deliveryConsignments.partyId, partyId)];
  if (openOnly) conds.push(sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`);
  return db.select().from(deliveryConsignments).where(and(...conds)).orderBy(desc(deliveryConsignments.id)).limit(300);
}

/** كشف حساب جهة توصيل: قيود العهدة (DISPATCH مدين، REMIT/WRITEOFF دائن) + أجور (FEE). */
export async function getDeliveryPartyStatement(partyId: number, from?: string, to?: string) {
  const db = getDb();
  if (!db) return null;
  const party = (await db.select().from(deliveryParties).where(eq(deliveryParties.id, partyId)).limit(1))[0];
  if (!party) return null;
  const conds = [
    eq(accountingEntries.deliveryPartyId, partyId),
    sql`${accountingEntries.entryType} IN ('DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_WRITEOFF','DELIVERY_FEE')`,
  ];
  if (from) conds.push(sql`${accountingEntries.entryDate} >= ${from}`);
  if (to) conds.push(sql`${accountingEntries.entryDate} <= ${to}`);
  const entries = await db
    .select({
      id: accountingEntries.id,
      type: accountingEntries.entryType,
      amount: accountingEntries.amount,
      entryDate: accountingEntries.entryDate,
      notes: accountingEntries.notes,
    })
    .from(accountingEntries)
    .where(and(...conds))
    .orderBy(accountingEntries.id);
  return {
    party: { name: party.name, partyType: party.partyType, phone: party.phone },
    currentBalance: party.currentBalance,
    entries,
  };
}
