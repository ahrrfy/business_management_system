import { and, asc, eq, like, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { stripDocPrefix } from "@shared/documentNumber";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { customers, deliveryConsignments, invoices, workOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { prepareDeliveryBarcodeLookup } from "../delivery/barcodeLookupPolicy";
import { money, round2 } from "../money";

export type WorkOrderStatus = typeof workOrders.$inferSelect["status"];

export interface SiblingWorkOrderItem {
  id: number;
  orderNumber: string;
  title: string;
  status: WorkOrderStatus;
  salePrice: string;
  deposit: string | null;
  hasDelivery: boolean;
  customerName: string | null;
  customerPhone: string | null;
}

/**
 * يستنتج الإجمالي الفعّال والمبلغ المسدَّد فعلياً لأمر شغل عند التسليم المباشر:
 * إذا كان لأمر الشغل فاتورة قائمة غير ميتة (مُنشأة عند إسناد سابق أُلغي أو أُرجع الطرد منه)،
 * تكون أرصدة الفاتورة الحالية (الإجمالي ناقص المرتجع، والمدفوع الفعلي) هي مصدر الحقيقة المحاسبي
 * حتى لا يفشل التسليم بسبب تحصيل لاحق جرى على الفاتورة خارج حقل workOrders.deposit.
 */
export function resolveWorkOrderHandoverFinancials(
  wo: {
    salePrice: string;
    deposit: string | null;
    invoiceId?: number | null;
  },
  linkedInvoice?: {
    status: string | null;
    total: string | null;
    returnedTotal?: string | null;
    paidAmount?: string | null;
  } | null,
): { salePrice: string; deposit: string | null } {
  if (
    wo.invoiceId != null &&
    linkedInvoice != null &&
    linkedInvoice.status != null &&
    !isDeadInvoiceStatus(linkedInvoice.status)
  ) {
    const netTotal = round2(
      money(linkedInvoice.total ?? wo.salePrice).minus(
        money(linkedInvoice.returnedTotal ?? "0"),
      ),
    );
    const effectiveTotal = netTotal.gt(0) ? netTotal : money(0);
    const effectivePaid = round2(money(linkedInvoice.paidAmount ?? "0"));
    return {
      salePrice: effectiveTotal.toFixed(2),
      deposit: effectivePaid.toFixed(2),
    };
  }
  return {
    salePrice: String(wo.salePrice),
    deposit: wo.deposit != null ? String(wo.deposit) : null,
  };
}

/**
 * يستبعد أوامر الشغل بحالة READY التي أُسندت فعلياً لإرسالية توصيل نشطة
 * (حيث لم تُلغَ الإرسالية ولم ترجع إلى المحل)، بحيث يختفي الطلب من لوحة الكانبان
 * لجميع الأدوار فور إسناده للتوصيل ويعود تلقائياً إن أُلغي الإسناد أو أُرجع لـ READY.
 */
export function excludeDispatchedReadySql(): SQL {
  return sql`NOT (${workOrders.status} = 'READY' AND EXISTS (
    SELECT 1 FROM deliveryConsignments dc
    WHERE dc.workOrderId = ${workOrders.id}
      AND dc.consignmentStatus NOT IN ('CANCELLED', 'RETURNED')
  ))`;
}

/**
 * شرط ربط أحدث إرسالية نشطة بأمر الشغل مع استبعاد CANCELLED وRETURNED معاً،
 * لمنع تكرار صفّ أمر الشغل (fan-out) عند وجود إرسالية مرتجعة قديمة وإرسالية نشطة جديدة.
 */
export function activeWorkOrderConsignmentJoinCondition(): SQL {
  return and(
    eq(deliveryConsignments.workOrderId, workOrders.id),
    notInArray(deliveryConsignments.status, ["CANCELLED", "RETURNED"]),
    sql`${deliveryConsignments.id} = (
      SELECT MAX(dc_latest.id)
      FROM deliveryConsignments dc_latest
      WHERE dc_latest.workOrderId = ${workOrders.id}
        AND dc_latest.consignmentStatus NOT IN ('CANCELLED', 'RETURNED')
    )`,
  )!;
}

const HISTORICAL_DOC_NUMBER_RE =
  /^(?:INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS?|DRF|RET|PAY|REC)-\d+-\d{8}-\d+(?:-\d+)*$/i;
const HISTORICAL_DOC_BASE_RE =
  /^((?:INV|WO|PO|QUO|VCH|TRN|EXC|GIFT|ORD|CNS?|DRF|RET|PAY|REC)-\d+-\d{8}-\d+)(?:-\d+)+$/i;

/**
 * يستخرج الرقم الأساسي للوصل الموحّد (مثل "103757" من "103757" أو "WO-103757" أو "103757-1")
 * بشرط ألا يقل طوله عن 3 محارف وأن يخلو من محارف البدل في LIKE (% و _).
 */
export function extractUnifiedReceiptBaseCode(rawCode: string): string | null {
  const trimmed = String(rawCode ?? "").trim();
  if (!trimmed) return null;

  const lookup = prepareDeliveryBarcodeLookup(trimmed);
  const candidate = (lookup.documentCode || lookup.code || trimmed).trim();
  if (!candidate) return null;

  let baseCode: string;
  const stripped = stripDocPrefix(candidate);
  if (HISTORICAL_DOC_NUMBER_RE.test(stripped)) {
    const histMatch = HISTORICAL_DOC_BASE_RE.exec(stripped);
    baseCode = histMatch ? histMatch[1]! : stripped;
  } else {
    const withoutPrefix = stripped.replace(/^(?:WO|INV|ORD|DRF|RCP)-/i, "");
    const siblingMatch = /^(.{3,}?)-\d+$/.exec(withoutPrefix);
    baseCode = siblingMatch ? siblingMatch[1]! : withoutPrefix;
  }

  baseCode = baseCode.trim();
  if (baseCode.length < 3 || baseCode.includes("%") || baseCode.includes("_")) {
    return null;
  }
  return baseCode;
}

/**
 * يجلب جميع أوامر الشغل الشقيقة التابعة لنفس الوصل الموحّد ضمن الفرع المسموح،
 * باستثناء الملغاة وباستثناء المُسنَدة لإرسالية توصيل نشطة، مرتّبة تصاعدياً بمعرّف الأمر.
 */
export async function findSiblingWorkOrdersByBaseCode(
  code: string,
  branchFilter: number | null,
): Promise<SiblingWorkOrderItem[]> {
  const baseCode = extractUnifiedReceiptBaseCode(code);
  if (!baseCode) return [];

  const db = getDb();
  if (!db) return [];

  const rows = await db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      title: workOrders.title,
      status: workOrders.status,
      salePrice: workOrders.salePrice,
      deposit: workOrders.deposit,
      invoiceId: workOrders.invoiceId,
      invoiceStatus: invoices.status,
      invoiceTotal: invoices.total,
      invoiceReturnedTotal: invoices.returnedTotal,
      invoicePaidAmount: invoices.paidAmount,
      hasDelivery: workOrders.hasDelivery,
      customerName: sql<string | null>`COALESCE(NULLIF(${customers.name}, ''), NULLIF(${workOrders.contactName}, ''))`,
      customerPhone: sql<string | null>`COALESCE(NULLIF(${workOrders.deliveryPhone}, ''), NULLIF(${workOrders.contactPhone}, ''), NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''))`,
    })
    .from(workOrders)
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .leftJoin(invoices, eq(workOrders.invoiceId, invoices.id))
    .where(
      and(
        or(
          eq(workOrders.orderNumber, baseCode),
          like(workOrders.orderNumber, `${baseCode}-%`),
        ),
        branchFilter != null ? eq(workOrders.branchId, branchFilter) : sql`1=1`,
        ne(workOrders.status, "CANCELLED"),
        sql`NOT EXISTS (
          SELECT 1 FROM deliveryConsignments dc
          WHERE dc.workOrderId = ${workOrders.id}
            AND dc.consignmentStatus NOT IN ('CANCELLED', 'RETURNED')
        )`,
      ),
    )
    .orderBy(asc(workOrders.id));

  return rows.map((r) => {
    const financials = resolveWorkOrderHandoverFinancials(
      {
        salePrice: String(r.salePrice),
        deposit: r.deposit != null ? String(r.deposit) : null,
        invoiceId: r.invoiceId != null ? Number(r.invoiceId) : null,
      },
      r.invoiceStatus != null
        ? {
            status: r.invoiceStatus,
            total: r.invoiceTotal,
            returnedTotal: r.invoiceReturnedTotal,
            paidAmount: r.invoicePaidAmount,
          }
        : null,
    );
    return {
      id: Number(r.id),
      orderNumber: r.orderNumber,
      title: r.title,
      status: r.status,
      salePrice: financials.salePrice,
      deposit: financials.deposit,
      hasDelivery: Boolean(r.hasDelivery),
      customerName: r.customerName ?? null,
      customerPhone: r.customerPhone ?? null,
    };
  });
}

/**
 * عند مسح باركود وصل موحّد متعدّد البنود (مثل "103757") لا يطابق أمراً مفرداً باسمه الدقيق،
 * يختار أوّل أمر شقيق جاهز للاستلام المباشر (أو أوّل شقيق متاح) هدفاً افتراضياً.
 */
export function pickSiblingFallbackTarget(
  siblingWorkOrders: readonly SiblingWorkOrderItem[],
): { kind: "WORK_ORDER"; id: number } | null {
  if (siblingWorkOrders.length === 0) return null;
  const chosen =
    siblingWorkOrders.find((item) => item.status === "READY" && !item.hasDelivery) ??
    siblingWorkOrders[0]!;
  return { kind: "WORK_ORDER", id: chosen.id };
}
