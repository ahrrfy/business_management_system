/**
 * barcodeReturnService — خدمة استلام المرتجعات السريعة بالباركود.
 *
 * تتيح للموظف مسح باركود أي طرد راجع (رقم الإرسالية CN-، أو الرقم المرجعي للشركة،
 * أو رقم الفاتورة INV-، أو رقم طلب المتجر ORD-، أو أمر الشغل WO-)
 * ليتم استلام المرتجع وعكس المبيعات والمخزون وتحرير عهدة المندوب فورياً.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  deliveryShipmentMembers,
  invoices,
  onlineOrders,
  workOrders,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appErrorMessage } from "@shared/errors";
import {
  namespaceAllowsTarget,
  prepareDeliveryBarcodeLookup,
  resolveActiveInvoiceCandidates,
  resolveUniqueDeliveryBarcodeTarget,
} from "./barcodeLookupPolicy";
import { returnConsignment } from "./returns";
import { returnShipment } from "./shipmentOperations";
import type { DeliveryTxActor } from "./types";

export interface BarcodeReturnInput {
  barcode: string;
  returnReason?: string | null;
  refundShiftId?: number | null;
  clientRequestId?: string | null;
}

export interface BarcodeReturnResult {
  consignmentId: number;
  consignmentNumber: string;
  invoiceId?: number | null;
  reversed: boolean;
  partyName?: string | null;
  recipientName?: string | null;
  codAmount: string;
  returnReason: string;
}

export async function returnByBarcode(
  input: BarcodeReturnInput,
  actor: DeliveryTxActor,
): Promise<BarcodeReturnResult> {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  const rawCode = input.barcode?.trim();
  if (!rawCode) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر استلام المرتجع",
        why: "رمز الباركود المدخل فارغ",
        doThis: "امسح أو أدخل باركود الطرد أو الفاتورة بشكل صحيح",
      }),
    });
  }
  const lookup = prepareDeliveryBarcodeLookup(rawCode);
  const { code: cleanCode, systemCode, trackingCode, strippedTrackingCode, documentCode, namespace, numericId } = lookup;
  const scopedBranch = actor.role === "admin"
    ? null
    : (actor.branchId == null ? -1 : Number(actor.branchId));

  const rawInvoiceCandidates = namespaceAllowsTarget(namespace, "INVOICE")
    ? await db
        .select({
          id: invoices.id,
          correctedByInvoiceId: invoices.correctedByInvoiceId,
          matchRank: sql<number>`CASE WHEN ${invoices.invoiceNumber} IN (${cleanCode}, ${systemCode}, ${documentCode}, ${`INV-${cleanCode}`}) THEN 100 ELSE 10 END`,
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
        .orderBy(desc(invoices.id))
        .limit(5)
    : [];

  const resolvedInvoices = await resolveActiveInvoiceCandidates(
    rawInvoiceCandidates,
    async (nextId) => {
      const [next] = await db
        .select({
          id: invoices.id,
          correctedByInvoiceId: invoices.correctedByInvoiceId,
        })
        .from(invoices)
        .where(and(
          eq(invoices.id, nextId),
          scopedBranch != null ? eq(invoices.branchId, scopedBranch) : sql`1=1`,
        ))
        .limit(1);
      return next ?? null;
    },
  );
  const allMatchedInvoiceIds = resolvedInvoices.map((r) => Number(r.id)).filter((id) => id > 0);
  const docMatchedInvoiceIds = resolvedInvoices
    .filter((r) => Number(r.matchRank ?? 0) >= 100)
    .map((r) => Number(r.id))
    .filter((id) => id > 0);

  const candidateCondition = namespace === "CONSIGNMENT"
    ? or(eq(deliveryConsignments.consignmentNumber, systemCode), eq(deliveryConsignments.consignmentNumber, documentCode))
    : namespace === "INVOICE"
      ? or(
          eq(invoices.invoiceNumber, systemCode),
          eq(invoices.invoiceNumber, documentCode),
          allMatchedInvoiceIds.length ? inArray(deliveryConsignments.invoiceId, allMatchedInvoiceIds) : sql`0=1`,
        )
      : namespace === "WORK_ORDER"
        ? or(eq(workOrders.orderNumber, systemCode), eq(workOrders.orderNumber, documentCode))
        : namespace === "ONLINE_ORDER"
          ? or(eq(onlineOrders.orderNumber, systemCode), eq(onlineOrders.orderNumber, documentCode))
          : namespace === "NUMERIC"
            ? or(
                numericId != null ? eq(deliveryConsignments.id, numericId) : sql`0=1`,
                eq(deliveryConsignments.consignmentNumber, cleanCode),
                trackingCode
                  ? or(
                      eq(deliveryConsignments.externalTrackingRef, trackingCode),
                      strippedTrackingCode
                        ? sql`TRIM(LEADING '0' FROM ${deliveryConsignments.externalTrackingRef}) = ${strippedTrackingCode}`
                        : sql`0=1`,
                    )
                  : sql`0=1`,
                numericId != null ? eq(invoices.id, numericId) : sql`0=1`,
                eq(invoices.invoiceNumber, cleanCode),
                eq(invoices.invoiceNumber, `INV-${cleanCode}`),
                allMatchedInvoiceIds.length ? inArray(deliveryConsignments.invoiceId, allMatchedInvoiceIds) : sql`0=1`,
                numericId != null ? eq(workOrders.id, numericId) : sql`0=1`,
                eq(workOrders.orderNumber, cleanCode),
                eq(workOrders.orderNumber, `WO-${cleanCode}`),
                numericId != null ? eq(onlineOrders.id, numericId) : sql`0=1`,
                eq(onlineOrders.orderNumber, cleanCode),
                eq(onlineOrders.orderNumber, `ORD-${cleanCode}`),
              )
            : or(
                eq(deliveryConsignments.consignmentNumber, systemCode),
                eq(deliveryConsignments.consignmentNumber, cleanCode),
                trackingCode
                  ? or(
                      eq(deliveryConsignments.externalTrackingRef, trackingCode),
                      strippedTrackingCode
                        ? sql`TRIM(LEADING '0' FROM ${deliveryConsignments.externalTrackingRef}) = ${strippedTrackingCode}`
                        : sql`0=1`,
                    )
                  : sql`0=1`,
                eq(invoices.invoiceNumber, cleanCode),
                allMatchedInvoiceIds.length ? inArray(deliveryConsignments.invoiceId, allMatchedInvoiceIds) : sql`0=1`,
                eq(workOrders.orderNumber, cleanCode),
                eq(onlineOrders.orderNumber, cleanCode),
              );

  const isActiveCnSql = sql`(${deliveryConsignments.status} NOT IN ('CANCELLED', 'RETURNED') AND ${deliveryConsignments.parcelStatus} NOT IN ('CANCELLED', 'RETURNED'))`;
  const docMatchSql = sql`(${deliveryConsignments.consignmentNumber} IN (${cleanCode}, ${systemCode}, ${documentCode})
    OR ${invoices.invoiceNumber} IN (${cleanCode}, ${systemCode}, ${documentCode}, ${`INV-${cleanCode}`})
    OR ${docMatchedInvoiceIds.length ? inArray(deliveryConsignments.invoiceId, docMatchedInvoiceIds) : sql`0=1`}
    OR ${workOrders.orderNumber} IN (${cleanCode}, ${systemCode}, ${documentCode}, ${`WO-${cleanCode}`})
    OR ${onlineOrders.orderNumber} IN (${cleanCode}, ${systemCode}, ${documentCode}, ${`ORD-${cleanCode}`}))`;

  const candidateRows = await db
    .select({
      id: deliveryConsignments.id,
      matchRank: sql<number>`MAX(CASE
        WHEN ${docMatchSql} THEN CASE WHEN ${isActiveCnSql} THEN 100 ELSE 80 END
        WHEN ${deliveryConsignments.externalTrackingRef} = ${trackingCode} THEN CASE WHEN ${isActiveCnSql} THEN 50 ELSE 35 END
        WHEN ${strippedTrackingCode != null} AND TRIM(LEADING '0' FROM ${deliveryConsignments.externalTrackingRef}) = ${strippedTrackingCode ?? ""} THEN CASE WHEN ${isActiveCnSql} THEN 40 ELSE 25 END
        ELSE CASE WHEN ${isActiveCnSql} THEN 10 ELSE 5 END END)`,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(workOrders, eq(deliveryConsignments.workOrderId, workOrders.id))
    .leftJoin(onlineOrders, or(
      and(
        eq(deliveryConsignments.sourceType, "ONLINE_ORDER"),
        eq(deliveryConsignments.sourceId, onlineOrders.id),
      ),
      eq(deliveryConsignments.invoiceId, onlineOrders.invoiceId),
    ))
    .where(and(
      candidateCondition,
      scopedBranch != null ? eq(deliveryConsignments.branchId, scopedBranch) : sql`1=1`,
    ))
    .groupBy(deliveryConsignments.id)
    .orderBy(desc(deliveryConsignments.id))
    .limit(5);

  const selectedTarget = resolveUniqueDeliveryBarcodeTarget(
    cleanCode,
    candidateRows.map((row) => ({ kind: "CONSIGNMENT" as const, id: Number(row.id), matchRank: Number(row.matchRank) })),
  );

  const [matchedCn] = await db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      externalTrackingRef: deliveryConsignments.externalTrackingRef,
      status: deliveryConsignments.status,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      branchId: deliveryConsignments.branchId,
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      invoiceId: deliveryConsignments.invoiceId,
      workOrderId: deliveryConsignments.workOrderId,
      recipientName: deliveryConsignments.recipientName,
      recipientPhone: deliveryConsignments.recipientPhone,
      codAmount: deliveryConsignments.codAmount,
    })
    .from(deliveryConsignments)
    .leftJoin(deliveryParties, eq(deliveryConsignments.partyId, deliveryParties.id))
    .where(and(
      selectedTarget?.kind === "CONSIGNMENT"
        ? eq(deliveryConsignments.id, selectedTarget.id)
        : sql`0=1`,
      scopedBranch != null ? eq(deliveryConsignments.branchId, scopedBranch) : sql`1=1`,
    ))
    .limit(1);

  if (!matchedCn) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "لم يُعثر على إرسالية مطابقة",
        why: `الرمز «${cleanCode}» لا يطابق أي إرسالية توصيل أو فاتورة أو طلب في فرعك`,
        doThis: "تأكد من صحة رقم الطرد أو ابحث بالرقم المرجعي لشركة التوصيل",
      }),
    });
  }

  if (matchedCn.status === "RETURNED" || matchedCn.parcelStatus === "RETURNED") {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "الإرسالية مسجلة كمرتجع مسبقاً",
        why: `الإرسالية ${matchedCn.consignmentNumber} قد تم استلامها وإرجاع مخزونها وتصفير عهدتها مسبقاً`,
        doThis: "لا داعي لتكرار المسح — راجع سجل المرتجعات للتأكد",
      }),
    });
  }

  if (matchedCn.parcelStatus === "DELIVERED" && matchedCn.moneyStatus === "SETTLED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر إرجاع الإرسالية عبر مسار التوصيل",
        why: `الإرسالية ${matchedCn.consignmentNumber} مُسلَّمة ومُسوّاة مالياً بالكامل`,
        doThis:
          "إذا كان العميل يريد إرجاع البضاعة بعد الاستلام، استخدم شاشة مرتجع المبيعات",
      }),
    });
  }

  const defaultReason = input.returnReason?.trim() || "مرتجع طرد بالباركود";

  const [shipmentMembership] = await db
    .select()
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, Number(matchedCn.id)))
    .limit(1);
  if (shipmentMembership) {
    await returnShipment(
      {
        consignmentId: Number(matchedCn.id),
        reason: defaultReason,
        refundShiftId: input.refundShiftId,
        clientRequestId:
          input.clientRequestId ?? `barcode-shipment-return:${matchedCn.id}`,
      },
      actor,
    );
    return {
      consignmentId: Number(shipmentMembership.leaderConsignmentId),
      consignmentNumber: matchedCn.consignmentNumber,
      reversed: true,
      partyName: matchedCn.partyName,
      recipientName: matchedCn.recipientName,
      codAmount: String(matchedCn.codAmount),
      returnReason: defaultReason,
    };
  }

  const res = await returnConsignment(Number(matchedCn.id), {
    ...actor,
    returnReason: defaultReason,
    refundShiftId: input.refundShiftId,
    clientRequestId: input.clientRequestId,
  });

  return {
    consignmentId: Number(matchedCn.id),
    consignmentNumber: matchedCn.consignmentNumber,
    invoiceId: res.invoiceId,
    reversed: res.reversed,
    partyName: matchedCn.partyName,
    recipientName: matchedCn.recipientName,
    codAmount: String(matchedCn.codAmount),
    returnReason: defaultReason,
  };
}
