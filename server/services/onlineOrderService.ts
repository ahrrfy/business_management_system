/**
 * onlineOrderService — إنشاء/تتبّع طلب متجر الجوال (B2C — الدفع عند الاستلام).
 *
 * ⚠️ الأمان (نقاط فشل Antigravity التي نُغلقها):
 *  ① **لا انتحال مدير**: الطلب لا يُنشئ فاتورة ولا يمسّ الدفتر/المخزون ولا يحمل createdBy=userId.
 *     هو «طلبٌ» بحالة PENDING مربوطٌ بعميلٍ حقيقي (find-or-create بالهاتف) حتى يؤكّده الموظف.
 *  ② **السعر خادمي**: لا يُقبل أيّ سعر من العميل — يُقرأ سعر المفرد (RETAIL) من القاعدة لكل بند.
 *  ③ **التحقّق**: كل بند يجب أن يكون منتجاً فعّالاً غير خدمي بوحدة فعّالة ولها سعر مفرد.
 *  ④ **idempotency**: clientRequestId فريد ⇒ النقر المزدوج/إعادة المحاولة لا تُنشئ طلباً ثانياً.
 *  ⑤ **ذرّي**: كل ذلك داخل withTx — أيّ خطأ ⇒ ROLLBACK كامل.
 *
 * الأجرة = deliveryFeeFor(المحافظة) تقديرياً (يثبّتها الموظف عند الإسناد — شريحة ٤).
 */
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  customers,
  onlineOrderItems,
  onlineOrders,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../drizzle/schema";
import { deliveryFeeFor, governorateById } from "@shared/governorates";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money, round2, sumMoney, toDbMoney, toDbQty } from "./money";
import { withTx } from "./tx";

const RETAIL = "RETAIL" as const;

export interface OnlineOrderLineInput {
  productUnitId: number;
  quantity: number;
}

export interface CreateOnlineOrderInput {
  branchId: number;
  customerName: string;
  customerPhone: string;
  governorate: string;
  addressText: string;
  latitude?: number | null;
  longitude?: number | null;
  notes?: string | null;
  lines: OnlineOrderLineInput[];
  clientRequestId?: string | null;
}

export interface CreateOnlineOrderResult {
  orderId: number;
  orderNumber: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  itemCount: number;
  idempotentReplay?: boolean;
}

