import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { deliveryConsignments, invoices, workOrders } from "../../../drizzle/schema";
import { pauseIfRetryableDbError } from "../../lib/retryDup";
import { logAuditTx, type AuditMetadata } from "../auditService";
import { money } from "../money";
import { withTx, type MaybeScopedActor } from "../tx";
import {
  deliverWorkOrderInTx,
  publishWorkOrderDeliveredRealtime,
  type DeliverWorkOrderTxResult,
} from "./deliver";
import { resolveWorkOrderHandoverFinancials } from "./kanbanQueries";

export interface ShelfAuditDeliverInput {
  workOrderIds: number[];
  confirmationPhrase: string;
  branchId?: number;
}

export interface ShelfAuditDeliverResult {
  evaluatedCount: number;
  deliveredCount: number;
  deliveredIds: number[];
}

const REQUIRED_SHELF_AUDIT_PHRASE = "جرد وتسليم";

/**
 * جرد الرفّ وتصفية الطلبات المتراكمة قديمة العهد — محكوم بصلاحية المدير حصراً:
 * 1. دور المدير فقط (admin / manager).
 * 2. عبارة التأكيد النصية الصريحة «جرد وتسليم».
 * 3. تحقّق صارم وفشل مغلق لكل طلب مختار داخل معاملة ذرية واحدة: ضمن الفرع المسموح،
 *    بحالة READY، استلام مباشر (!hasDelivery)، مدفوع بالكامل مسبقاً، وبلا إرسالية توصيل نشطة.
 * 4. تسليم محاسبي نظامي عبر deliverWorkOrderInTx وتوثيق سجل تدقيق workOrder.shelfAuditDeliver
 *    في نفس المعاملة الذرية (logAuditTx) بحيث لا يلتزم تسليم جزئي أبداً ولا يسقط أثر التدقيق.
 */
