// تسديد دفعة على فاتورة من محطة خدمة الزبائن — ش١، حلّ الحاصرة ح٥ (V8).
//
// لماذا نقطة نهاية مستقلّة لا sales.pay؟ بوّابة sales.pay تشترط sales=FULL بينما قالب
// reception_clerk يخفض sales إلى READ عمداً ⇒ أوّل مطلبٍ للمالك («يسدّد على الفاتورة من
// محطته») كان يسقط بـFORBIDDEN للدور المسمّى باسم المحطة. الحلّ: التفويض إلى **نفس**
// خدمة processPayment (صفر منطق ماليّ جديد) خلف بوّابة المحطة القائمة، بحصرٍ بنيويّ:
// الفاتورة ضمن نطاق طابور الاستقبال (وردية إنشائها RECEPTION) — ليست باباً خلفياً عاماً
// على مبيعات التجزئة (§٩.٢).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { invoices, shifts } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { processPayment } from "../sale/payment";
import { getOpenShift } from "../shiftService";
import type { Actor } from "../tx";
import type { CollectOnInvoiceInput } from "./types";

export async function collectOnReceptionInvoice(
  input: CollectOnInvoiceInput,
  actor: Actor & { role?: string },
) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيّأة" });

  // الحصر البنيويّ: الفاتورة وُلدت على وردية استقبال. (فواتير التجزئة/أوامر الشغل المُسلَّمة
  // خارج النطاق — تُسدَّد من شاشة الفواتير لمن يملكها.) القراءة استرشادية بلا قفل — processPayment
  // يعيد التحقّق من كل شيءٍ ماليّ تحت FOR UPDATE داخل معاملته.
  const inv = (
    await db
      .select({ id: invoices.id, branchId: invoices.branchId, shiftId: invoices.shiftId })
      .from(invoices)
      .where(eq(invoices.id, input.invoiceId))
      .limit(1)
  )[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  const invShift = inv.shiftId != null
    ? (await db.select({ shiftType: shifts.shiftType }).from(shifts).where(eq(shifts.id, Number(inv.shiftId))).limit(1))[0]
    : null;
  if (!invShift || invShift.shiftType !== "RECEPTION") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذه الفاتورة خارج نطاق محطة خدمة الزبائن — تُسدَّد من شاشة الفواتير",
    });
  }

  // «سيدخل المبلغ درجك أنت» (§٨.٥): الدفعة تُنسَب لوردية **القابض** الحاليّ لا لوردية الفاتورة
  // الأصلية — الموظّف يُحاسَب على ما استلمه هو (تأكيد المالك ٥/٨). تفضيل وردية الاستقبال.
  const myShift =
    (await getOpenShift(actor.userId, Number(inv.branchId), "RECEPTION"))
    ?? (await getOpenShift(actor.userId, Number(inv.branchId)));
  if (input.method === "CASH" && !myShift) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "افتح وردية استقبال أولاً — الدفعة النقدية تدخل درجك أنت وتُحاسَب عليها عند الإغلاق",
    });
  }

  const elevated = actor.role === "admin" || actor.role === "manager";
  const result = await processPayment(
    {
      invoiceId: input.invoiceId,
      amount: input.amount,
      method: input.method,
      reference: input.reference ?? null,
      shiftId: myShift ? Number(myShift.id) : null,
      enforceBranchId: elevated ? null : actor.branchId ?? null,
      clientRequestId: input.clientRequestId,
    },
    actor,
  );
  return { ...result, collectedIntoShiftId: myShift ? Number(myShift.id) : null };
}
