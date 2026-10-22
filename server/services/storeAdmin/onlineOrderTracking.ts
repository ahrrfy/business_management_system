import { effectiveDeliveryLedgerEntrySql } from "../delivery/legacyLedger";
import { eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  deliveryConsignments,
  deliveryEvents,
  deliveryParties,
  onlineOrders,
  users,
} from "../../../drizzle/schema";
import { alias } from "drizzle-orm/mysql-core";
import type { DB } from "../../db";
import {
  deriveOnlineOrderLifecycle,
  type OnlineOrderLifecycle,
} from "@shared/onlineOrderLifecycle";
import { deliveryEventLabel } from "@shared/deliveryEventType";
import { orderStatusLabel } from "@shared/onlineOrderStatus";
import { consignmentShortfallAssignedSql } from "../delivery/openParcelPredicates";

/** Indexed invoice identity wins; only an unlinked legacy order falls back to its source identity. */
export const latestOnlineOrderConsignmentId = sql<number>`COALESCE(
  (SELECT dc.id FROM deliveryConsignments dc WHERE dc.invoiceId = ${onlineOrders.invoiceId}
    AND dc.branchId = ${onlineOrders.branchId} ORDER BY dc.id DESC LIMIT 1),
  (SELECT dc.id FROM deliveryConsignments dc WHERE ${onlineOrders.invoiceId} IS NULL
    AND dc.sourceType = 'ONLINE_ORDER' AND dc.sourceId = ${onlineOrders.id}
    AND dc.branchId = ${onlineOrders.branchId} ORDER BY dc.id DESC LIMIT 1))`;

/** One expression for list, status filter, KPI counts and public tracking; no historical writes. */
export const currentOnlineOrderStatus = sql<string>`CASE WHEN ${onlineOrders.status} IN ('SHIPPED', 'DELIVERED')
  THEN COALESCE((SELECT CASE dc.parcelStatus
    WHEN 'DELIVERED' THEN 'DELIVERED' WHEN 'RETURNED' THEN 'CANCELLED'
    WHEN 'CANCELLED' THEN 'PROCESSING' ELSE 'SHIPPED' END
    FROM deliveryConsignments dc WHERE dc.id = ${latestOnlineOrderConsignmentId}), ${onlineOrders.status})
  ELSE ${onlineOrders.status} END`;