export async function shelfAuditDeliverWorkOrders(
  input: ShelfAuditDeliverInput,
  actor: MaybeScopedActor,
  auditMeta?: AuditMetadata,
): Promise<ShelfAuditDeliverResult> {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "جرد الرفّ وتصفية الطلبات المتراكمة صلاحية حصريّة للمدير",
        why: "حسابك الحالي لا يحمل دور مدير فرع أو مدير نظام لإقرار جرد الرفّ",
        doThis: "اطلب من المدير مراجعة الطلبات المحددة وتنفيذ جرد الرفّ بحسابه",
      }),
    });
  }

  if (input.confirmationPhrase.trim() !== REQUIRED_SHELF_AUDIT_PHRASE) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "يلزم كتابة عبارة التأكيد «جرد وتسليم» نصّاً لإتمام جرد الرفّ",
        why: "عبارة التأكيد المُدخلة غير مطابقة للنص الإلزامي المطلوب",
        doThis: "اكتب عبارة «جرد وتسليم» بدقة بعد التأكد الفعلي من عدم وجود هذه المطبوعات على الرفّ",
      }),
    });
  }

  const uniqueIds = Array.from(new Set(input.workOrderIds)).sort((a, b) => a - b);
  if (uniqueIds.length === 0 || uniqueIds.length > 100) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قائمة أوامر جرد الرفّ غير صالحة",
        why: "يجب اختيار أمر شغل واحد على الأقل وبحد أقصى 100 أمر في الدفعة الواحدة",
        doThis: "حدّد الأوامر المراد جردها يدوياً ضمن الحد المسموح ثم أعد المحاولة",
      }),
    });
  }

  let allowedBranchId: number | null = null;
  if (actor.role === "admin") {
    allowedBranchId = input.branchId != null ? Number(input.branchId) : null;
  } else {
    if (actor.branchId == null || Number(actor.branchId) <= 0) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تنفيذ جرد الرفّ بلا فرع مُسنَد للمستخدم",
          why: "حساب المدير الحالي غير مرتبط بفرع تشغيلي صريح",
          doThis: "أسند فرعاً لحساب المستخدم من إدارة المستخدمين قبل تنفيذ جرد الرفّ",
        }),
      });
    }
    if (input.branchId != null && Number(input.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "لا يجوز جرد رفّ فرع آخر خارج نطاق فرعك",
          why: `الفرع المطلوب (${Number(input.branchId)}) يختلف عن فرعك المُسنَد (${Number(actor.branchId)})`,
          doThis: "نفّذ جرد الرفّ ضمن فرعك المُسنَد فقط أو اطلب من مدير النظام العام تنفيذه",
        }),
      });
    }
    allowedBranchId = Number(actor.branchId);
  }

  const batchStamp = Date.now();
  const requestIdByWoId = new Map<number, string>(
    uniqueIds.map((id) => [id, `shelf-audit-${id}-${batchStamp}`]),
  );

  let txResults: DeliverWorkOrderTxResult[] = [];
  let deliveredIds: number[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const outcome = await withTx(async (tx) => {
        const rows = await tx
          .select({
            id: workOrders.id,
            orderNumber: workOrders.orderNumber,
            branchId: workOrders.branchId,
            status: workOrders.status,
            hasDelivery: workOrders.hasDelivery,
            deposit: workOrders.deposit,
            salePrice: workOrders.salePrice,
            invoiceId: workOrders.invoiceId,
            invoiceStatus: invoices.status,
            invoiceTotal: invoices.total,
            invoiceReturnedTotal: invoices.returnedTotal,
            invoicePaidAmount: invoices.paidAmount,
          })
          .from(workOrders)
          .leftJoin(invoices, eq(workOrders.invoiceId, invoices.id))
          .where(inArray(workOrders.id, uniqueIds))
          .orderBy(asc(workOrders.id))
          .for("update");

        const byId = new Map(rows.map((r) => [Number(r.id), r]));
        for (const id of uniqueIds) {
          if (!byId.has(id)) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: appErrorMessage({
                what: `تعذّر إتمام جرد الرفّ — أمر الشغل #${id} غير موجود`,
                why: `المعرّف ${id} المحدّد ضمن القائمة لا يقابل سجل أمر شغل في قاعدة البيانات`,
                doThis: "حدّث شاشة طابور الاستقبال وأعد تحديد الطلبات الموجودة فعلياً",
              }),
            });
          }
        }

        const activeConsignments = await tx
          .select({
            workOrderId: deliveryConsignments.workOrderId,
            consignmentNumber: deliveryConsignments.consignmentNumber,
          })
          .from(deliveryConsignments)
          .where(
            and(
              inArray(deliveryConsignments.workOrderId, uniqueIds),
              notInArray(deliveryConsignments.status, ["CANCELLED", "RETURNED"]),
            ),
          );
        const activeCnByWoId = new Map<number, string>();
        for (const cn of activeConsignments) {
          if (cn.workOrderId != null) {
            activeCnByWoId.set(Number(cn.workOrderId), cn.consignmentNumber);
          }
        }

        for (const id of uniqueIds) {
          const wo = byId.get(id)!;
          if (allowedBranchId != null && Number(wo.branchId) !== allowedBranchId) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: appErrorMessage({
                what: `الأمر ${wo.orderNumber} خارج نطاق الفرع المسموح لجرد الرفّ`,
                why: `ينتمي الأمر ${wo.orderNumber} إلى الفرع رقم ${Number(wo.branchId)} بينما نطاق الجرد مقيّد بالفرع رقم ${allowedBranchId}`,
                doThis: "أزل هذا الأمر من التحديد والتزم بأوامر فرعك فقط",
              }),
            });
          }
          if (wo.status !== "READY") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: `لا يجوز جرد الأمر ${wo.orderNumber} لأن حالته ليست جاهزاً للتسليم`,
                why: `الحالة الحالية للأمر ${wo.orderNumber} هي ${wo.status} وليست READY`,
                doThis: "ألغِ تحديد هذا الأمر واقتصر على الطلبات الجاهزة للتسليم فقط",
              }),
            });
          }
          if (wo.hasDelivery) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: `لا يجوز جرد الأمر ${wo.orderNumber} لأنه مصنّف للتوصيل`,
                why: `الأمر ${wo.orderNumber} يحمل خيار التوصيل ولا يُصرَّف عبر جرد رفّ الاستلام المباشر`,
                doThis: "صرّف الطلب عبر مسار الإسناد للتوصيل أو عدّل طريقة تسليمه إلى استلام مباشر أولاً",
              }),
            });
          }
          const financials = resolveWorkOrderHandoverFinancials(
            {
              salePrice: String(wo.salePrice),
              deposit: wo.deposit != null ? String(wo.deposit) : null,
              invoiceId: wo.invoiceId != null ? Number(wo.invoiceId) : null,
            },
            wo.invoiceStatus != null
              ? {
                  status: wo.invoiceStatus,
                  total: wo.invoiceTotal,
                  returnedTotal: wo.invoiceReturnedTotal,
                  paidAmount: wo.invoicePaidAmount,
                }
              : null,
          );
          const depositAmount = money(financials.deposit ?? "0");
          const salePriceAmount = money(financials.salePrice);
          if (!depositAmount.gte(salePriceAmount)) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: `لا يجوز جرد الأمر ${wo.orderNumber} لأنه غير مدفوع بالكامل مسبقاً`,
                why: `المدفوع مسبقاً (${depositAmount.toFixed(2)}) أقل من قيمة البيع (${salePriceAmount.toFixed(2)}) للأمر ${wo.orderNumber}`,
                doThis: "أزل الأمر من جرد الرفّ وحصّل المتبقي عبر شاشة التسليم المباشر",
              }),
            });
          }
          const activeCnNumber = activeCnByWoId.get(id);
          if (activeCnNumber) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: `لا يجوز جرد الأمر ${wo.orderNumber} لارتباطه بإرسالية توصيل نشطة`,
                why: `الأمر ${wo.orderNumber} مرتبط بالإرسالية النشطة ${activeCnNumber}`,
                doThis: "عالج الإرسالية من شاشة التوصيل أولاً ولا تسلّم الأمر عبر جرد الرفّ",
              }),
            });
          }
        }

        const results: DeliverWorkOrderTxResult[] = [];
        const ids: number[] = [];
        const orderNumbers: string[] = [];

        for (const id of uniqueIds) {
          const wo = byId.get(id)!;
          const res = await deliverWorkOrderInTx(
            tx,
            {
              workOrderId: id,
              payment: null,
              clientRequestId: requestIdByWoId.get(id)!,
              // المدير تحقّق فعلياً من كل بند على الرفّ فردياً؛ لا نكسر الدفعة بسبب شقيق غير جاهز.
              partialDispatchConfirmed: true,
            },
            {
              userId: actor.userId,
              branchId: Number(wo.branchId),
              role: actor.role,
            },
          );
          results.push(res);
          ids.push(id);
          orderNumbers.push(wo.orderNumber);
        }

        const auditBranchId =
          allowedBranchId ??
          (uniqueIds.length > 0 ? Number(byId.get(uniqueIds[0]!)!.branchId) : (actor.branchId ?? null));

        await logAuditTx(
          tx,
          auditMeta ?? {
            userId: actor.userId,
            branchId: actor.branchId ?? auditBranchId,
          },
          {
            action: "workOrder.shelfAuditDeliver",
            entityType: "workOrder",
            entityId: ids[0] ?? null,
            branchId: auditBranchId,
            newValue: {
              evaluatedCount: uniqueIds.length,
              deliveredCount: ids.length,
              deliveredIds: ids,
              orderNumbers,
              confirmationPhrase: REQUIRED_SHELF_AUDIT_PHRASE,
            },
          },
        );

        return { results, ids };
      });

      txResults = outcome.results;
      deliveredIds = outcome.ids;
      break;
    } catch (err) {
      if (attempt < 2 && (await pauseIfRetryableDbError(err, attempt))) continue;
      throw err;
    }
  }

  for (const res of txResults) {
    publishWorkOrderDeliveredRealtime(res, actor.userId);
  }

  return {
    evaluatedCount: uniqueIds.length,
    deliveredCount: deliveredIds.length,
    deliveredIds,
  };
}
