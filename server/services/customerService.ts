import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { customers, invoices } from "../../drizzle/schema";
import { getDb } from "../db";
import { money } from "./money";
import { withTx, type Actor } from "./tx";

export type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export type CustomerType = "فرد" | "تاجر" | "مؤسسة" | "شركة" | "حكومي";

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  whatsapp?: string | null;
  address?: string | null;
  city?: string | null;
  district?: string | null;
  customerType?: CustomerType;
  defaultPriceTier?: PriceTier;
  creditLimit?: string | null;
  notes?: string | null;
}

export interface UpdateCustomerInput extends Partial<CreateCustomerInput> {
  customerId: number;
}

export interface ListCustomersInput {
  q?: string;
  customerType?: CustomerType;
  priceTier?: PriceTier;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

function normPhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t || null;
}

async function assertUniquePhone(db: any, phone: string | null, excludeId?: number) {
  if (!phone) return;
  const conds = [eq(customers.phone, phone)];
  if (excludeId) conds.push(ne(customers.id, excludeId));
  const existing = (await db.select({ id: customers.id }).from(customers).where(and(...conds)).limit(1))[0];
  if (existing)
    throw new TRPCError({
      code: "CONFLICT",
      message: `رقم الهاتف ${phone} مسجّل لعميل آخر`,
    });
}

/** إنشاء عميل جديد (ذرّي + تحقق من تكرار الهاتف). */
export async function createCustomer(input: CreateCustomerInput, _actor: Actor) {
  return withTx(async (tx) => {
    const name = input.name?.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل مطلوب" });
    if (name.length > 255)
      throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل طويل جداً (٢٥٥ حرفاً كحد أقصى)" });

    const phone = normPhone(input.phone);
    await assertUniquePhone(tx, phone);

    const creditLimit = input.creditLimit?.trim();
    if (creditLimit && !/^\d+(\.\d{1,2})?$/.test(creditLimit))
      throw new TRPCError({ code: "BAD_REQUEST", message: "سقف الائتمان غير صالح" });

    const res = await tx.insert(customers).values({
      name,
      phone,
      whatsapp: normPhone(input.whatsapp),
      address: input.address?.trim() || null,
      city: input.city?.trim() || null,
      district: input.district?.trim() || null,
      customerType: input.customerType ?? "فرد",
      defaultPriceTier: input.defaultPriceTier ?? "RETAIL",
      creditLimit: creditLimit || "0",
      notes: input.notes?.trim() || null,
      isActive: true,
    });
    const customerId = Number((res as any)[0]?.insertId ?? (res as any).insertId);
    return { customerId };
  });
}

/** تعديل عميل قائم. */
export async function updateCustomer(input: UpdateCustomerInput, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select().from(customers).where(eq(customers.id, input.customerId)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل مطلوب" });
      if (name.length > 255)
        throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل طويل جداً" });
      patch.name = name;
    }
    if (input.phone !== undefined) {
      const phone = normPhone(input.phone);
      await assertUniquePhone(tx, phone, input.customerId);
      patch.phone = phone;
    }
    if (input.whatsapp !== undefined) patch.whatsapp = normPhone(input.whatsapp);
    if (input.address !== undefined) patch.address = input.address?.trim() || null;
    if (input.city !== undefined) patch.city = input.city?.trim() || null;
    if (input.district !== undefined) patch.district = input.district?.trim() || null;
    if (input.customerType !== undefined) patch.customerType = input.customerType;
    if (input.defaultPriceTier !== undefined) patch.defaultPriceTier = input.defaultPriceTier;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.creditLimit !== undefined) {
      const c = input.creditLimit?.trim();
      if (c && !/^\d+(\.\d{1,2})?$/.test(c))
        throw new TRPCError({ code: "BAD_REQUEST", message: "سقف الائتمان غير صالح" });
      patch.creditLimit = c || "0";
    }

    if (Object.keys(patch).length === 0) return { customerId: input.customerId, changed: false };

    await tx.update(customers).set(patch).where(eq(customers.id, input.customerId));
    return { customerId: input.customerId, changed: true };
  });
}

/** تعطيل عميل (soft delete) — يُرفض إن كان عليه رصيد مفتوح. */
export async function deactivateCustomer(customerId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const c = (
      await tx.select().from(customers).where(eq(customers.id, customerId)).for("update").limit(1)
    )[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (!c.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل معطّل بالفعل" });

    // الأموال عبر decimal.js (§٥) — أي رصيد غير صفري (مدين أو دائن) يمنع التعطيل.
    const balance = money(c.currentBalance ?? "0");
    if (!balance.isZero())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يمكن تعطيل عميل عليه رصيد مفتوح (${balance.toFixed(2)}) — سدّد الذمم أولاً`,
      });

    // الفواتير غير المسوّاة (لا PAID/CANCELLED/RETURNED) = التزام قائم ⇒ تمنع التعطيل.
    const open = (
      await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, customerId),
            inArray(invoices.status, ["PENDING", "CONFIRMED", "PARTIALLY_PAID"]),
          ),
        )
        .limit(1)
    )[0];
    if (open)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تعطيل عميل له فواتير غير مسوّاة (معلّقة/مؤكّدة/مدفوعة جزئياً)",
      });

    await tx.update(customers).set({ isActive: false }).where(eq(customers.id, customerId));
    return { customerId, isActive: false };
  });
}

/** إعادة تفعيل عميل معطّل. */
export async function activateCustomer(customerId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const c = (
      await tx.select().from(customers).where(eq(customers.id, customerId)).for("update").limit(1)
    )[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (c.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل مفعّل بالفعل" });
    await tx.update(customers).set({ isActive: true }).where(eq(customers.id, customerId));
    return { customerId, isActive: true };
  });
}

/** قراءة بطاقة عميل واحدة. */
export async function getCustomer(customerId: number) {
  const db = getDb();
  if (!db) return null;
  return (
    await db.select().from(customers).where(eq(customers.id, customerId)).limit(1)
  )[0] ?? null;
}

/** قائمة عملاء مع بحث وفلاتر وتقسيم صفحات. */
export async function listCustomers(input: ListCustomersInput = {}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);

  const conds: any[] = [];
  if (!input.includeInactive) conds.push(eq(customers.isActive, true));
  if (input.customerType) conds.push(eq(customers.customerType, input.customerType));
  if (input.priceTier) conds.push(eq(customers.defaultPriceTier, input.priceTier));
  if (input.q?.trim()) {
    const q = `%${input.q.trim()}%`;
    conds.push(or(like(customers.name, q), like(customers.phone, q), like(customers.whatsapp, q)));
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      whatsapp: customers.whatsapp,
      city: customers.city,
      district: customers.district,
      customerType: customers.customerType,
      defaultPriceTier: customers.defaultPriceTier,
      creditLimit: customers.creditLimit,
      currentBalance: customers.currentBalance,
      isActive: customers.isActive,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(where as any)
    .orderBy(asc(customers.name), desc(customers.id))
    .limit(limit)
    .offset(offset);

  const totalRow = (
    await db.select({ n: sql<number>`COUNT(*)` }).from(customers).where(where as any)
  )[0];

  return { rows, total: Number(totalRow?.n ?? 0) };
}
