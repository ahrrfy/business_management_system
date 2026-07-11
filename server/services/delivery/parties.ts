// CRUD جهات التوصيل.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, ne, or, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, onlineOrders, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";
import type { DeliveryActor, DeliveryPartyKind } from "./types";

/** يمنع تعطيل/فكّ ربط جهة عليها طلبات متجر «مع المندوب» (SHIPPED) — وإلا تُيتَّم من مسار التحصيل
 *  الوحيد (توصيلاتي) بلا إعادة إسناد (مراجعة عدائية ١٢/٧). العهدة=0 لطلبٍ لم يُحصَّل بعد فلا يحرسها فحص الرصيد. */
async function assertNoOpenCourierOrders(tx: Tx, partyId: number): Promise<void> {
  const open = (await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(onlineOrders)
    .where(and(eq(onlineOrders.deliveryPartyId, partyId), eq(onlineOrders.status, "SHIPPED"))))[0];
  if (Number(open?.n ?? 0) > 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعطيل/فكّ ربط جهة عليها طلبات قيد التوصيل — سلّمها أو أعِد إسنادها أولاً" });
  }
}

/** يتحقّق أن userId حسابُ مندوب (courier) غير مرتبط بجهة أخرى — قبل الربط. (excludePartyId للتعديل.) */
async function assertLinkableCourier(tx: Tx, userId: number, excludePartyId?: number): Promise<void> {
  const u = (await tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب المختار غير موجود" });
  if (u.role !== "courier") throw new TRPCError({ code: "BAD_REQUEST", message: "الحساب المختار ليس دوره «مندوب توصيل»" });
  const conds = [eq(deliveryParties.userId, userId)];
  if (excludePartyId != null) conds.push(ne(deliveryParties.id, excludePartyId));
  const linked = (await tx.select({ id: deliveryParties.id }).from(deliveryParties).where(and(...conds)).limit(1))[0];
  if (linked) throw new TRPCError({ code: "BAD_REQUEST", message: "هذا الحساب مرتبط بجهة توصيل أخرى" });
}

export interface CreateDeliveryPartyInput {
  partyType: DeliveryPartyKind;
  name: string;
  phone?: string | null;
  phone2?: string | null;
  userId?: number | null;
  branchId?: number | null;
  nationalId?: string | null;
  vehicleInfo?: string | null;
  defaultFee?: string | null;
  floatLimit?: string | null;
  notes?: string | null;
}

export async function createDeliveryParty(input: CreateDeliveryPartyInput, actor: DeliveryActor): Promise<{ id: number }> {
  return withTx(async (tx) => {
    if (input.userId != null) await assertLinkableCourier(tx, input.userId);
    const res = await tx.insert(deliveryParties).values({
      partyType: input.partyType,
      name: input.name.trim(),
      phone: input.phone ?? null,
      phone2: input.phone2 ?? null,
      userId: input.userId ?? null,
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
  userId?: number | null;
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
    if (input.userId !== undefined) {
      if (input.userId != null) await assertLinkableCourier(tx, input.userId, input.id);
      else await assertNoOpenCourierOrders(tx, input.id); // فكّ الربط: امنعه ما دامت طلبات قيد التوصيل
      patch.userId = input.userId;
    }
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
      // .for("update"): يقفل صفّ الجهة قبل فحص العهدة ⇒ لا يسبق قرارَ التعطيل تحصيلٌ متزامن يرفع
      // العهدة بعد قراءةٍ غير مقفلة (سباق check-then-act — مراجعة عدائية ١٢/٧). التحصيل يقفل نفس الصفّ.
      const p = (await tx.select({ balance: deliveryParties.currentBalance }).from(deliveryParties).where(eq(deliveryParties.id, id)).for("update").limit(1))[0];
      if (p && money(p.balance ?? "0").abs().gt("0.01")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعطيل جهة عليها عهدة قائمة — سوِّ الرصيد أولاً" });
      }
      await assertNoOpenCourierOrders(tx, id); // + طلبات متجر قيد التوصيل (العهدة=0 لا تحرسها)
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
      userId: deliveryParties.userId,
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

/** حسابات المناديب (دور courier) لربطها بجهة توصيل — مع الجهة المرتبطة حالياً (لمنتقي الربط). */
export async function listCourierAccounts() {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      linkedPartyId: deliveryParties.id,
      linkedPartyName: deliveryParties.name,
    })
    .from(users)
    .leftJoin(deliveryParties, eq(deliveryParties.userId, users.id))
    .where(eq(users.role, "courier"))
    .orderBy(users.name);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name ?? r.username ?? `#${r.id}`,
    username: r.username ?? null,
    linkedPartyId: r.linkedPartyId != null ? Number(r.linkedPartyId) : null,
    linkedPartyName: r.linkedPartyName ?? null,
  }));
}
