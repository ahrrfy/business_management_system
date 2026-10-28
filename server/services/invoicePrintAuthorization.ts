import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, invoices, shifts, workOrders } from "../../drizzle/schema";
import { appErrorMessage } from "../../shared/errors";
import { VOIDED_INVOICE_STATUSES } from "../../shared/invoiceStatus";
import {
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "../../shared/operationPermissions";
import { canCrossBranches } from "../lib/branchAuthority";
import { logAuditTx, type AuditMetadata } from "./auditService";
import { withTx, type MaybeScopedActor } from "./tx";

export type InvoicePrintPurpose =
  | "THERMAL"
  | "A4"
  | "WAREHOUSE"
  | "SHIPPING_LABEL";
export type InvoicePrintMode = "PRINT" | "REPRINT";
export type InvoicePrintActor = MaybeScopedActor & {
  canonical: boolean;
  scopedOwnerId: number | null;
  invoiceScope: "sales" | "reception" | "print" | null;
};
export type InvoicePrintRequest = {
  invoiceId: number;
  requestId: string;
  purpose: InvoicePrintPurpose;
};
type InvoicePrintRecord = {
  id: number;
  invoiceNumber: string;
  branchId: number;
  createdBy: number | null;
  status: string;
  sourceType: string;
  shiftId: number | null;
  shiftType: string | null;
  workOrderCreatedBy: number | null;
};

function deny(why: string): never {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: "تعذّر تفويض طباعة المستند",
      why,
      doThis: "اختر فاتورة ضمن صلاحياتك أو راجع مسؤول الصلاحيات",
    }),
  });
}

/** Transport-neutral check, also used by the raw Express bridge. */
export function assertDirectPrintBridgeAuthorized(user: OperationUser): void {
  if (user.isOwner) return;
  if (hasOperationPolicy(user)) {
    if (!operationDecision(user, "invoicePrinting.authorizeBridge").allowed)
      deny("صلاحية الإرسال إلى الطابعة المباشرة غير ممنوحة لحسابك");
    return;
  }
  if (user.role === "courier")
    deny("مندوب التوصيل غير مخوّل بالطابعة المباشرة للمتجر");
}

/** Invoice identity, ownership and current state come from locked database rows. */
export function assertInvoicePrintScope(
  actor: InvoicePrintActor,
  invoice: InvoicePrintRecord,
  purpose: InvoicePrintPurpose,
): void {
  if (!canCrossBranches(actor) && actor.branchId !== invoice.branchId)
    deny("الفاتورة لا تنتمي إلى الفرع المسند لحسابك");
  if (!actor.invoiceScope) deny("عرض هذه الفاتورة غير متاح لحسابك");
  if (actor.canonical && !actor.isOwner && actor.scopedOwnerId != null) {
    if (invoice.createdBy !== actor.scopedOwnerId)
      deny("نطاق صلاحية الطباعة يقتصر على الفواتير التي أنشأتها");
  } else if (!actor.canonical) {
    if (actor.invoiceScope === "reception") {
      if (
        invoice.shiftType !== "RECEPTION" &&
        !(invoice.shiftId == null && invoice.sourceType === "WORKORDER")
      )
        deny("الفاتورة خارج قناة خدمة العملاء المصرح بها");
    } else if (actor.invoiceScope === "print") {
      if (invoice.shiftType !== "PRINT_SERVICES")
        deny("الفاتورة خارج محطة كاشير الطباعة");
    } else if (
      actor.scopedOwnerId != null &&
      invoice.createdBy !== actor.scopedOwnerId &&
      invoice.workOrderCreatedBy !== actor.scopedOwnerId &&
      purpose !== "SHIPPING_LABEL" &&
      purpose !== "WAREHOUSE" &&
      invoice.sourceType !== "ONLINE"
    ) {
      deny("الفاتورة ليست من سجلاتك المسموح طباعتها");
    }
  }
  if ((VOIDED_INVOICE_STATUSES as readonly string[]).includes(invoice.status))
    deny("الفاتورة ألغيت أو استبدلت بفـاتورة مصححة");
  if (
    invoice.status === "RETURNED" &&
    (purpose === "WAREHOUSE" || purpose === "SHIPPING_LABEL")
  )
    deny("الفاتورة مرتجعة بالكامل ولا تصلح لمستند تسليم أو شحن جديد");
}

/** This journal proves authorization only; it never asserts paper completion. */
export async function authorizeInvoicePrint(
  input: InvoicePrintRequest,
  mode: InvoicePrintMode,
  actor: InvoicePrintActor,
  audit: AuditMetadata,
) {
  return withTx(
    async (tx) => {
      const [head] = await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          branchId: invoices.branchId,
          createdBy: invoices.createdBy,
          status: invoices.status,
          sourceType: invoices.sourceType,
          shiftId: invoices.shiftId,
        })
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
        .for("update");
      if (!head)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "الفاتورة غير موجودة",
            why: "لم يعد المستند المطلوب متاحاً",
            doThis: "حدّث قائمة الفواتير واختر المستند الصحيح",
          }),
        });
      const [shift] =
        head.shiftId == null
          ? []
          : await tx
              .select({ shiftType: shifts.shiftType })
              .from(shifts)
              .where(eq(shifts.id, head.shiftId))
              .limit(1);
      const [workOrder] = await tx
        .select({ createdBy: workOrders.createdBy })
        .from(workOrders)
        .where(eq(workOrders.invoiceId, head.id))
        .limit(1);
      assertInvoicePrintScope(
        actor,
        {
          ...head,
          shiftType: shift?.shiftType ?? null,
          workOrderCreatedBy: workOrder?.createdBy ?? null,
        },
        input.purpose,
      );

      const action =
        mode === "PRINT"
          ? "invoice.print_authorized"
          : "invoice.reprint_authorized";
      const [prior] = await tx
        .select({
          userId: auditLogs.userId,
          action: auditLogs.action,
          newValue: auditLogs.newValue,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "invoice"),
            eq(auditLogs.entityId, String(head.id)),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLogs.newValue}, '$.requestId')) = ${input.requestId}`,
          ),
        )
        .limit(1);
      if (prior) {
        const saved = prior.newValue as { purpose?: string } | null;
        if (
          prior.userId !== actor.userId ||
          prior.action !== action ||
          saved?.purpose !== input.purpose
        )
          deny("معرّف طلب الطباعة استُخدم لمستند أو غرض مختلف");
        return {
          authorized: true as const,
          requestId: input.requestId,
          mode,
          invoiceNumber: head.invoiceNumber,
        };
      }
      if (mode === "PRINT") {
        const [first] = await tx
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.entityType, "invoice"),
              eq(auditLogs.entityId, String(head.id)),
              eq(auditLogs.action, action),
            ),
          )
          .limit(1);
        if (first)
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "سبق تفويض الطباعة الأولى للفاتورة",
              why: "تكرار الطباعة يتطلب صلاحية إعادة الطباعة المستقلة",
              doThis: "استخدم إعادة الطباعة أو اطلب منح صلاحيتها من الإدارة",
            }),
          });
      }
      await logAuditTx(
        tx,
        { ...audit, userId: actor.userId, branchId: head.branchId },
        {
          action,
          entityType: "invoice",
          entityId: head.id,
          newValue: {
            requestId: input.requestId,
            purpose: input.purpose,
            mode,
            status: "AUTHORIZED_ONLY",
            invoiceNumber: head.invoiceNumber,
          },
        },
      );
      return {
        authorized: true as const,
        requestId: input.requestId,
        mode,
        invoiceNumber: head.invoiceNumber,
      };
    },
    { gate: "NONE" },
  );
}
