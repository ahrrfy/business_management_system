// إنشاء/تعديل/تفعيل-تعطيل/قراءة/قائمة الصيرفات (CRUD + الرصيد الافتتاحي).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { adjustExchangeBalanceIqd, adjustExchangeBalanceUsd, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";
import { nextTxnNumber, toDbRate } from "./helpers";

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
