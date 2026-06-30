// خدمة «الصيرفة» (الصرّاف / مكتب التحويل) — exchange-house (٣٠/٦).
// ───────────────────────────────────────────────────────────────────────────────────────
// اتفاقية الإشارة على المحفظتين (balanceIqd / balanceUsd): موجب = الصيرفة مدينة لنا (أموالنا لديها).
//   نظير deliveryParties (عهدة) — **معاكسة عمداً** لاتفاقية suppliers. وثّقها هنا حصراً.
// المبادئ المحاسبية (مُثبَتة بالتحقّق العدائي ٧ وكلاء):
//   • الإيداع/السحب نقلُ أصلٍ (receipt على TREASURY + قيد 0/0/0، مُستثنى من الإيراد) — لا مصروف.
//   • شراء الدولار (FX_BUY) تحويلُ أصلٍ داخل الصيرفة (دينار→دولار) يُحدّث متوسط الكلفة WAVG — بلا P&L.
//   • التسديد عبر الصيرفة **لا يمسّ الخزينة** (النقد غادر عند الإيداع): يخفض المحفظة + دين المورد فقط.
//   • فرق الصرف المحقَّق = (الدين الديناري المُطفأ) − (الدولار المدفوع × متوسط كلفته) ⇒ قيد EXCHANGE_FX_DIFF
//     معزول (amount موقَّع، revenue=cost=profit=0) — لا يلوّث إيراد البيع.
//   • العمولة مصروف (EXCHANGE_FEE، cost=amount) تُخصم من المحفظة — لا من دين المورد ولا من تكلفة الشراء.
// الأمان: كل عملية داخل withTx واحدة؛ قفل صفّ الصيرفة .for("update") قبل أي خصم (يمنع TOCTOU/سباق)؛
//   idempotency (clientRequestId) يُسجَّل قبل أي adjust؛ منع المكشوف بتحذير لين قابل للتجاوز (confirmNegative).

import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { branches, exchangeHouses, exchangeTransactions, receipts, suppliers } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import {
  adjustExchangeBalanceIqd,
  adjustExchangeBalanceUsd,
  adjustSupplierBalance,
  postEntry,
} from "./ledgerService";
import { money, round2, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

/** تسلسل لسعر صرف بمنزلتين أربع (decimal(15,4)). */
const toDbRate = (x: Decimal): string => x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

/** قفل صفّ الصيرفة وقراءته (يجب أن يسبق أي خصم لمنع السباق). */
async function lockHouse(tx: Tx, exchangeHouseId: number) {
  const rows = await tx
    .select()
    .from(exchangeHouses)
    .where(eq(exchangeHouses.id, exchangeHouseId))
    .for("update")
    .limit(1);
  const h = rows[0];
  if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "الصيرفة غير موجودة" });
  if (!h.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الصيرفة معطَّلة" });
  return h;
}

