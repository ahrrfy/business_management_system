// تقارير الهدايا (G-م٤) — خلف بوّابة التقارير الحمراء (reportViewerProcedure، تُظهر التكلفة).
// الغرض الحوكميّ الأهمّ: **كشف الإساءة** (تركّز الهدايا الصادرة لكل مُنشئ/عميل) + ملخّص الأثر الماليّ.
// المدى بالـbusinessDay (UTC): createdAt مخزَّن UTC ⇒ [from 00:00Z .. to 23:59:59Z]. المُنجَز فقط (DELIVERED).
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { customers, giftVouchers, users } from "../../../drizzle/schema";
import { requireDb } from "../tx";

export interface GiftsReportInput {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  branchId?: number | null;
}

export async function giftsReport(input: GiftsReportInput) {
  const db = requireDb();
  const start = new Date(`${input.from}T00:00:00.000Z`);
  const end = new Date(`${input.to}T23:59:59.999Z`);
  const base = [gte(giftVouchers.createdAt, start), lte(giftVouchers.createdAt, end), eq(giftVouchers.status, "DELIVERED")];
  if (input.branchId != null) base.push(eq(giftVouchers.branchId, input.branchId));
  const baseWhere = and(...base);
  const outWhere = and(...base, eq(giftVouchers.direction, "OUT"));
  const cnt = sql<number>`COUNT(*)`;
  const cost = sql<string>`COALESCE(SUM(${giftVouchers.totalCost}), 0)`;
  const byCostDesc = desc(sql`SUM(${giftVouchers.totalCost})`);

  // ملخّص الاتجاهين: كم سنداً + تكلفة (الوارد صفر تكلفة؛ الصادر بالكلفة).
  const summary = await db
    .select({ direction: giftVouchers.direction, count: cnt, totalCost: cost })
    .from(giftVouchers)
    .where(baseWhere)
    .groupBy(giftVouchers.direction);

  // كشف الإساءة (١): تركّز الهدايا الصادرة لكل مُنشئ (موظف).
  const byCreator = await db
    .select({ createdBy: giftVouchers.createdBy, userName: users.name, count: cnt, totalCost: cost })
    .from(giftVouchers)
    .leftJoin(users, eq(users.id, giftVouchers.createdBy))
    .where(outWhere)
    .groupBy(giftVouchers.createdBy, users.name)
    .orderBy(byCostDesc)
    .limit(20);

  // كشف الإساءة (٢): تركّز الهدايا الصادرة لكل عميل مستفيد.
  const byCustomer = await db
    .select({ customerId: giftVouchers.customerId, customerName: customers.name, count: cnt, totalCost: cost })
    .from(giftVouchers)
    .leftJoin(customers, eq(customers.id, giftVouchers.customerId))
    .where(outWhere)
    .groupBy(giftVouchers.customerId, customers.name)
    .orderBy(byCostDesc)
    .limit(20);

  // التوزيع حسب نوع الهدية/السبب (حملة/مجاملة/تعويض…).
  const byType = await db
    .select({ giftType: giftVouchers.giftType, count: cnt, totalCost: cost })
    .from(giftVouchers)
    .where(outWhere)
    .groupBy(giftVouchers.giftType)
    .orderBy(byCostDesc);

  return { summary, byCreator, byCustomer, byType };
}
