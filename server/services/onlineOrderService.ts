import { getDb } from "../db";
import { onlineOrders, onlineOrderItems, products, customers } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

const getDatabase = async () => {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قاعدة البيانات غير متاحة",
    });
  }
  return db;
};

export interface CreateOrderInput {
  customerId: number;
  items: Array<{
    productId: number;
    quantity: number;
  }>;
  shippingAddress: string;
  shippingCost: number;
  taxAmount: number;
}

export interface UpdateOrderStatusInput {
  orderId: number;
  status: "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  trackingNumber?: string;
}

/**
 * إنشاء طلب إلكتروني جديد
 */
export async function createOnlineOrder(input: CreateOrderInput) {
  try {
    const db = await getDatabase();
    // التحقق من وجود العميل
    const customerResult = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    const customer = customerResult.length > 0 ? customerResult[0] : null;

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "العميل غير موجود",
      });
    }

    // التحقق من المنتجات والكميات
    let subtotal = 0;
    const orderItemsData = [];

    for (const item of input.items) {
      const productResult = await db.select().from(products).where(eq(products.id, item.productId)).limit(1);
      const product = productResult.length > 0 ? productResult[0] : null;

      if (!product) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `المنتج برقم ${item.productId} غير موجود`,
        });
      }

      if (product.quantityOnHand < item.quantity) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `الكمية المتاحة من المنتج ${product.name} غير كافية`,
        });
      }

      const itemTotal = Number(product.salePrice) * item.quantity;
      subtotal += itemTotal;

      orderItemsData.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: product.salePrice,
        total: itemTotal.toString(),
      });
    }

    // حساب الإجمالي
    const total = subtotal + Number(input.shippingCost) + Number(input.taxAmount);

    // إنشاء الطلب
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    const result = await db.insert(onlineOrders).values({
      orderNumber,
      customerId: input.customerId,
      subtotal: subtotal.toString(),
      shippingCost: input.shippingCost.toString(),
      taxAmount: input.taxAmount.toString(),
      total: total.toString(),
      shippingAddress: input.shippingAddress,
      status: "PENDING" as any,
    });

    // جلب معرف الطلب من رقم الطلب
    const createdOrderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.orderNumber, orderNumber)).limit(1);
    const orderId = createdOrderResult.length > 0 ? createdOrderResult[0].id : 0;

    // إضافة عناصر الطلب
    for (const item of orderItemsData) {
      await db.insert(onlineOrderItems).values({
        onlineOrderId: orderId,
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
      });

      // تحديث كمية المنتج في المخزون
      const prodResult = await db.select().from(products).where(eq(products.id, item.productId)).limit(1);
      const prod = prodResult.length > 0 ? prodResult[0] : null;

      if (prod) {
        await db
          .update(products)
          .set({
            quantityOnHand: prod.quantityOnHand - item.quantity,
          })
          .where(eq(products.id, item.productId));
      }
    }

    // جلب الطلب الكامل
    const orderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.id, orderId)).limit(1);
    const order = orderResult.length > 0 ? orderResult[0] : null;

    return {
      success: true,
      orderId,
      orderNumber,
      order,
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في إنشاء الطلب",
    });
  }
}

/**
 * جلب قائمة الطلبات الإلكترونية
 */
export async function getOnlineOrders(limit = 50, offset = 0) {
  try {
    const db = await getDatabase();
    const orders = await db.select().from(onlineOrders).orderBy(desc(onlineOrders.orderDate)).limit(limit).offset(offset);
    const totalResult = await db.select().from(onlineOrders);

    return {
      success: true,
      orders,
      total: totalResult.length,
      limit,
      offset,
    };
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في جلب الطلبات",
    });
  }
}

/**
 * جلب تفاصيل طلب معين
 */