/** توليد رقم عملية صيرفة فريد لكل (فرع×يوم): EX-{branch}-{YYYYMMDD}-{seq}. تحت GET_LOCK لمنع السباق. */
async function nextTxnNumber(tx: Tx, branchId: number | null): Promise<string> {
  const b = branchId ?? 0;
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `EX-${b}-${ymd}-`;
  const lockName = `exchange_txn:${b}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`exchange numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: exchangeTransactions.txnNumber })
      .from(exchangeTransactions)
      .where(like(exchangeTransactions.txnNumber, `${prefix}%`))
      .orderBy(desc(exchangeTransactions.id))
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(5, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/* ════════════════════════════ CRUD ════════════════════════════ */

export interface CreateExchangeInput {
  name: string;
  phone?: string | null;
  phone2?: string | null;
  legacyCode?: string | null;
  notes?: string | null;
  /** رصيد افتتاحي موقَّع (موجب = لنا عندها). */
  openingBalanceIqd?: string | null;
  openingBalanceUsd?: string | null;
  /** متوسط كلفة الدولار للرصيد الافتتاحي الدولاري (دينار/دولار). */
  openingUsdRate?: string | null;
}

export async function createExchangeHouse(input: CreateExchangeInput, actor: Actor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    const res = await tx.insert(exchangeHouses).values({
      name: input.name.trim(),
      phone: input.phone ?? null,
      phone2: input.phone2 ?? null,
      legacyCode: input.legacyCode?.trim() || null,
      notes: input.notes ?? null,
      isActive: true,
      balanceIqd: "0.00",
      balanceUsd: "0.00",
      usdCostRate: "0.0000",
    });
    const id = extractInsertId(res);

    const openIqd = round2(input.openingBalanceIqd ?? 0);
    const openUsd = round2(input.openingBalanceUsd ?? 0);
    if (!openIqd.isZero() || !openUsd.isZero()) {
      const openRate = money(input.openingUsdRate ?? 0);
      if (!openUsd.isZero() && openRate.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "يلزم سعر صرف موجب للرصيد الافتتاحي الدولاري" });
      }
      // ترحيل الرصيد عبر adjust فقط (لا set مباشر) + سعر الكلفة الافتتاحي للمحفظة الدولارية.
      if (!openUsd.isZero()) {
        await tx.update(exchangeHouses).set({ usdCostRate: toDbRate(openRate) }).where(eq(exchangeHouses.id, id));
      }
      await adjustExchangeBalanceIqd(tx, id, openIqd);
      await adjustExchangeBalanceUsd(tx, id, openUsd);

      const txnNumber = await nextTxnNumber(tx, actor.branchId ?? null);
      await tx.insert(exchangeTransactions).values({
        txnNumber,
        exchangeHouseId: id,
        branchId: actor.branchId || null,
        type: "OPENING",
        currency: "IQD",
        iqdAmount: toDbMoney(openIqd),
        usdAmount: toDbMoney(openUsd),
        exchangeRate: toDbRate(openRate),
        balanceIqdAfter: toDbMoney(openIqd),
        balanceUsdAfter: toDbMoney(openUsd),
        status: "ACTIVE",
        notes: "رصيد افتتاحي",
        createdBy: actor.userId,
      });

      // قيد OPENING بقيمة دينارية معادِلة (دينار + دولار×سعر). dedupeKey فريد ⇒ لا تكرار رصيد.
      const openingIqdValue = openIqd.plus(openUsd.times(openRate));
      await postEntry(tx, {
        entryType: "OPENING",
        branchId: actor.branchId || null,
        exchangeHouseId: id,
        amount: round2(openingIqdValue),
        entryDate: new Date(),
        dedupeKey: `OPENING:EXCHANGE:${id}`,
        notes: "رصيد افتتاحي صيرفة",
      });
    }
    return { id };
  });
}

export interface UpdateExchangeInput {
  id: number;
  name?: string;
  phone?: string | null;
  phone2?: string | null;
  legacyCode?: string | null;
  notes?: string | null;
}

export async function updateExchangeHouse(input: UpdateExchangeInput, _actor: Actor): Promise<{ id: number }> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB" });
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.phone2 !== undefined) patch.phone2 = input.phone2;
  if (input.legacyCode !== undefined) patch.legacyCode = input.legacyCode?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes;
  // ⛔ لا يُسمح بتعديل الرصيد/سعر الكلفة يدوياً — يُحرَّك بالعمليات فقط (deposit/buyUsd/settle/withdraw).
  if (Object.keys(patch).length > 0) {
    await db.update(exchangeHouses).set(patch).where(eq(exchangeHouses.id, input.id));
  }
  return { id: input.id };
}

export async function setExchangeActive(id: number, isActive: boolean, _actor: Actor): Promise<{ id: number }> {
  // قفل الصفّ ثم الفحص ثم التحديث في معاملة واحدة (TOCTOU): إيداع متزامن بين فحصٍ غير مقفول والتحديث
  // كان قد يُعطّل محفظةً صارت غير صفرية. الآن FOR UPDATE يُسلسل العملية.
  return withTx(async (tx) => {
    const rows = await tx.select().from(exchangeHouses).where(eq(exchangeHouses.id, id)).for("update").limit(1);
    const h = rows[0];
    if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "الصيرفة غير موجودة" });
    // حماية: لا تُعطَّل صيرفة برصيد ≠ صفر (مال معلّق لدى/على الطرف).
    if (!isActive && (!money(h.balanceIqd).isZero() || !money(h.balanceUsd).isZero())) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن تعطيل صيرفة برصيد غير صفري — سوِّ الرصيد أولاً",
      });
    }
    await tx.update(exchangeHouses).set({ isActive }).where(eq(exchangeHouses.id, id));
    return { id };
  });
}

