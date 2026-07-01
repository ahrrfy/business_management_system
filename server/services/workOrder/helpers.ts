// أدوات داخلية: ترقيم الأمر، تحميله تحت قفل صفّ، وعزل الفرع/المحطة — لا تُصدَّر من نقطة الدخول العامة.
import { TRPCError } from "@trpc/server";
import { desc, eq, like } from "drizzle-orm";
import { workOrders } from "../../../drizzle/schema";
import { toDateStr } from "../money";
import type { Actor } from "../tx";

async function nextWorkOrderNumber(tx: any, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `WO-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: workOrders.orderNumber })
    .from(workOrders)
    .where(like(workOrders.orderNumber, `${prefix}%`))
    .orderBy(desc(workOrders.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

async function loadWorkOrder(tx: any, workOrderId: number) {
  const rows = await tx.select().from(workOrders).where(eq(workOrders.id, workOrderId)).for("update").limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
  return rows[0];
}

/** عزل الفرع: أي عملية مال على طلب الخدمة تُجبر فرع الموظّف (غير المدير). يُمرَّر actor.role من الراوتر. */
function assertWorkOrderBranch(wo: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(wo.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "طلب الخدمة لا يخصّ فرعك" });
  }
}

/**
 * عزل المحطة: فني المطبعة (print_operator) ينفّذ أوامره المُسنَدة إليه فقط — لا أوامر زملائه.
 * الكاشير/المدير/الأدمن (مكتب الاستقبال) يُنفّذون أي أمر في فرعهم (مرونة تشغيلية). يُستدعى بعد
 * فحص الفرع في start/markReady. السحب (claim) هو ما يجعل أمراً «أمري» قبل التنفيذ.
 */
function assertOperatorOwns(
  wo: { assignedTo: number | string | null },
  actor: Actor & { role?: string },
) {
  if (actor.role !== "print_operator") return;
  if (wo.assignedTo == null || Number(wo.assignedTo) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "اسحب الأمر إلى قائمتك أولاً لتنفيذه" });
  }
}


export { nextWorkOrderNumber, loadWorkOrder, assertWorkOrderBranch, assertOperatorOwns };