export async function getOnlineOrderById(orderId: number) {
  try {
    const db = await getDatabase();
    const orderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.id, orderId)).limit(1);
    const order = orderResult.length > 0 ? orderResult[0] : null;

    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "الطلب غير موجود",
      });
    }

    // جلب عناصر الطلب
    const itemsResult = await db.select().from(onlineOrderItems).where(eq(onlineOrderItems.onlineOrderId, orderId));

    return {
      success: true,
      order: {
        ...order,
        items: itemsResult,
      },
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في جلب تفاصيل الطلب",
    });
  }
}

/**
 * تحديث حالة الطلب
 */
export async function updateOrderStatus(input: UpdateOrderStatusInput) {
  try {
    const db = await getDatabase();
    const orderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.id, input.orderId)).limit(1);
    const order = orderResult.length > 0 ? orderResult[0] : null;

    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "الطلب غير موجود",
      });
    }

    const updateData: any = {
      status: input.status as any,
    };

    if (input.trackingNumber) {
      updateData.trackingNumber = input.trackingNumber;
    }

    await db
      .update(onlineOrders)
      .set(updateData)
      .where(eq(onlineOrders.id, input.orderId));

    const updatedOrderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.id, input.orderId)).limit(1);
    const updatedOrder = updatedOrderResult.length > 0 ? updatedOrderResult[0] : null;

    return {
      success: true,
      order: updatedOrder,
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في تحديث حالة الطلب",
    });
  }
}

/**
 * إلغاء طلب
 */
export async function cancelOrder(orderId: number) {
  try {
    const db = await getDatabase();
    const orderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.id, orderId)).limit(1);
    const order = orderResult.length > 0 ? orderResult[0] : null;

    if (!order) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "الطلب غير موجود",
      });
    }

    if (order.status === "DELIVERED" || order.status === "SHIPPED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء طلب تم شحنه أو تسليمه",
      });
    }

    // إرجاع المنتجات إلى المخزون
    const itemsResult = await db.select().from(onlineOrderItems).where(eq(onlineOrderItems.onlineOrderId, orderId));
    for (const item of itemsResult) {
      const prodResult = await db.select().from(products).where(eq(products.id, item.productId)).limit(1);
      const prod = prodResult.length > 0 ? prodResult[0] : null;

      if (prod) {
        await db
          .update(products)
          .set({
            quantityOnHand: prod.quantityOnHand + item.quantity,
          })
          .where(eq(products.id, item.productId));
      }
    }

    // تحديث حالة الطلب
    await db
      .update(onlineOrders)
      .set({ status: "CANCELLED" })
      .where(eq(onlineOrders.id, orderId));

    const cancelledOrderResult = await db.select().from(onlineOrders).where(eq(onlineOrders.id, orderId)).limit(1);
    const cancelledOrder = cancelledOrderResult.length > 0 ? cancelledOrderResult[0] : null;

    return {
      success: true,
      order: cancelledOrder,
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في إلغاء الطلب",
    });
  }
}

/**
 * جلب الطلبات حسب حالة معينة
 */
export async function getOrdersByStatus(status: string, limit = 50, offset = 0) {
  try {
    const db = await getDatabase();
    const orders = await db.select().from(onlineOrders).where(eq(onlineOrders.status, status as any)).orderBy(desc(onlineOrders.orderDate)).limit(limit).offset(offset);

    return {
      success: true,
      orders,
      status,
      limit,
      offset,
    };
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في جلب الطلبات",
    });
  }
}

/**
 * جلب الطلبات حسب العميل
 */
export async function getOrdersByCustomer(customerId: number, limit = 50, offset = 0) {
  try {
    const db = await getDatabase();
    const orders = await db.select().from(onlineOrders).where(eq(onlineOrders.customerId, customerId)).orderBy(desc(onlineOrders.orderDate)).limit(limit).offset(offset);

    return {
      success: true,
      orders,
      customerId,
      limit,
      offset,
    };
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "فشل في جلب الطلبات",
    });
  }
}