/** Bounded batch read: never one HTTP/DB request per table row. Internal facts stay in staff APIs. */
export async function loadOnlineOrderLifecycles(
  db: DB,
  orderIds: number[],
): Promise<Map<number, OnlineOrderLifecycle>> {
  if (orderIds.length === 0) return new Map();
  const orderActor = alias(users, "onlineOrderTrackingActor");
  const rows = await db
    .select({
      orderId: onlineOrders.id,
      orderStatus: onlineOrders.status,
      createdAt: onlineOrders.createdAt,
      updatedAt: onlineOrders.updatedAt,
      claimedAt: onlineOrders.claimedAt,
      preparedAt: onlineOrders.preparedAt,
      consignmentId: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      status: deliveryConsignments.status,
      returnDeclaredAt: deliveryConsignments.returnDeclaredAt,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
      remittanceId: deliveryConsignments.remittanceId,
      deliveryPartyName: deliveryParties.name,
      shortfallAssignedAmount: consignmentShortfallAssignedSql,
      customerCollectedAmount: sql<string>`COALESCE((SELECT SUM(CASE WHEN dl.entryType = 'COD_COLLECTED' THEN dl.amount
      WHEN dl.entryType = 'COD_RETURNED' THEN -dl.amount ELSE 0 END) FROM deliveryLedgerEntries dl
      WHERE dl.consignmentId = ${deliveryConsignments.id} AND dl.partyId = ${deliveryConsignments.partyId}
      AND ${effectiveDeliveryLedgerEntrySql("dl")}
      AND dl.occurredAt >= ${deliveryConsignments.dispatchedAt}), 0)`,
      customerCounterCollectedAmount: sql<string>`COALESCE((SELECT SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(ce.payload, '$.amount')) AS DECIMAL(15,2)))
      FROM deliveryEvents ce WHERE ce.consignmentId = ${deliveryConsignments.id} AND ce.eventType = 'COUNTER_SETTLED'
      AND ce.occurredAt >= ${deliveryConsignments.dispatchedAt}
      AND JSON_UNQUOTE(JSON_EXTRACT(ce.payload, '$.source')) = 'COUNTER'), 0)`,
      eventType: deliveryEvents.eventType,
      eventAt: deliveryEvents.occurredAt,
      actorName: users.name,
      orderAction: auditLogs.action,
      orderActionAt: auditLogs.createdAt,
      orderActionActor: orderActor.name,
      orderActionValue: auditLogs.newValue,
    })
    .from(onlineOrders)
    .leftJoin(
      deliveryConsignments,
      eq(deliveryConsignments.id, latestOnlineOrderConsignmentId),
    )
    .leftJoin(
      deliveryParties,
      eq(deliveryParties.id, deliveryConsignments.partyId),
    )
    .leftJoin(
      deliveryEvents,
      eq(
        deliveryEvents.id,
        sql<number>`(SELECT de.id FROM deliveryEvents de
      WHERE de.consignmentId = ${deliveryConsignments.id} ORDER BY de.occurredAt DESC, de.id DESC LIMIT 1)`,
      ),
    )
    .leftJoin(users, eq(users.id, deliveryEvents.actorUserId))
    .leftJoin(
      auditLogs,
      eq(
        auditLogs.id,
        sql<number>`(SELECT al.id FROM auditLogs al
      WHERE al.entityType = 'onlineOrder' AND CAST(al.entityId AS BINARY) = CAST(${onlineOrders.id} AS BINARY)
      AND al.action LIKE 'store.order.%' ORDER BY al.createdAt DESC, al.id DESC LIMIT 1)`,
      ),
    )
    .leftJoin(orderActor, eq(orderActor.id, auditLogs.userId))
    .where(inArray(onlineOrders.id, orderIds));
  return new Map(
    rows.map((r) => {
      // A released/cancelled assignment is history once the order returned to preparation.
      const useParcel =
        r.consignmentId != null &&
        (["SHIPPED", "DELIVERED"].includes(r.orderStatus) ||
          (r.orderStatus === "CANCELLED" &&
            ["RETURNED", "CANCELLED"].includes(r.parcelStatus ?? "")));
      const facts = useParcel
        ? deriveOnlineOrderLifecycle({
            parcelStatus: r.parcelStatus!,
            moneyStatus: r.moneyStatus!,
            status: r.status!,
            codAmount: String(r.codAmount ?? "0"),
            collectedAmount: String(r.collectedAmount ?? "0"),
            counterSettledAmount: String(r.counterSettledAmount ?? "0"),
            customerCollectedAmount: String(r.customerCollectedAmount),
            customerCounterCollectedAmount: String(
              r.customerCounterCollectedAmount,
            ),
            shortfallAssignedAmount: String(r.shortfallAssignedAmount ?? "0"),
            remittanceId: r.remittanceId,
            returnDeclaredAt: r.returnDeclaredAt,
          })
        : {
            label:
              ["CONFIRMED", "PROCESSING"].includes(r.orderStatus) &&
              r.parcelStatus === "CANCELLED"
                ? "بانتظار إعادة الإسناد"
                : r.preparedAt && r.orderStatus === "PROCESSING"
                  ? "تم التجهيز"
                  : orderStatusLabel(r.orderStatus),
            collectionLabel: null,
            remittanceLabel: null,
            trackingComplete: r.orderStatus === "CANCELLED",
            customerPhase:
              ["CONFIRMED", "PROCESSING"].includes(r.orderStatus) &&
              r.parcelStatus === "CANCELLED"
                ? ("AWAITING_REASSIGNMENT" as const)
                : undefined,
          };
      let latestEvent: {
        label: string;
        occurredAt: Date;
        actorName: string | null;
      } =
        r.orderStatus === "CANCELLED"
          ? { label: "إلغاء الطلب", occurredAt: r.updatedAt, actorName: null }
          : {
              label: r.preparedAt
                ? "تم التجهيز"
                : r.claimedAt
                  ? "استلام الطلب للتجهيز"
                  : "إنشاء الطلب",
              occurredAt: r.preparedAt ?? r.claimedAt ?? r.createdAt,
              actorName: null,
            };
      if (r.eventType && r.eventAt && r.eventAt >= latestEvent.occurredAt) {
        latestEvent = {
          label: deliveryEventLabel(r.eventType),
          occurredAt: r.eventAt,
          actorName: r.actorName ?? null,
        };
      }
      const actionValue = r.orderActionValue as { status?: string } | null;
      // These legacy timestamps have second precision. A tied dispatch audit must not
      // mask physical delivery evidence; terminal cancellation also keeps its priority.
      const preferTiedOrderAction =
        !useParcel &&
        (r.orderStatus !== "CANCELLED" || actionValue?.status === "CANCELLED");
      if (
        r.orderAction &&
        r.orderActionAt &&
        (r.orderActionAt > latestEvent.occurredAt ||
          (preferTiedOrderAction &&
            r.orderActionAt.getTime() === latestEvent.occurredAt.getTime()))
      ) {
        const actions: Record<string, string> = {
          "store.order.claim": "استلام الطلب للتجهيز",
          "store.order.markPrepared": "تم التجهيز",
          "store.order.reactivateAndConfirm": "إعادة تفعيل وتثبيت الطلب",
          "store.order.updateContact": "تحديث التواصل",
          "store.order.autoAssignRoundRobin": "إسناد مسؤولية التجهيز",
          "store.order.update": "تعديل بيانات الطلب",
          "store.order.dispatch": "إسناد لجهة التوصيل",
        };
        latestEvent = {
          label:
            actions[r.orderAction] ??
            orderStatusLabel(actionValue?.status ?? r.orderStatus),
          occurredAt: r.orderActionAt,
          actorName: r.orderActionActor ?? null,
        };
      }
      return [
        Number(r.orderId),
        {
          ...facts,
          label:
            r.orderStatus === "CANCELLED" && r.parcelStatus !== "RETURNED"
              ? orderStatusLabel("CANCELLED")
              : facts.label,
          customerPhase:
            r.orderStatus === "CANCELLED" && r.parcelStatus !== "RETURNED"
              ? undefined
              : facts.customerPhase,
          trackingComplete:
            r.orderStatus === "CANCELLED" || facts.trackingComplete === true,
          consignmentId: r.consignmentId,
          consignmentNumber: r.consignmentNumber,
          deliveryPartyName: r.deliveryPartyName,
          latestEvent,
        },
      ];
    }),
  );
}