export async function getExchangeHouse(id: number) {
  const db = getDb();
  if (!db) return null;
  const rows = await db.select().from(exchangeHouses).where(eq(exchangeHouses.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface ListExchangeInput {
  q?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listExchangeHouses(input: ListExchangeInput = {}) {
  const db = getDb();
  if (!db) return [];
  const limit = input.limit && input.limit > 0 && input.limit <= 200 ? input.limit : 50;
  const offset = input.offset && input.offset >= 0 ? input.offset : 0;
  const conds = [];
  if (input.activeOnly) conds.push(eq(exchangeHouses.isActive, true));
  if (input.q && input.q.trim()) {
    const q = `%${input.q.trim().replace(/[%_!]/g, (m) => "!" + m)}%`;
    conds.push(
      or(
        like(exchangeHouses.name, sql`${q} ESCAPE '!'`),
        like(exchangeHouses.phone, sql`${q} ESCAPE '!'`),
        like(exchangeHouses.legacyCode, sql`${q} ESCAPE '!'`),
      ),
    );
  }
  const where = conds.length > 0 ? and(...conds) : undefined;
  const rows = await db
    .select()
    .from(exchangeHouses)
    .where(where)
    .orderBy(desc(exchangeHouses.id))
    .limit(limit)
    .offset(offset);
  return rows;
}

/* ════════════════════════════ العمليات المالية ════════════════════════════ */

export interface DepositInput {
  exchangeHouseId: number;
  branchId: number;
  amount: string; // دينار
  notes?: string | null;
  clientRequestId?: string | null;
}

/** إيداع نقد (دينار) من خزينة الفرع → محفظة الصيرفة (نقل أصل، 0/0/0). */
export async function depositToExchange(input: DepositInput, actor: Actor): Promise<{ txnId: number; txnNumber: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.deposit", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "" };
      }
    }
    const amount = round2(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    const house = await lockHouse(tx, input.exchangeHouseId);

    // receipt OUT TREASURY — نقد فعلي يغادر خزينة الفرع.
    const recRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId: null,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      partyType: "OTHER",
      description: `إيداع لدى الصيرفة «${house.name}»`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(recRes);

    await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, amount);
    const balIqdAfter = money(house.balanceIqd).plus(amount);
    const balUsdAfter = money(house.balanceUsd);

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "DEPOSIT",
      currency: "IQD",
      iqdAmount: toDbMoney(amount),
      balanceIqdAfter: toDbMoney(balIqdAfter),
      balanceUsdAfter: toDbMoney(balUsdAfter),
      receiptId,
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    await postEntry(tx, {
      entryType: "EXCHANGE_DEPOSIT",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      receiptId,
      amount,
      dedupeKey: `EXDEP:${txnNumber}`,
      notes: input.notes ?? undefined,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.deposit", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber };
  });
}

export interface WithdrawInput {
  exchangeHouseId: number;
  branchId: number;
  amount: string; // دينار
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** سحب نقد (دينار) من محفظة الصيرفة → خزينة الفرع (عكس الإيداع، 0/0/0). */
export async function withdrawFromExchange(input: WithdrawInput, actor: Actor): Promise<{ txnId: number; txnNumber: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.withdraw", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "" };
      }
    }
    const amount = round2(input.amount);
    if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يجب أن يكون موجباً" });

    const house = await lockHouse(tx, input.exchangeHouseId);
    const availIqd = money(house.balanceIqd);
    if (amount.gt(availIqd) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `رصيد الدينار لدى الصيرفة ${availIqd.toFixed(2)} أقلّ من المطلوب ${amount.toFixed(2)}. أرسل confirmNegative=true للتجاوز.`,
      });
    }

    const recRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId: null,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      partyType: "OTHER",
      description: `سحب من الصيرفة «${house.name}»`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(recRes);

    await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, amount.negated());
    const balIqdAfter = availIqd.minus(amount);
    const balUsdAfter = money(house.balanceUsd);

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "WITHDRAW",
      currency: "IQD",
      iqdAmount: toDbMoney(amount),
      balanceIqdAfter: toDbMoney(balIqdAfter),
      balanceUsdAfter: toDbMoney(balUsdAfter),
      receiptId,
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    await postEntry(tx, {
      entryType: "EXCHANGE_WITHDRAW",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      receiptId,
      amount,
      dedupeKey: `EXWD:${txnNumber}`,
      notes: input.notes ?? undefined,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.withdraw", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber };
  });
}

