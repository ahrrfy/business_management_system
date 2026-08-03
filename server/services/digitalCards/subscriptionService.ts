/**
 * سجلّ اشتراكات التعلم. العقد نتيجة للبيع الناجح ولا يحل محله: التجديد يضيف عقداً جديداً
 * مرتبطاً بالسابق، فتظل الفاتورة والتكلفة والربح التاريخية غير قابلة للتغيير.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  digitalSubscriptionContracts,
  digitalOfferings,
  products,
} from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";

export function expiresAfter(startsAt: Date, durationDays: number): Date {
  const expiresAt = new Date(startsAt);
  // حدّ زمني موحّد: لا نبني نهاية العقد من تاريخ الجهاز المحلي لأن الخادم قد يعمل بتوقيت آخر.
  expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);
  return expiresAt;
}

export async function previousContractId(
  tx: Tx,
  offeringId: number,
  studentCustomerId: number,
): Promise<number | null> {
  const [previous] = await tx
    .select({ id: digitalSubscriptionContracts.id })
    .from(digitalSubscriptionContracts)
    .where(
      and(
        eq(digitalSubscriptionContracts.offeringId, offeringId),
        eq(digitalSubscriptionContracts.studentCustomerId, studentCustomerId),
      ),
    )
    .orderBy(desc(digitalSubscriptionContracts.expiresAt))
    .limit(1);
  return previous ? Number(previous.id) : null;
}

export async function listContracts(
  db: DB,
  filters: {
    branchId?: number | null;
    from?: Date;
    to?: Date;
    activeOnly?: boolean;
  } = {},
) {
  const now = new Date();
  const conditions = [];
  if (filters.branchId != null) {
    conditions.push(eq(digitalSubscriptionContracts.branchId, filters.branchId));
  }
  if (filters.from) conditions.push(gte(digitalSubscriptionContracts.expiresAt, filters.from));
  if (filters.to) conditions.push(lte(digitalSubscriptionContracts.expiresAt, filters.to));
  if (filters.activeOnly) {
    conditions.push(eq(digitalSubscriptionContracts.status, "ACTIVE"));
    conditions.push(gte(digitalSubscriptionContracts.expiresAt, now));
  }
  const rows = await db
    .select({
      id: digitalSubscriptionContracts.id,
      offeringId: digitalSubscriptionContracts.offeringId,
      offeringName: products.name,
      branchId: digitalSubscriptionContracts.branchId,
      invoiceId: digitalSubscriptionContracts.invoiceId,
      invoiceItemId: digitalSubscriptionContracts.invoiceItemId,
      studentCustomerId: digitalSubscriptionContracts.studentCustomerId,
      studentName: digitalSubscriptionContracts.studentNameSnapshot,
      durationDays: digitalSubscriptionContracts.durationDays,
      startsAt: digitalSubscriptionContracts.startsAt,
      expiresAt: digitalSubscriptionContracts.expiresAt,
      previousContractId: digitalSubscriptionContracts.previousContractId,
      storedStatus: digitalSubscriptionContracts.status,
    })
    .from(digitalSubscriptionContracts)
    .innerJoin(
      digitalOfferings,
      eq(digitalSubscriptionContracts.offeringId, digitalOfferings.id),
    )
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(digitalSubscriptionContracts.expiresAt));

  return rows.map((row) => ({
    ...row,
    status:
      row.storedStatus === "CANCELLED"
        ? "CANCELLED"
        : row.expiresAt.getTime() > now.getTime()
          ? "ACTIVE"
          : "EXPIRED",
  }));
}
