/**
 * orderFulfillmentService — الجهة الإدارية لطلبات المتجر الإلكترونية (onlineOrders).
 *
 * الموظف يرى الطلبات الواردة (PENDING) ← يثبّتها (CONFIRMED) ← يجهّزها/يُرسلها ← تُسلَّم.
 * **بلا أثر مالي هنا**: تغيير الحالة فقط — تحويل الطلب إلى فاتورة + إرسالية عبر محرّك التوصيل
 * (خصم مخزون + قيد دفتر) شريحةٌ لاحقة (convertToInvoice)، حفاظاً على مبدأ «لا دفتر حتى التأكيد المالي».
 * عزل الفرع: القراءة/الكتابة مقيّدة بـscopedBranchId لغير المرتفعين (admin/manager يعبُران).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  customers,
  onlineOrderItems,
  onlineOrders,
  productUnits,
  productVariants,
  products,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";

export type OnlineOrderStatus = "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED";

/** الانتقالات المسموحة (حارس بنيوي ضدّ قفزات غير منطقية). الطرفيّتان (DELIVERED/CANCELLED) نهائيّتان. */
const ALLOWED_TRANSITIONS: Record<OnlineOrderStatus, OnlineOrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "SHIPPED", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

export interface OnlineOrderRow {
  id: number;
  orderNumber: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  total: string;
  deliveryFee: string;
  itemCount: number;
  createdAt: Date;
}

/** قائمة طلبات المتجر (اختياري: فلترة حالة) — مقيّدة بالفرع لغير المرتفعين. */
export async function listOnlineOrders(opts: {
  scopedBranchId: number | null;
  status?: string | null;
  limit?: number;
}): Promise<OnlineOrderRow[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const conds = [];
  if (opts.scopedBranchId != null) conds.push(eq(onlineOrders.branchId, opts.scopedBranchId));
  if (opts.status) conds.push(eq(onlineOrders.status, opts.status as OnlineOrderStatus));
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      status: onlineOrders.status,
      customerName: customers.name,
      customerPhone: customers.phone,
      governorate: onlineOrders.governorate,
      total: onlineOrders.total,
      deliveryFee: onlineOrders.shippingCost,
      createdAt: onlineOrders.createdAt,
      itemCount: sql<number>`(SELECT COUNT(*) FROM ${onlineOrderItems} WHERE ${onlineOrderItems.onlineOrderId} = ${onlineOrders.id})`,
    })
    .from(onlineOrders)
    .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
    .where(where)
    .orderBy(desc(onlineOrders.id))
    .limit(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    orderNumber: r.orderNumber,
    status: r.status,
    customerName: r.customerName ?? null,
    customerPhone: r.customerPhone ?? null,
    governorate: r.governorate ?? null,
    total: String(r.total),
    deliveryFee: String(r.deliveryFee),
    itemCount: Number(r.itemCount),
    createdAt: r.createdAt,
  }));
}

/** عدّاد لكل حالة (لبطاقات الإحصاء أعلى الشاشة) — مقيّد بالفرع. */
export async function onlineOrderStatusCounts(scopedBranchId: number | null): Promise<Record<string, number>> {
  const db = getDb();
  if (!db) return {};
  const rows = await db
    .select({ status: onlineOrders.status, n: sql<number>`COUNT(*)` })
    .from(onlineOrders)
    .where(scopedBranchId != null ? eq(onlineOrders.branchId, scopedBranchId) : undefined)
    .groupBy(onlineOrders.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export interface OnlineOrderDetailItem {
  productName: string;
  unitName: string;
  quantity: string;
  unitPrice: string;
  total: string;
}
export interface OnlineOrderDetail extends OnlineOrderRow {
  branchId: number;
  addressText: string | null;
  subtotal: string;
  items: OnlineOrderDetailItem[];
}

/** تفاصيل طلب (للملصق/العرض) — الطلب + العميل + البنود. */
export async function getOnlineOrder(id: number, scopedBranchId: number | null): Promise<OnlineOrderDetail | null> {
  const db = getDb();
  if (!db) return null;
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        branchId: onlineOrders.branchId,
        customerName: customers.name,
        customerPhone: customers.phone,
        governorate: onlineOrders.governorate,
        addressText: onlineOrders.shippingAddress,
        subtotal: onlineOrders.subtotal,
        deliveryFee: onlineOrders.shippingCost,
        total: onlineOrders.total,
        createdAt: onlineOrders.createdAt,
      })
      .from(onlineOrders)
      .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
      .where(eq(onlineOrders.id, id))
      .limit(1)
  )[0];
  if (!order) return null;
  if (scopedBranchId != null && Number(order.branchId) !== scopedBranchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  const items = await db
    .select({
      productName: products.name,
      unitName: productUnits.unitName,
      quantity: onlineOrderItems.quantity,
      unitPrice: onlineOrderItems.unitPrice,
      total: onlineOrderItems.total,
    })
    .from(onlineOrderItems)
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
    .where(eq(onlineOrderItems.onlineOrderId, id));
  return {
    id: Number(order.id),
    orderNumber: order.orderNumber,
    status: order.status,
    branchId: Number(order.branchId),
    customerName: order.customerName ?? null,
    customerPhone: order.customerPhone ?? null,
    governorate: order.governorate ?? null,
    addressText: order.addressText ?? null,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.deliveryFee),
    total: String(order.total),
    itemCount: items.length,
    createdAt: order.createdAt,
    items: items.map((i) => ({
      productName: i.productName,
      unitName: i.unitName ?? "",
      quantity: String(i.quantity),
      unitPrice: String(i.unitPrice),
      total: String(i.total),
    })),
  };
}

/** تغيير حالة طلب (بحارس انتقال + عزل فرع). يعيد الحالة السابقة للتدقيق. */
export async function setOnlineOrderStatus(
  input: { id: number; status: OnlineOrderStatus; scopedBranchId: number | null },
  _actorUserId: number
): Promise<{ id: number; from: string; to: OnlineOrderStatus }> {
  return withTx(async (tx) => {
    const order = (
      await tx.select().from(onlineOrders).where(eq(onlineOrders.id, input.id)).for("update").limit(1)
    )[0];
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    if (input.scopedBranchId != null && Number(order.branchId) !== input.scopedBranchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
    }
    const from = order.status as OnlineOrderStatus;
    if (from === input.status) return { id: input.id, from, to: input.status };
    if (!ALLOWED_TRANSITIONS[from].includes(input.status)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `انتقال غير مسموح: ${from} ← ${input.status}` });
    }
    await tx.update(onlineOrders).set({ status: input.status }).where(eq(onlineOrders.id, input.id));
    return { id: input.id, from, to: input.status };
  });
}