export interface BuyUsdInput {
  exchangeHouseId: number;
  branchId: number;
  usdAmount: string;
  exchangeRate: string; // دينار/دولار
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** شراء دولار من الصيرفة: تحويل دينار→دولار داخل المحفظة بسعر r، يُحدّث متوسط الكلفة WAVG (نقل أصل، 0/0/0). */
export async function buyUsdAtExchange(input: BuyUsdInput, actor: Actor): Promise<{ txnId: number; txnNumber: string; newRate: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.buyUsd", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "", newRate: "" };
      }
    }
    const usd = round2(input.usdAmount);
    const rate = money(input.exchangeRate);
    if (usd.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الدولار يجب أن يكون موجباً" });
    if (rate.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "سعر الصرف يجب أن يكون موجباً" });

    const iqdSpent = round2(usd.times(rate));
    const house = await lockHouse(tx, input.exchangeHouseId);
    const availIqd = money(house.balanceIqd);
    if (iqdSpent.gt(availIqd) && !input.confirmNegative) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `رصيد الدينار ${availIqd.toFixed(2)} أقلّ من كلفة الشراء ${iqdSpent.toFixed(2)}. أرسل confirmNegative=true للتجاوز.`,
      });
    }

    // متوسط الكلفة المرجّح الجديد: (قيمة الدولار القديم بالكلفة + الدينار المنفَق) / (الدولار الجديد).
    const oldUsd = money(house.balanceUsd);
    const oldRate = money(house.usdCostRate);
    const newUsd = oldUsd.plus(usd);
    const newCostBasisIqd = oldUsd.times(oldRate).plus(iqdSpent);
    const newRate = newUsd.isZero() ? new Decimal(0) : newCostBasisIqd.div(newUsd);

    await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, iqdSpent.negated());
    await adjustExchangeBalanceUsd(tx, input.exchangeHouseId, usd);
    await tx.update(exchangeHouses).set({ usdCostRate: toDbRate(newRate) }).where(eq(exchangeHouses.id, input.exchangeHouseId));

    const balIqdAfter = availIqd.minus(iqdSpent);
    const balUsdAfter = newUsd;

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "FX_BUY",
      currency: "USD",
      iqdAmount: toDbMoney(iqdSpent),
      usdAmount: toDbMoney(usd),
      exchangeRate: toDbRate(rate),
      balanceIqdAfter: toDbMoney(balIqdAfter),
      balanceUsdAfter: toDbMoney(balUsdAfter),
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    await postEntry(tx, {
      entryType: "EXCHANGE_FX_BUY",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      amount: iqdSpent,
      dedupeKey: `EXFXB:${txnNumber}`,
      notes: `شراء ${usd.toFixed(2)}$ بسعر ${rate.toFixed(2)}`,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.buyUsd", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, newRate: toDbRate(newRate) };
  });
}

export interface SettleSupplierInput {
  exchangeHouseId: number;
  branchId: number;
  supplierId: number;
  currency: "USD" | "IQD";
  /** المبلغ المخصوم من المحفظة (المبدأ) بعملة المحفظة. */
  walletAmount: string;
  /** الدين الديناري المُطفأ من ذمّة المورد. */
  settledIqd: string;
  /** عمولة الصيرفة بعملة المحفظة (تُخصم من المحفظة، مصروف). */
  commission?: string | null;
  /** سعر الصرف وقت التسديد (للتدقيق، عملة USD). */
  exchangeRate?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
  confirmNegative?: boolean;
}

/** تسديد ذمّة مورد عبر الصيرفة. يخفض المحفظة (مبدأ+عمولة) ودين المورد؛ يُسجّل فرق الصرف والعمولة.
 *  ⚠️ لا يمسّ الخزينة (النقد غادر عند الإيداع). فرق الصرف = settledIqd − (walletAmount بالدينار بالكلفة). */
