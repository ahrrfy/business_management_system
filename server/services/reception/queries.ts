// طابور فواتير محطة خدمة الزبائن — ش١ (يحلّ محلّ delivery.receptionQueue المحدود).
//
// المصدر: invoices مقيَّدةً بورديات RECEPTION (innerJoin shifts — فواتير أوامر الشغل المُسلَّمة
// بلا shiftId تبقى خارج هذا الطابور وتظهر في طابور الطلبات)، مع LEFT JOIN على الإرسالية
// (فريدة لكل فاتورة بقيد uq_consignment_invoice) وأمر الشغل والعميل.
//
// keyset (paginateKeyset) على idx_invoice_shift/idx_invoice_branch — الطابور القديم كان
// sinceDays:1 مثبَّتاً وlimit 300 بلا ترقيم ⇒ فاتورة الأمس غير قابلة للوصول إطلاقاً (§٨.٥).
import { and, desc, eq, gte, inArray, like, or, sql, type SQL } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryParties,
  invoices,
  receipts,
  shifts,
  users,
  workOrders,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { paginateKeyset } from "../../lib/paginateKeyset";
import { escLike } from "../../lib/sqlLike";
import { utcTodayStart } from "../businessDay";
import type { ReceptionInvoiceQueueInput } from "./types";

/** «قَبَضَها»: اسم مُصدِر آخر إيصال قبضٍ على الفاتورة (لا مُنشئ الفاتورة) — §٨.٥:
 *  الضبط بالإفصاح لا بالمنع؛ التسديد على فاتورة زميلٍ مسموح والاسم يُعلَن. */
const lastCollectorName = sql<string | null>`(
  SELECT u.name FROM receipts r
  JOIN users u ON u.id = r.createdBy
  WHERE r.invoiceId = ${invoices.id} AND r.direction = 'IN'
  ORDER BY r.id DESC LIMIT 1
)`;

export async function listReceptionInvoices(input: ReceptionInvoiceQueueInput) {
  const db = getDb();
  if (!db) return { rows: [], hasMore: false, nextCursor: null as number | null };

  const baseConds: SQL[] = [
    eq(invoices.branchId, input.branchId),
    eq(shifts.shiftType, "RECEPTION"),
  ];
  if (input.shiftIds && input.shiftIds.length > 0) {
    baseConds.push(inArray(invoices.shiftId, input.shiftIds));
  } else {
    // حدّ اليوم بإطار businessDay (UTC) — لا مكوّنات محلية (حارس check:date-boundaries).
    const sinceDays = input.sinceDays ?? 7;
    baseConds.push(gte(invoices.invoiceDate, new Date(utcTodayStart().getTime() - sinceDays * 86_400_000)));
  }

  switch (input.paymentState ?? "ALL") {
    case "UNSETTLED":
      baseConds.push(inArray(invoices.status, ["PENDING", "PARTIALLY_PAID"]));
      break;
    case "UNPAID":
      baseConds.push(eq(invoices.status, "PENDING"));
      break;
    case "PARTIAL":
      baseConds.push(eq(invoices.status, "PARTIALLY_PAID"));
      break;
    case "PAID":
      baseConds.push(eq(invoices.status, "PAID"));
      break;
  }
  if (input.method) baseConds.push(eq(invoices.paymentMethod, input.method));

  switch (input.deliveryState ?? "ALL") {
    case "NOT_DISPATCHED":
      baseConds.push(sql`${deliveryConsignments.id} IS NULL`);
      break;
    case "DISPATCHED":
      baseConds.push(inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]));
      break;
    case "DELIVERED":
      baseConds.push(eq(deliveryConsignments.status, "DELIVERED"));
      break;
  }

  const q = input.q?.trim();
  if (q) {
    const pat = `%${escLike(q)}%`;
    const cond = or(
      like(invoices.invoiceNumber, pat),
      like(invoices.offlineReceiptNumber, pat),
      like(invoices.contactName, pat),
      like(invoices.contactPhone, pat),
      like(customers.name, pat),
      like(customers.phone, pat),
    );
    if (cond) baseConds.push(cond);
  }

  const page = await paginateKeyset({
    cursor: input.cursor,
    limit: input.limit,
    defaultLimit: 50,
    idCol: invoices.id,
    baseConds,
    runQuery: (where, fetchLimit, fetchOffset) =>
      db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          returnedTotal: invoices.returnedTotal,
          status: invoices.status,
          paymentMethod: invoices.paymentMethod,
          customerId: invoices.customerId,
          customerName: customers.name,
          customerPhone: customers.phone,
          contactName: invoices.contactName,
          contactPhone: invoices.contactPhone,
          offlineReceiptNumber: invoices.offlineReceiptNumber,
          createdBy: invoices.createdBy,
          createdByName: users.name,
          shiftId: invoices.shiftId,
          lastCollectorName,
          workOrderId: workOrders.id,
          workOrderNumber: workOrders.orderNumber,
          workOrderStatus: workOrders.status,
          hasDelivery: workOrders.hasDelivery,
          deliveryAddress: workOrders.deliveryAddress,
          deliveryPhone: workOrders.deliveryPhone,
          consignmentId: deliveryConsignments.id,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          consignmentStatus: deliveryConsignments.status,
          consignmentCod: deliveryConsignments.codAmount,
          partyName: deliveryParties.name,
        })
        .from(invoices)
        .innerJoin(shifts, eq(shifts.id, invoices.shiftId))
        .leftJoin(customers, eq(customers.id, invoices.customerId))
        .leftJoin(users, eq(users.id, invoices.createdBy))
        .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
        .leftJoin(deliveryConsignments, eq(deliveryConsignments.invoiceId, invoices.id))
        .leftJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
        .where(where)
        .orderBy(desc(invoices.id))
        .limit(fetchLimit)
        .offset(fetchOffset),
  });

  return { rows: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
}
