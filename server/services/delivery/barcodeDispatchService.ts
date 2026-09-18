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
import { appErrorMessage } from "@shared/errors";
import { dispatchOnlineOrder } from "../storeAdmin/dispatchOnlineOrder";
import {
  namespaceAllowsTarget,
  prepareDeliveryBarcodeLookup,
  resolveUniqueDeliveryBarcodeTarget,
} from "./barcodeLookupPolicy";
import { dispatchToDelivery } from "./dispatch";
import { dispatchInvoiceToDelivery } from "./dispatchInvoice";
import { invoiceBarcodeSet, onlineOrderLabelToken, workOrderBarcodeSet } from "../barcodeService";
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
  qrPayload?: string | null;
  labelToken?: string | null;
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
  const lookup = prepareDeliveryBarcodeLookup(rawCode);
  const { code: cleanCode, systemCode, trackingCode, documentCode, namespace, numericId } = lookup;

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

  const scopedBranch = actor.role === "admin"
    ? null
    : (actor.branchId == null ? -1 : Number(actor.branchId));
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

  const [onlineCandidates, workOrderCandidates, invoiceCandidates, consignmentCandidates] = await Promise.all([
    namespaceAllowsTarget(namespace, "ONLINE_ORDER")
      ? db
          .select({
            id: onlineOrders.id,
            matchRank: sql<number>`CASE WHEN ${onlineOrders.orderNumber} IN (${cleanCode}, ${documentCode}, ${`ORD-${cleanCode}`}) THEN 100 ELSE 10 END`,
          })
          .from(onlineOrders)
          .where(and(
            namespace === "ONLINE_ORDER"
              ? or(eq(onlineOrders.orderNumber, systemCode), eq(onlineOrders.orderNumber, documentCode))
              : namespace === "NUMERIC"
                ? or(
                    eq(onlineOrders.orderNumber, cleanCode),
                    eq(onlineOrders.orderNumber, `ORD-${cleanCode}`),
                    numericId != null ? eq(onlineOrders.id, numericId) : sql`0=1`,
                  )
                : eq(onlineOrders.orderNumber, cleanCode),
            scopedBranch != null ? eq(onlineOrders.branchId, scopedBranch) : sql`1=1`,
          ))
          .limit(2)
      : Promise.resolve([]),
    namespaceAllowsTarget(namespace, "WORK_ORDER")
      ? db
          .select({
            id: workOrders.id,
            matchRank: sql<number>`CASE WHEN ${workOrders.orderNumber} IN (${cleanCode}, ${documentCode}, ${`WO-${cleanCode}`}) THEN 100 ELSE 10 END`,
          })
          .from(workOrders)
          .where(and(
            namespace === "WORK_ORDER"
              ? or(eq(workOrders.orderNumber, systemCode), eq(workOrders.orderNumber, documentCode))
              : namespace === "NUMERIC"
                ? or(
                    eq(workOrders.orderNumber, cleanCode),
                    eq(workOrders.orderNumber, `WO-${cleanCode}`),
                    numericId != null ? eq(workOrders.id, numericId) : sql`0=1`,
                  )
                : eq(workOrders.orderNumber, cleanCode),
            scopedBranch != null ? eq(workOrders.branchId, scopedBranch) : sql`1=1`,
          ))
          .limit(2)
      : Promise.resolve([]),
    namespaceAllowsTarget(namespace, "INVOICE")
      ? db
          .select({
            id: invoices.id,
            matchRank: sql<number>`CASE WHEN ${invoices.invoiceNumber} IN (${cleanCode}, ${documentCode}, ${`INV-${cleanCode}`}) THEN 100 ELSE 10 END`,
          })
          .from(invoices)
          .where(and(
            namespace === "INVOICE"
              ? or(eq(invoices.invoiceNumber, systemCode), eq(invoices.invoiceNumber, documentCode))
              : namespace === "NUMERIC"
                ? or(
                    eq(invoices.invoiceNumber, cleanCode),
                    eq(invoices.invoiceNumber, `INV-${cleanCode}`),
                    numericId != null ? eq(invoices.id, numericId) : sql`0=1`,
                  )
                : eq(invoices.invoiceNumber, cleanCode),
            scopedBranch != null ? eq(invoices.branchId, scopedBranch) : sql`1=1`,
          ))
          .limit(2)
      : Promise.resolve([]),
    namespaceAllowsTarget(namespace, "CONSIGNMENT")
      ? db
          .select({
            id: deliveryConsignments.id,
            matchRank: sql<number>`CASE
              WHEN ${deliveryConsignments.consignmentNumber} IN (${cleanCode}, ${systemCode}) THEN 100
              WHEN ${deliveryConsignments.externalTrackingRef} = ${trackingCode} THEN 50
              ELSE 10 END`,
          })
          .from(deliveryConsignments)
          .where(and(
            namespace === "CONSIGNMENT"
              ? eq(deliveryConsignments.consignmentNumber, systemCode)
              : namespace === "NUMERIC"
                ? or(
                    numericId != null ? eq(deliveryConsignments.id, numericId) : sql`0=1`,
                    eq(deliveryConsignments.consignmentNumber, cleanCode),
                    trackingCode
                      ? and(
                          eq(deliveryConsignments.partyId, Number(input.partyId)),
                          eq(deliveryConsignments.externalTrackingRef, trackingCode),
                        )
                      : sql`0=1`,
                  )
                : or(
                    eq(deliveryConsignments.consignmentNumber, systemCode),
                    trackingCode
                      ? and(
                          eq(deliveryConsignments.partyId, Number(input.partyId)),
                          eq(deliveryConsignments.externalTrackingRef, trackingCode),
                        )
                      : sql`0=1`,
                  ),
            scopedBranch != null ? eq(deliveryConsignments.branchId, scopedBranch) : sql`1=1`,
          ))
          .limit(2)
      : Promise.resolve([]),
  ]);

  const selectedTarget = resolveUniqueDeliveryBarcodeTarget(cleanCode, [
    ...onlineCandidates.map((row) => ({ kind: "ONLINE_ORDER" as const, id: Number(row.id), matchRank: Number(row.matchRank) })),
    ...workOrderCandidates.map((row) => ({ kind: "WORK_ORDER" as const, id: Number(row.id), matchRank: Number(row.matchRank) })),
    ...invoiceCandidates.map((row) => ({ kind: "INVOICE" as const, id: Number(row.id), matchRank: Number(row.matchRank) })),
    ...consignmentCandidates.map((row) => ({ kind: "CONSIGNMENT" as const, id: Number(row.id), matchRank: Number(row.matchRank) })),
  ]);

  // ١. فحص طلبات المتجر (Online Orders)
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
        selectedTarget?.kind === "ONLINE_ORDER"
          ? eq(onlineOrders.id, selectedTarget.id)
          : sql`0=1`,
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
        deliveryAddress: input.deliveryAddress ?? onlineOrder.shippingAddress ?? null,
        notes: input.notes ?? null,
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
      labelToken: onlineOrderLabelToken(onlineOrder.orderNumber),
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
      createdAt: workOrders.createdAt,
    })
    .from(workOrders)
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .where(
      and(
        selectedTarget?.kind === "WORK_ORDER"
          ? eq(workOrders.id, selectedTarget.id)
          : sql`0=1`,
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
      qrPayload: workOrderBarcodeSet({
        orderNumber: workOrder.orderNumber,
        createdAt: workOrder.createdAt,
        branchId: Number(workOrder.branchId),
      }).qrPayload,
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
      invoiceDate: invoices.invoiceDate,
      total: invoices.total,
    })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(
      and(
        selectedTarget?.kind === "INVOICE"
          ? eq(invoices.id, selectedTarget.id)
          : sql`0=1`,
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
        .select({ id: onlineOrders.id, orderNumber: onlineOrders.orderNumber })
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
          sourceNumber: linkedOrder.orderNumber,
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
          labelToken: onlineOrderLabelToken(linkedOrder.orderNumber),
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
      qrPayload: invoiceBarcodeSet({
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate.toISOString(),
        total: String(invoice.total),
        branchId: Number(invoice.branchId),
      }).qrPayload,
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
        selectedTarget?.kind === "CONSIGNMENT"
          ? eq(deliveryConsignments.id, selectedTarget.id)
          : sql`0=1`,
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