export async function settleSupplierViaExchange(
  input: SettleSupplierInput,
  actor: Actor,
): Promise<{ txnId: number; txnNumber: string; fxDiff: string }> {
  return withTx(async (tx) => {
    if (input.clientRequestId) {
      const existing = await findIdempotentRefId(tx, "exchange.settle", input.clientRequestId);
      if (existing != null) {
        const t = (await tx.select().from(exchangeTransactions).where(eq(exchangeTransactions.id, existing)).limit(1))[0];
        return { txnId: existing, txnNumber: t?.txnNumber ?? "", fxDiff: t?.fxDiff ?? "0.00" };
      }
    }
    const walletAmount = round2(input.walletAmount);
    const settledIqd = round2(input.settledIqd);
    const commission = round2(input.commission ?? 0);
    if (walletAmount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ التسديد يجب أن يكون موجباً" });
    if (settledIqd.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الدين المُسوّى يجب أن يكون موجباً" });
    if (commission.isNegative()) throw new TRPCError({ code: "BAD_REQUEST", message: "العمولة لا تكون سالبة" });

    const supplier = (await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1))[0];
    if (!supplier) throw new TRPCError({ code: "BAD_REQUEST", message: "المورد غير موجود" });

    const house = await lockHouse(tx, input.exchangeHouseId);
    const usdRate = money(house.usdCostRate);

    let walletCostIqd: Decimal;
    let commissionIqd: Decimal;
    let usdAmountCol = new Decimal(0);
    let iqdAmountCol = settledIqd;

    if (input.currency === "USD") {
      if (usdRate.lte(0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد رصيد دولاري بكلفة معروفة — اشترِ دولاراً أولاً" });
      }
      walletCostIqd = round2(walletAmount.times(usdRate));
      commissionIqd = round2(commission.times(usdRate));
      const totalUsdOut = walletAmount.plus(commission);
      const availUsd = money(house.balanceUsd);
      if (totalUsdOut.gt(availUsd) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `رصيد الدولار ${availUsd.toFixed(2)}$ أقلّ من المطلوب ${totalUsdOut.toFixed(2)}$. أرسل confirmNegative=true للتجاوز.`,
        });
      }
      await adjustExchangeBalanceUsd(tx, input.exchangeHouseId, totalUsdOut.negated());
      usdAmountCol = walletAmount;
    } else {
      // بالدينار لا صرف عملة ⇒ المسحوب من المحفظة = الدين المُسوّى. حارس ضدّ تباين يُنتج fxDiff وهمياً
      // ويُفسد إجمالي «المُسدَّد» في الكشف (الكشف يجمع iqdAmount لصفوف SETTLE). الواجهة تُرسلهما متساويَين.
      if (!walletAmount.eq(settledIqd)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "للتسديد بالدينار يجب تساوي المبلغ المسحوب والدين المُسوّى" });
      }
      walletCostIqd = walletAmount;
      commissionIqd = commission;
      const totalIqdOut = walletAmount.plus(commission);
      const availIqd = money(house.balanceIqd);
      if (totalIqdOut.gt(availIqd) && !input.confirmNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `رصيد الدينار ${availIqd.toFixed(2)} أقلّ من المطلوب ${totalIqdOut.toFixed(2)}. أرسل confirmNegative=true للتجاوز.`,
        });
      }
      await adjustExchangeBalanceIqd(tx, input.exchangeHouseId, totalIqdOut.negated());
      // iqdAmountCol يبقى = settledIqd (= walletAmount) ⇒ إجمالي الكشف صحيح بلا fxDiff وهميّ.
    }

    // فرق الصرف المحقَّق = الدين المُطفأ − كلفة ما خرج من المحفظة (بلا العمولة).
    const fxDiff = settledIqd.minus(walletCostIqd);

    // إطفاء دين المورد (التسديد الفعلي — هنا فقط).
    await adjustSupplierBalance(tx, input.supplierId, settledIqd.negated());

    // قراءة الرصيد بعد كل الخصومات (لقطة الكشف).
    const after = (await tx.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];

    const txnNumber = await nextTxnNumber(tx, input.branchId);
    const txRes = await tx.insert(exchangeTransactions).values({
      txnNumber,
      exchangeHouseId: input.exchangeHouseId,
      branchId: input.branchId,
      type: "SETTLE",
      currency: input.currency,
      iqdAmount: toDbMoney(iqdAmountCol),
      usdAmount: toDbMoney(usdAmountCol),
      exchangeRate: input.currency === "USD" ? toDbRate(money(input.exchangeRate ?? usdRate)) : "0.0000",
      commission: toDbMoney(commission),
      commissionIqd: toDbMoney(commissionIqd),
      fxDiff: toDbMoney(fxDiff),
      supplierId: input.supplierId,
      balanceIqdAfter: after ? toDbMoney(money(after.balanceIqd)) : "0.00",
      balanceUsdAfter: after ? toDbMoney(money(after.balanceUsd)) : "0.00",
      status: "ACTIVE",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const txnId = extractInsertId(txRes);

    // قيد التسديد (0/0/0 — حركة إطفاء ذمّة، مُستثناة من الإيراد).
    await postEntry(tx, {
      entryType: "EXCHANGE_SETTLE",
      branchId: input.branchId,
      exchangeHouseId: input.exchangeHouseId,
      supplierId: input.supplierId,
      amount: settledIqd,
      dedupeKey: `EXSET:${txnNumber}`,
      notes: `تسديد مورد «${supplier.name}» عبر الصيرفة`,
    });

    // فرق الصرف المحقَّق (amount موقَّع، معزول عن إيراد البيع).
    if (!fxDiff.isZero()) {
      await postEntry(tx, {
        entryType: "EXCHANGE_FX_DIFF",
        branchId: input.branchId,
        exchangeHouseId: input.exchangeHouseId,
        supplierId: input.supplierId,
        amount: fxDiff,
        dedupeKey: `EXFX:${txnNumber}`,
        notes: fxDiff.isPositive() ? "مكسب صرف محقَّق" : "خسارة صرف محقَّقة",
      });
    }

    // العمولة مصروف (cost=amount، profit سالب) — تظهر في P&L والكشف.
    if (commissionIqd.gt(0)) {
      await postEntry(tx, {
        entryType: "EXCHANGE_FEE",
        branchId: input.branchId,
        exchangeHouseId: input.exchangeHouseId,
        supplierId: input.supplierId,
        amount: commissionIqd,
        cost: commissionIqd,
        profit: commissionIqd.negated(),
        dedupeKey: `EXFEE:${txnNumber}`,
        notes: "عمولة صيرفة",
      });
    }

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "exchange.settle", input.clientRequestId, txnId);
    }
    return { txnId, txnNumber, fxDiff: toDbMoney(fxDiff) };
  });
}

