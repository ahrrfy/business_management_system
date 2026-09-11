/**
 * barcodeDispatchService — خدمة الإسناد السريع بالباركود لجهات التوصيل.
 *
 * تتيح للموظف مسح باركود أي طلب (طلب متجر ORD-، أمر شغل WO-، أو فاتورة INV-)
 * لإسناده فورياً لجهة التوصيل المختارة مع إرجاع كافة تفاصيل الإرسالية
 * الجاهزة للطباعة المباشرة.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, or, sql } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryParties,
  invoices,
  onlineOrders,
  workOrders,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeKnownSystemBarcode } from "@shared/barcodeScanner";
import { appErrorMessage } from "@shared/errors";
import { dispatchOnlineOrder } from "../storeAdmin/dispatchOnlineOrder";
import { dispatchToDelivery } from "./dispatch";
import { dispatchInvoiceToDelivery } from "./dispatchInvoice";
import type { DeliveryTxActor } from "./types";
import type { Actor } from "../tx";

export interface BarcodeDispatchInput {
  barcode: string;
  partyId: number;
  deliveryFee?: string | null;
  externalTrackingRef?: string | null;
  assignedUserId?: number | null;
  clientRequestId?: string | null;
  partialDispatchConfirmed?: boolean;
  deliveryAddress?: string | null;
  notes?: string | null;
}

export interface BarcodeDispatchResult {
  sourceType: "ONLINE_ORDER" | "WORK_ORDER" | "INVOICE";
  sourceId: number;
  sourceNumber: string;
  consignmentId: number;
  consignmentNumber: string;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
  codAmount: string;
  deliveryFee: string;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  partyName: string;
}

export async function dispatchByBarcode(
  input: BarcodeDispatchInput,
  actor: DeliveryTxActor,
): Promise<BarcodeDispatchResult> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const rawCode = input.barcode?.trim();
  if (!rawCode) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر إسناد الطلب",
        why: "رمز الباركود المدخل فارغ",
        doThis: "امسح أو أدخل باركود طلب المتجر أو أمر الشغل أو الفاتورة",
      }),
    });
  }
  const cleanCode = normalizeKnownSystemBarcode(rawCode);

  const [party] = await db
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, input.partyId))
    .limit(1);
  if (!party || !party.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر إسناد الطلب للتوصيل",
        why: "جهة التوصيل المحددة غير صالحة أو معطلة",
        doThis: "اختر جهة توصيل نشطة من القائمة قبل مسح الطلبات",
      }),
    });
  }

  const scopedBranch = actor.role === "admin" ? null : (actor.branchId ?? null);
  if (scopedBranch != null && party.branchId != null && Number(party.branchId) !== scopedBranch) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "ممنوع إسناد الطلب على هذه الجهة",
        why: "جهة التوصيل تتبع فرعاً آخر غير فرعك الحالي",
        doThis: "اختر جهة توصيل تابعة لنفس الفرع",
      }),
    });
  }

  // ١. فحص طلبات المتجر (Online Orders)
  const isNumeric = /^\d+$/.test(cleanCode);
  const [onlineOrder] = await db
    .select({
      id: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      branchId: onlineOrders.branchId,
      status: onlineOrders.status,
      deliveryPartyId: onlineOrders.deliveryPartyId,
      invoiceId: onlineOrders.invoiceId,
      shippingAddress: onlineOrders.shippingAddress,
      total: onlineOrders.total,
      customerId: onlineOrders.customerId,
      customerName: customers.name,
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''))`,
    })
    .from(onlineOrders)
    .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
    .where(
      and(
        or(
          eq(onlineOrders.orderNumber, cleanCode),
          isNumeric ? eq(onlineOrders.id, Number(cleanCode)) : sql`0=1`,
        ),
        scopedBranch != null ? eq(onlineOrders.branchId, scopedBranch) : sql`1=1`,
      ),
    )
    .limit(1);

  if (onlineOrder) {
    if (onlineOrder.status === "CANCELLED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر إسناد طلب المتجر",
          why: `طلب المتجر ${onlineOrder.orderNumber} ملغى مسبقاً`,
          doThis: "تحقق من حالة الطلب في شاشة طلبات المتجر",
        }),
      });
    }
    if (onlineOrder.status === "DELIVERED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر إسناد طلب المتجر",
          why: `طلب المتجر ${onlineOrder.orderNumber} تم تسليمه للعميل مسبقاً`,
          doThis: "راجع كشف الطلبات المسلَّمة إن كنت بحاجة إلى بوليصة سابقة",
        }),
      });
    }
    if (onlineOrder.status === "SHIPPED" && onlineOrder.deliveryPartyId != null) {
      const [existingCn] = await db
        .select({ consignmentNumber: deliveryConsignments.consignmentNumber })
        .from(deliveryConsignments)
        .where(
          and(
            eq(deliveryConsignments.sourceId, Number(onlineOrder.id)),
            eq(deliveryConsignments.sourceType, "ONLINE_ORDER"),
            sql`${deliveryConsignments.status} NOT IN ('CANCELLED', 'RETURNED')`,
          ),
        )
        .limit(1);
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "طلب المتجر مسند للتوصيل مسبقاً",
          why: `طلب المتجر ${onlineOrder.orderNumber} مُسنَد مسبقاً${existingCn ? ` بالإرسالية ${existingCn.consignmentNumber}` : ""}`,
          doThis: "راجع تبويب «قيد التوصيل» لمتابعة الإرسالية أو طباعة البوليصة",
        }),
      });
    }

    const dispatchActor: Actor = {
      userId: actor.userId,
      branchId: actor.branchId ?? Number(onlineOrder.branchId ?? 1),
      role: actor.role,
    };

    const res = await dispatchOnlineOrder(
      {
        onlineOrderId: Number(onlineOrder.id),
        partyId: input.partyId,
        externalTrackingRef: input.externalTrackingRef ?? null,
      },
      dispatchActor,
    );

    const [createdCn] = res.consignmentId != null
      ? await db.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, Number(res.consignmentId))).limit(1)
      : [];

    return {
      sourceType: "ONLINE_ORDER",
      sourceId: Number(onlineOrder.id),
      sourceNumber: onlineOrder.orderNumber,
      consignmentId: Number(res.consignmentId ?? createdCn?.id ?? 0),
      consignmentNumber: String(res.consignmentNumber ?? createdCn?.consignmentNumber ?? ""),
      invoiceId: res.invoiceId,
      invoiceNumber: res.invoiceNumber,
      codAmount: String(createdCn?.codAmount ?? res.total),
      deliveryFee: String(createdCn?.deliveryFee ?? "0"),
      recipientName: createdCn?.recipientName ?? onlineOrder.customerName ?? null,
      recipientPhone: createdCn?.recipientPhone ?? onlineOrder.customerPhone ?? null,
      deliveryAddress: createdCn?.deliveryAddress ?? onlineOrder.shippingAddress ?? null,
      partyName: party.name,
    };
  }

  // ٢. فحص أوامر الشغل (Work Orders)
  const [workOrder] = await db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      branchId: workOrders.branchId,
      status: workOrders.status,
      hasDelivery: workOrders.hasDelivery,
      title: workOrders.title,
      salePrice: workOrders.salePrice,
      deposit: workOrders.deposit,
      deliveryCost: workOrders.deliveryCost,
      deliveryPhone: workOrders.deliveryPhone,
      deliveryAddress: workOrders.deliveryAddress,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(workOrders)
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .where(
      and(
        or(
          eq(workOrders.orderNumber, cleanCode),
          isNumeric ? eq(workOrders.id, Number(cleanCode)) : sql`0=1`,
        ),
        scopedBranch != null ? eq(workOrders.branchId, scopedBranch) : sql`1=1`,
      ),
    )
    .limit(1);

  if (workOrder) {
    if (workOrder.status !== "READY") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "أمر الشغل غير جاهز للإرسال",
          why: `أمر الشغل ${workOrder.orderNumber} بحالة «${workOrder.status}» وليس جاهزاً (READY)`,
          doThis: "أكمل مراحل التنفيذ واضبط حالة أمر الشغل إلى «جاهز» أولاً",
        }),
      });
    }

    const [activeCn] = await db
      .select({ consignmentNumber: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments)
      .where(
        and(
          eq(deliveryConsignments.workOrderId, Number(workOrder.id)),
          sql`${deliveryConsignments.status} NOT IN ('CANCELLED', 'RETURNED')`,
        ),
      )
      .limit(1);
    if (activeCn) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "أمر الشغل مُسنَد للتوصيل مسبقاً",
          why: `أمر الشغل ${workOrder.orderNumber} مُسنَد مسبقاً بالإرسالية ${activeCn.consignmentNumber}`,
          doThis: "راجع تبويب «قيد التوصيل» لمتابعة الإرسالية أو طباعة بوليصتها",
        }),
      });
    }

    const res = await dispatchToDelivery(
      {
        workOrderId: Number(workOrder.id),
        partyId: input.partyId,
        deliveryFee: input.deliveryFee ?? workOrder.deliveryCost,
        recipientName: workOrder.customerName ?? undefined,
        recipientPhone: workOrder.deliveryPhone ?? workOrder.customerPhone ?? undefined,
        deliveryAddress: input.deliveryAddress ?? workOrder.deliveryAddress ?? undefined,
        notes: input.notes ?? undefined,
        assignedUserId: input.assignedUserId,
        clientRequestId: input.clientRequestId,
        externalTrackingRef: input.externalTrackingRef ?? null,
        partialDispatchConfirmed: input.partialDispatchConfirmed,
      },
      actor,
    );

    return {
      sourceType: "WORK_ORDER",
      sourceId: Number(workOrder.id),
      sourceNumber: workOrder.orderNumber,
      consignmentId: res.consignmentId,
      consignmentNumber: res.consignmentNumber,
      invoiceId: res.invoiceId,
      invoiceNumber: res.invoiceNumber,
      codAmount: res.codAmount,
      deliveryFee: res.deliveryFee,
      recipientName: workOrder.customerName ?? null,
      recipientPhone: workOrder.deliveryPhone ?? workOrder.customerPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? workOrder.deliveryAddress ?? null,
      partyName: party.name,
    };
  }

  // ٣. فحص الفواتير (Invoices)
  const [invoice] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      branchId: invoices.branchId,
      status: invoices.status,
      sourceType: invoices.sourceType,
      contactName: invoices.contactName,
      contactPhone: invoices.contactPhone,
      deliveryFee: invoices.deliveryFee,
      customerAddress: customers.address,
      invoiceNotes: invoices.notes,
    })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        or(
          eq(invoices.invoiceNumber, cleanCode),
          isNumeric ? eq(invoices.id, Number(cleanCode)) : sql`0=1`,
        ),
        scopedBranch != null ? eq(invoices.branchId, scopedBranch) : sql`1=1`,
      ),
    )
    .limit(1);

  if (invoice) {
    if (invoice.status === "CANCELLED" || invoice.status === "RETURNED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذر إسناد الفاتورة للتوصيل",
          why: `الفاتورة ${invoice.invoiceNumber} ملغاة أو مرتجعة مسبقاً`,
          doThis: "تأكد من رقم الفاتورة أو أنشئ فاتورة جديدة",
        }),
      });
    }

    // إذا كانت الفاتورة مرتبطة بطلب متجر، نستدعي مسار طلب المتجر لضمان الربط السليم
    if (invoice.sourceType === "ONLINE") {
      const [linkedOrder] = await db
        .select({ id: onlineOrders.id })
        .from(onlineOrders)
        .where(eq(onlineOrders.invoiceId, Number(invoice.id)))
        .limit(1);
      if (linkedOrder) {
        const dispatchActor: Actor = {
          userId: actor.userId,
          branchId: actor.branchId ?? Number(invoice.branchId ?? 1),
          role: actor.role,
        };
        const res = await dispatchOnlineOrder(
          {
            onlineOrderId: Number(linkedOrder.id),
            partyId: input.partyId,
            externalTrackingRef: input.externalTrackingRef ?? null,
          },
          dispatchActor,
        );
        const [createdCn] = res.consignmentId != null
          ? await db.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, Number(res.consignmentId))).limit(1)
          : [];
        return {
          sourceType: "ONLINE_ORDER",
          sourceId: Number(linkedOrder.id),
          sourceNumber: invoice.invoiceNumber,
          consignmentId: Number(res.consignmentId ?? createdCn?.id ?? 0),
          consignmentNumber: String(res.consignmentNumber ?? createdCn?.consignmentNumber ?? ""),
          invoiceId: res.invoiceId,
          invoiceNumber: res.invoiceNumber,
          codAmount: String(createdCn?.codAmount ?? res.total),
          deliveryFee: String(createdCn?.deliveryFee ?? "0"),
          recipientName: createdCn?.recipientName ?? invoice.contactName ?? null,
          recipientPhone: createdCn?.recipientPhone ?? invoice.contactPhone ?? null,
          deliveryAddress: createdCn?.deliveryAddress ?? input.deliveryAddress ?? invoice.customerAddress ?? null,
          partyName: party.name,
        };
      }
    }

    const res = await dispatchInvoiceToDelivery(
      {
        invoiceId: Number(invoice.id),
        partyId: input.partyId,
        deliveryFee: input.deliveryFee ?? invoice.deliveryFee,
        recipientName: invoice.contactName ?? undefined,
        recipientPhone: invoice.contactPhone ?? undefined,
        deliveryAddress: input.deliveryAddress ?? invoice.customerAddress ?? undefined,
        notes: input.notes ?? invoice.invoiceNotes ?? undefined,
        assignedUserId: input.assignedUserId,
        clientRequestId: input.clientRequestId,
        externalTrackingRef: input.externalTrackingRef ?? null,
        partialDispatchConfirmed: input.partialDispatchConfirmed,
      },
      actor,
    );

    return {
      sourceType: "INVOICE",
      sourceId: Number(invoice.id),
      sourceNumber: invoice.invoiceNumber,
      consignmentId: res.consignmentId,
      consignmentNumber: res.consignmentNumber,
      invoiceId: res.invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      codAmount: res.codAmount,
      deliveryFee: res.deliveryFee,
      recipientName: invoice.contactName ?? null,
      recipientPhone: invoice.contactPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? invoice.customerAddress ?? null,
      partyName: party.name,
    };
  }

  // ٤. فحص إن كان باركود إرسالية قائمة
  const [existingCn] = await db
    .select({
      consignmentNumber: deliveryConsignments.consignmentNumber,
      status: deliveryConsignments.status,
      partyId: deliveryConsignments.partyId,
    })
    .from(deliveryConsignments)
    .where(
      and(
        or(
          eq(deliveryConsignments.consignmentNumber, cleanCode),
          eq(deliveryConsignments.externalTrackingRef, cleanCode),
        ),
        scopedBranch != null ? eq(deliveryConsignments.branchId, scopedBranch) : sql`1=1`,
      ),
    )
    .limit(1);

  if (existingCn) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "الرمز الممسوح يخص إرسالية قائمة بالفعل",
        why: `الإرسالية ${existingCn.consignmentNumber} قائمة وحالتها «${existingCn.status}»`,
        doThis: "إذا كنت تريد استلام مرتجع، استخدم شاشة استلام المرتجعات بالباركود",
      }),
    });
  }

  throw new TRPCError({
    code: "NOT_FOUND",
    message: appErrorMessage({
      what: "لم يُعثر على طلب أو فاتورة مطابقة",
      why: `الرمز «${cleanCode}» لا يطابق أي طلب متجر أو أمر شغل أو فاتورة في فرعك`,
      doThis: "تأكد من مسح باركود الطلب الصحيح أو اكتب الرقم يدوياً",
    }),
  });
}
