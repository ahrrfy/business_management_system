// تعديل تفاصيل طلب خدمة قبل تسليمه أو إلغائه — يملأ فجوة: لا مسار كان يسمح بتصحيح سعرٍ أو
// عميلٍ أو موعدٍ أُدخل خطأً على طلبٍ في الطابور (البيانات المالية الحرة الوحيدة قبل التسليم هي
// salePrice، لأن الإيراد والمخزون لا يُمَسّان إلا عند deliverWorkOrder/start — راجع deliver.ts
// وlifecycle.ts). حقول التوصيل من فلاختها fulfillment.ts، والكمية/المواد خارج النطاق (تغييرها
// بعد بدء التنفيذ يستلزم عكس حركة مخزون — مؤجَّل عمداً، لا سهو).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { workOrders } from "../../../drizzle/schema";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

export interface UpdateWorkOrderInput {
  workOrderId: number;
  title?: string;
  customizationText?: string | null;
  salePrice?: string;
  dueDate?: string | null;
  priority?: "LOW" | "NORMAL" | "URGENT" | null;
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  receptionChannel?: "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | "OTHER" | null;
  channelHandle?: string | null;
}

export async function updateWorkOrder(input: UpdateWorkOrderInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: wo.status === "DELIVERED" ? "الأمر مُسلَّم بالفعل — لا يمكن تعديله" : "لا يمكن تعديل أمرٍ ملغى",
      });
    }

    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};

    if (input.title !== undefined) {
      const t = input.title.trim();
      if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "عنوان الطلب مطلوب" });
      patch.title = t;
    }
    if (input.customizationText !== undefined) patch.customizationText = input.customizationText?.trim() || null;
    if (input.salePrice !== undefined) {
      const newPrice = round2(money(input.salePrice));
      if (newPrice.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "السعر يجب أن يكون أكبر من صفر" });
      const deposit = round2(money(wo.deposit ?? "0"));
      if (newPrice.lt(deposit)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `السعر الجديد (${newPrice.toFixed(2)}) أقلّ من العربون المقبوض سلفاً (${deposit.toFixed(2)}) — عدّل العربون أولاً`,
        });
      }
      patch.salePrice = toDbMoney(newPrice);
    }
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
    if (input.priority !== undefined) patch.priority = input.priority ?? "NORMAL";
    if (input.customerId !== undefined) patch.customerId = input.customerId;
    if (input.contactName !== undefined) patch.contactName = input.contactName?.trim() || null;
    if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone?.trim() || null;
    if (input.receptionChannel !== undefined) patch.receptionChannel = input.receptionChannel ?? "WALK_IN";
    if (input.channelHandle !== undefined) patch.channelHandle = input.channelHandle?.trim() || null;

    if (Object.keys(patch).length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تعديلات لحفظها" });
    }
    for (const k of Object.keys(patch)) before[k] = (wo as Record<string, unknown>)[k];

    await tx.update(workOrders).set(patch).where(eq(workOrders.id, input.workOrderId));
    return { workOrderId: input.workOrderId, before, patch };
  });
}