/* ════════════════════════════ كشف الحساب + المطابقة ════════════════════════════ */

export interface StatementInput {
  exchangeHouseId: number;
  from?: string; // YYYY-MM-DD
  to?: string;
}

export async function getExchangeStatement(input: StatementInput) {
  const db = getDb();
  if (!db) return null;
  const house = (await db.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];
  if (!house) return null;

  const conds = [eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId)];
  if (input.from) conds.push(gte(exchangeTransactions.createdAt, new Date(input.from + "T00:00:00Z")));
  if (input.to) conds.push(lte(exchangeTransactions.createdAt, new Date(input.to + "T23:59:59Z")));

  const txns = await db
    .select()
    .from(exchangeTransactions)
    .where(and(...conds))
    .orderBy(exchangeTransactions.createdAt, exchangeTransactions.id);

  let totalDepositIqd = new Decimal(0);
  let totalWithdrawIqd = new Decimal(0);
  let totalSettledIqd = new Decimal(0);
  let totalFeesIqd = new Decimal(0);
  let totalFxDiff = new Decimal(0);
  let totalUsdBought = new Decimal(0);
  for (const t of txns) {
    if (t.type === "DEPOSIT") totalDepositIqd = totalDepositIqd.plus(money(t.iqdAmount));
    if (t.type === "WITHDRAW") totalWithdrawIqd = totalWithdrawIqd.plus(money(t.iqdAmount));
    if (t.type === "FX_BUY") totalUsdBought = totalUsdBought.plus(money(t.usdAmount));
    if (t.type === "SETTLE") totalSettledIqd = totalSettledIqd.plus(money(t.iqdAmount));
    totalFeesIqd = totalFeesIqd.plus(money(t.commissionIqd));
    totalFxDiff = totalFxDiff.plus(money(t.fxDiff));
  }

  return {
    house: {
      id: Number(house.id),
      name: house.name,
      balanceIqd: house.balanceIqd,
      balanceUsd: house.balanceUsd,
      usdCostRate: house.usdCostRate,
    },
    transactions: txns.map((t) => ({
      id: Number(t.id),
      txnNumber: t.txnNumber,
      type: t.type,
      currency: t.currency,
      iqdAmount: t.iqdAmount,
      usdAmount: t.usdAmount,
      exchangeRate: t.exchangeRate,
      commission: t.commission,
      commissionIqd: t.commissionIqd,
      fxDiff: t.fxDiff,
      supplierId: t.supplierId ? Number(t.supplierId) : null,
      balanceIqdAfter: t.balanceIqdAfter,
      balanceUsdAfter: t.balanceUsdAfter,
      status: t.status,
      notes: t.notes,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
    })),
    summary: {
      totalDepositIqd: toDbMoney(totalDepositIqd),
      totalWithdrawIqd: toDbMoney(totalWithdrawIqd),
      totalSettledIqd: toDbMoney(totalSettledIqd),
      totalFeesIqd: toDbMoney(totalFeesIqd),
      totalFxDiff: toDbMoney(totalFxDiff),
      totalUsdBought: toDbMoney(totalUsdBought),
      currentBalanceIqd: house.balanceIqd,
      currentBalanceUsd: house.balanceUsd,
    },
  };
}