/** طلب متجر جديد — server-priced، مُتحقَّق، idempotent، ذرّي. لا أثر مالي (PENDING فقط). */
export async function createOnlineOrder(input: CreateOnlineOrderInput): Promise<CreateOnlineOrderResult> {
  const gov = governorateById(input.governorate);
  if (!gov) throw new TRPCError({ code: "BAD_REQUEST", message: "المحافظة غير معروفة" });
  if (!input.lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "السلة فارغة" });
  const name = input.customerName.trim();
  const phone = input.customerPhone.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "الاسم مطلوب" });
  if (!phone) throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الهاتف مطلوب" });
  const address = input.addressText.trim();
  if (!address) throw new TRPCError({ code: "BAD_REQUEST", message: "العنوان مطلوب" });

  return withTx(async (tx) => {
    // ① idempotency: أعِد الطلب نفسه إن تكرّر المفتاح (بلا إنشاء ثانٍ).
    if (input.clientRequestId) {
      const existing = (
        await tx
          .select({
            id: onlineOrders.id,
            orderNumber: onlineOrders.orderNumber,
            subtotal: onlineOrders.subtotal,
            shippingCost: onlineOrders.shippingCost,
            total: onlineOrders.total,
          })
          .from(onlineOrders)
          .where(eq(onlineOrders.clientRequestId, input.clientRequestId))
          .limit(1)
      )[0];
      if (existing) {
        const cnt = await tx
          .select({ id: onlineOrderItems.id })
          .from(onlineOrderItems)
          .where(eq(onlineOrderItems.onlineOrderId, Number(existing.id)));
        return {
          orderId: Number(existing.id),
          orderNumber: existing.orderNumber,
          subtotal: String(existing.subtotal),
          deliveryFee: String(existing.shippingCost),
          total: String(existing.total),
          itemCount: cnt.length,
          idempotentReplay: true,
        };
      }
    }

    // ② تسعير خادمي + تحقّق لكل بند.
    const items: {
      variantId: number;
      productUnitId: number;
      quantity: number;
      baseQuantity: number;
      unitPrice: string;
      lineTotal: string;
    }[] = [];
    for (const line of input.lines) {
      const qty = Math.floor(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "كمية غير صحيحة" });
      }
      const row = (
        await tx
          .select({
            productUnitId: productUnits.id,
            variantId: productVariants.id,
            conversionFactor: productUnits.conversionFactor,
            unitActive: productUnits.isActive,
            variantActive: productVariants.isActive,
            productActive: products.isActive,
            isService: products.isService,
            price: productPrices.price,
          })
          .from(productUnits)
          .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
          .innerJoin(products, eq(productVariants.productId, products.id))
          .leftJoin(
            productPrices,
            and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL))
          )
          .where(eq(productUnits.id, line.productUnitId))
          .limit(1)
      )[0];
      if (
        !row ||
        !row.productActive ||
        row.isService ||
        !row.variantActive ||
        !row.unitActive ||
        row.price == null
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "أحد المنتجات لم يعُد متاحاً — حدّث السلة" });
      }
      const unitPrice = round2(row.price); // سعر المفرد الخادمي (لا من العميل)
      const lineTotal = round2(unitPrice.times(qty));
      const baseQuantity = Number(money(qty).times(row.conversionFactor ?? 1).toFixed(0));
      items.push({
        variantId: Number(row.variantId),
        productUnitId: Number(row.productUnitId),
        quantity: qty,
        baseQuantity,
        unitPrice: unitPrice.toFixed(2),
        lineTotal: lineTotal.toFixed(2),
      });
    }

    const subtotal = round2(sumMoney(items.map((i) => i.lineTotal)));
    const deliveryFee = round2(deliveryFeeFor(input.governorate));
    const total = round2(subtotal.plus(deliveryFee));

    // ③ find-or-create عميل نقدي بالهاتف (creditLimit "0" = نقدي فقط، لا ائتمان).
    let customerId: number;
    const existingCust = (
      await tx.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.phone, phone)).limit(1)
    )[0];
    if (existingCust) {
      customerId = Number(existingCust.id);
    } else {
      const insCust = await tx.insert(customers).values({
        name,
        phone,
        customerType: "فرد",
        defaultPriceTier: RETAIL,
        creditLimit: "0",
        currentBalance: "0",
        isActive: true,
      });
      customerId = extractInsertId(insCust);
    }

    // ④ إنشاء الطلب (PENDING) — رقمٌ مؤقّت فريد ثم ORD-{id} (بلا سباق ترقيم).
    const shippingAddress = input.notes && input.notes.trim()
      ? `${address}\nملاحظة: ${input.notes.trim()}`
      : address;
    const insOrder = await tx.insert(onlineOrders).values({
      orderNumber: `TMP-${randomUUID()}`,
      customerId,
      branchId: input.branchId,
      subtotal: toDbMoney(subtotal),
      shippingCost: toDbMoney(deliveryFee),
      taxAmount: "0",
      total: toDbMoney(total),
      status: "PENDING",
      shippingAddress,
      governorate: input.governorate,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      clientRequestId: input.clientRequestId ?? null,
    });
    const orderId = extractInsertId(insOrder);
    const orderNumber = `ORD-${100000 + orderId}`;
    await tx.update(onlineOrders).set({ orderNumber }).where(eq(onlineOrders.id, orderId));

    // ⑤ بنود الطلب (لقطة السعر الخادمي).
    for (const it of items) {
      await tx.insert(onlineOrderItems).values({
        onlineOrderId: orderId,
        variantId: it.variantId,
        productUnitId: it.productUnitId,
        quantity: toDbQty(it.quantity),
        baseQuantity: it.baseQuantity,
        unitPrice: it.unitPrice,
        total: it.lineTotal,
      });
    }

    return {
      orderId,
      orderNumber,
      subtotal: toDbMoney(subtotal),
      deliveryFee: toDbMoney(deliveryFee),
      total: toDbMoney(total),
      itemCount: items.length,
    };
  });
}

export interface OnlineOrderTracking {
  orderNumber: string;
  status: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  governorate: string | null;
  createdAt: Date;
  items: { productName: string; unitName: string; quantity: string; unitPrice: string; total: string }[];
}

/**
 * تتبّع الطلب: يتطلّب **رقم الطلب + الهاتف معاً** (خصوصية — لا يكفي تخمين الرقم لرؤية طلب غيرك).
 * null إن لم يُطابِق.
 */
export async function trackOnlineOrder(orderNumber: string, phone: string): Promise<OnlineOrderTracking | null> {
  const db = getDb();
  if (!db) return null;
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        subtotal: onlineOrders.subtotal,
        shippingCost: onlineOrders.shippingCost,
        total: onlineOrders.total,
        governorate: onlineOrders.governorate,
        createdAt: onlineOrders.createdAt,
        customerPhone: customers.phone,
      })
      .from(onlineOrders)
      .innerJoin(customers, eq(onlineOrders.customerId, customers.id))
      .where(and(eq(onlineOrders.orderNumber, orderNumber.trim()), eq(customers.phone, phone.trim())))
      .limit(1)
  )[0];
  if (!order) return null;

  const rows = await db
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
    .where(eq(onlineOrderItems.onlineOrderId, Number(order.id)));

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.shippingCost),
    total: String(order.total),
    governorate: order.governorate ?? null,
    createdAt: order.createdAt,
    items: rows.map((r) => ({
      productName: r.productName,
      unitName: r.unitName ?? "",
      quantity: String(r.quantity),
      unitPrice: String(r.unitPrice),
      total: String(r.total),
    })),
  };
}
