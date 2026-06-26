import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryParties } from "../../drizzle/schema";
import { getDb } from "../db";
import type { Tx } from "../db";
import { money, toDbMoney, toDateStr } from "./money";
import { withTx } from "./tx";
import { extractInsertId } from "../lib/insertId";

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