export interface ReconcileInput {
  exchangeHouseId: number;
  statedBalanceIqd: string;
  statedBalanceUsd: string;
  asOfDate?: string; // YYYY-MM-DD
}

/** مطابقة أرصدة: تقارن رصيدنا الدفتري (حتى تاريخ القطع) برصيد كشف الصيرفة، وتُظهر البنود المعلّقة.
 *  قراءة فقط — أي فرق حقيقي يُسوّى لاحقاً بقيد تصحيح يدوي صريح (لا تسوية صامتة). */
export async function reconcileExchange(input: ReconcileInput) {
  const db = getDb();
  if (!db) return null;
  const house = (await db.select().from(exchangeHouses).where(eq(exchangeHouses.id, input.exchangeHouseId)).limit(1))[0];
  if (!house) return null;

  let ourIqd = money(house.balanceIqd);
  let ourUsd = money(house.balanceUsd);
  let pending: Array<Record<string, unknown>> = [];

  if (input.asOfDate) {
    const cutoff = new Date(input.asOfDate + "T23:59:59Z");
    // الرصيد حتى تاريخ القطع = لقطة آخر عملية ≤ القطع (balanceAfter).
    const asOfTxn = (
      await db
        .select()
        .from(exchangeTransactions)
        .where(and(eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId), lte(exchangeTransactions.createdAt, cutoff)))
        .orderBy(desc(exchangeTransactions.createdAt), desc(exchangeTransactions.id))
        .limit(1)
    )[0];
    ourIqd = asOfTxn ? money(asOfTxn.balanceIqdAfter) : new Decimal(0);
    ourUsd = asOfTxn ? money(asOfTxn.balanceUsdAfter) : new Decimal(0);

    // البنود المعلّقة = عمليات بعد تاريخ القطع (تفسّر فروق التوقيت — لا تُسوّى).
    const after = await db
      .select()
      .from(exchangeTransactions)
      .where(and(eq(exchangeTransactions.exchangeHouseId, input.exchangeHouseId), gte(exchangeTransactions.createdAt, new Date(input.asOfDate + "T00:00:01Z"))))
      .orderBy(exchangeTransactions.createdAt);
    pending = after
      .filter((t) => new Date(t.createdAt as Date) > cutoff)
      .map((t) => ({
        txnNumber: t.txnNumber,
        type: t.type,
        currency: t.currency,
        iqdAmount: t.iqdAmount,
        usdAmount: t.usdAmount,
        createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
      }));
  }

  const statedIqd = round2(input.statedBalanceIqd);
  const statedUsd = round2(input.statedBalanceUsd);
  return {
    asOfDate: input.asOfDate ?? null,
    ourBalanceIqd: toDbMoney(ourIqd),
    ourBalanceUsd: toDbMoney(ourUsd),
    statedBalanceIqd: toDbMoney(statedIqd),
    statedBalanceUsd: toDbMoney(statedUsd),
    diffIqd: toDbMoney(ourIqd.minus(statedIqd)),
    diffUsd: toDbMoney(ourUsd.minus(statedUsd)),
    matched: ourIqd.minus(statedIqd).abs().lte("0.01") && ourUsd.minus(statedUsd).abs().lte("0.01"),
    pending,
  };
}
