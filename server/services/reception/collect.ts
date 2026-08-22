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
import { retryOnDeadlock } from "../../lib/retryDeadlock";
import { registerCounterCollectionTx } from "../delivery/counterCollection";
import { assertNoInTransitConsignment } from "../delivery/guards";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { processPayment } from "../sale/payment";
import { getOpenShift } from "../shiftService";
import { type Actor } from "../tx";
import { assertTelecomCollectAllowed } from "./telecom";
import type { CollectOnInvoiceInput } from "./types";

// حارس «الإرسالية بالطريق» انتقل إلى delivery/guards.ts (٩/٨) — صار مشتركاً مع sales.pay
// (كان هنا وحده ⇒ بابان لنفس الفاتورة أحدهما بلا حارس). السلوك والتعليق التاريخي هناك.

export async function collectOnReceptionInvoice(
  input: CollectOnInvoiceInput,
  actor: Actor & { role?: string },
) {
  // رفض قبل جلب الفاتورة/الوردية: مرجع يكتبه الموظف ليس إثبات تسوية خارجية.
  assertPosPaymentMethodEnabled(input.method);
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيّأة" });

  // الحصر البنيويّ: الفاتورة وُلدت على وردية استقبال — **أو** هي فاتورةُ أمر شغلٍ بلا وردية
  // (٢٠/٨، انظر أدناه). فواتير التجزئة تبقى خارج النطاق: تُسدَّد من شاشة الفواتير لمن يملكها.
  // القراءة استرشادية بلا قفل — processPayment
  // يعيد التحقّق من كل شيءٍ ماليّ تحت FOR UPDATE داخل معاملته.
  const inv = (
    await db
      .select({ id: invoices.id, branchId: invoices.branchId, shiftId: invoices.shiftId, sourceType: invoices.sourceType })
      .from(invoices)
      .where(eq(invoices.id, input.invoiceId))
      .limit(1)
  )[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  const invShift = inv.shiftId != null
    ? (await db.select({ shiftType: shifts.shiftType }).from(shifts).where(eq(shifts.id, Number(inv.shiftId))).limit(1))[0]
    : null;
  // ٢٠/٨ — نظيرُ التسامح في `listReceptionInvoices` بالضبط: فاتورةُ أمر شغلٍ خُتِمت
  // `shiftId = NULL` (تسليمٌ بلا وردية RECEPTION مفتوحة) كانت تظهر في الطابور بعد الإصلاح
  // ثمّ **تُرفَض عند القبض** — وهو أسوأ من إخفائها: يراها الموظّف ولا يستطيع تحصيلها.
  // الشرطان يتغيّران معاً أو لا يتغيّران.
  const nullShiftWorkOrder = inv.shiftId == null && inv.sourceType === "WORKORDER";
  if (!nullShiftWorkOrder && (!invShift || invShift.shiftType !== "RECEPTION")) {
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

  // عزل مدير الفرع (قرار المالك ١٢/٨): enforceBranchId يُفرَض على المدير أيضاً (المالك/الأدمن فقط بلا قيد،
  // owner مُطبَّع ⇒ admin) — كان `|| manager` يجعله null فيُحصّل المدير على فاتورة فرعٍ آخر (بطاقة/تحويل).
  const elevated = actor.role === "admin";
  const result = await retryOnDeadlock(() => processPayment(
    {
      invoiceId: input.invoiceId,
      amount: input.amount,
      method: input.method,
      reference: input.reference ?? null,
      shiftId: myShift ? Number(myShift.id) : null,
      enforceBranchId: elevated ? null : actor.branchId ?? null,
      clientRequestId: input.clientRequestId,
      // ش٥ (§٩.٤): ضوابط رصيد زين **داخل** معاملة الدفع نفسها (مراجعة عدائية ٦/٨): الفحص
      // بمعاملةٍ مستقلّة قبل النداء كان يفتح TOCTOU (كودٌ واحد يُقبَض مرّتين تحت التزامن —
      // أقفال فجوة الحارس تتحرّر قبل إدراج الإيصال) ويرفض الـreplay المشروع بـCONFLICT
      // (الحارس يصطدم بإيصال العملية الأولى نفسها). الخطّاف يُنفَّذ بعد مسار الـreplay.
      // مراجعة PR #495: حارس «الإرسالية بالطريق» انضمّ لنفس الخطّاف — لعلّته حرفياً (فحصٌ
      // خارج المعاملة = نافذة سباقٍ بين القراءة وقفل الفاتورة).
      preInsertCheck: async (tx) => {
        await assertNoInTransitConsignment(tx, input.invoiceId);
        // ٢٢/٨ — القبض على فاتورة إرساليةٍ **مُسلَّمة** يُدوَّن عليها في نفس المعاملة (يخفض
        // المتوقَّع توريدُه من الجهة). refKey = مفتاح idempotency القبض القائم في هذا المسار.
        await registerCounterCollectionTx(tx, {
          invoiceId: input.invoiceId,
          amount: input.amount,
          actorUserId: actor.userId,
          refKey: input.clientRequestId,
        });
        if (input.method === "TELECOM") {
          await assertTelecomCollectAllowed(tx, {
            userId: actor.userId,
            branchId: Number(inv.branchId),
            amount: input.amount,
            reference: input.reference,
          });
        }
      },
    },
    actor,
  ));
  return { ...result, collectedIntoShiftId: myShift ? Number(myShift.id) : null };
}
