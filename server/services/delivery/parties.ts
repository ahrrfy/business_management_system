// CRUD جهات التوصيل.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryParties } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";
import type { DeliveryActor, DeliveryPartyKind } from "./types";

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
