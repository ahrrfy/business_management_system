// إعادة تشغيل مرتجعٍ التُقط دون اتصال — إغلاقُ آخر ثقبٍ في تدقيق ١/٩/٢٦.
//
// ## لماذا
//
// `OfflineOutboxKind` كان `SALE | PRINT_SALE | RECEPTION` — **بلا مرتجع ولا طابورٍ له**، والجهازُ
// المنقطع لا يستطيع حتى فتح شاشة المرتجع. فحين يعود زبونٌ ببضاعته أثناء الانقطاع، لا مسارَ
// أمام الموظّف إلّا الدفع من خارج النظام والتسجيل لاحقاً — وهو بالضبط ما يُنتج **النقد اليتيم
// والعجز غير المفسَّر في Z-report**، ونقضٌ مباشر للمبدأ المالي الحاكم («لا دينار يضيع بصمت»).
//
// ## النمط
//
// غلافٌ رقيق حول `returnSaleInTx` نفسه — لا نسخةَ منطقٍ ماليّ ثانية (سابقة `replaySale`).
// نفس `clientRequestId` الذي كان سيُستعمل أونلاين ⇒ idempotency المرتجع القائمة تُطابق
// مرتجعاً نصف-ناجح (وصل الخادمَ وانقطع الردّ) بدل ازدواجه.
//
// ## الحرّاس — ما يبقى نافذاً رغم الانقطاع
//
//  · **نافذة الالتقاط** و**نقديّة الردّ**: نفس `captureWindow.ts` المشترك (لا عتبتان تنجرفان).
//  · **سقف الاسترداد** (`loadRefundCaps` بـ`FOR UPDATE` داخل `returnSaleInTx`): لا يُقيَّم على
//    الجهاز — يُقيَّم **هنا** عند الترحيل. فإن تجاوز، يرتدّ العنصرُ ويُعلَّق (PARKED) برسالةٍ
//    عربية يراجعها المدير. النقدُ الذي خرج يصير **عجزاً موثَّقاً بمستند** بدل ضياعٍ صامت —
//    وهو عين عقد الأوفلاين القائم للبيع تحت التكلفة.
//  · **حالة الفاتورة والكمّيات المتبقّية**: تُفحص عند الترحيل بالحارس القائم نفسه.
//
// ## ⛔ لماذا المالك وحده يلتقط مرتجعاً أوفلاينياً
//
// بعد قرار المالك (١/٩/٢٦) صار `returns.create` لغير المالك **طلباً صفريّ الأثر** ينتظر مراجعاً
// مستقلاً. والتقاطُ «طلبٍ» أوفلاينياً عبثٌ: النقدُ خرج فعلاً من الدرج، فترحيلُه طلباً معلّقاً
// يترك المال بلا مستندٍ — أي نفس العطب الذي نُغلقه. والتنفيذُ الفوريّ سلطةٌ للمالك وحده.
// فالبوّابة هنا مرآةُ تلك السلطة: التقاطٌ لمن يملك التنفيذ، ورفضٌ صريحٌ لغيره على الشاشة.

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import { returnSaleInTx, type ReturnSaleInput } from "../returnService";
import { withTx, type Actor } from "../tx";
import { assertCaptureWindow, assertCashOnly } from "./captureWindow";

export interface ReplayOfflineReturnInput {
  invoiceId: number;
  lines: ReturnSaleInput["lines"];
  /** الردّ النقديّ الذي سُلِّم للزبون فعلاً أثناء الانقطاع (نقد فقط). */
  refund: { amount: string; method: "CASH"; shiftId?: number | null };
  restock: boolean;
  /** سببٌ إلزاميّ — المرتجع الأوفلاينيّ لا يقع بلا مستند. */
  reason: string;
  clientRequestId: string;
  /** لحظة المرتجع الحقيقية على الجهاز (ISO). */
  capturedAt: string;
  /** الرقم المؤقّت OFF-... المطبوع على إيصال الزبون. */
  offlineReceiptNumber: string;
  deviceId?: string | null;
}

/**
 * يُرحّل مرتجعاً ملتقَطاً أوفلاينياً. **لا يُخفّف حارساً مالياً واحداً** — يُضيف حرّاسَ
 * الالتقاط فوقها، ويعيد قراءة سلطة المالك داخل المعاملة (رايةُ الجلسة تشيخ).
 */
export async function replayOfflineReturn(
  input: ReplayOfflineReturnInput,
  actor: Actor,
  options?: { skipCaptureWindow?: boolean },
) {
  assertCaptureWindow(input.capturedAt, { allowAged: options?.skipCaptureWindow });
  assertCashOnly(input.refund.method);
  const reason = input.reason.trim().replace(/\s+/g, " ");
  if (reason.length < 3 || reason.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب المرتجع الأوفلاينيّ إلزاميّ (3-500 محرف)" });
  }

  return withTx(async (tx) => {
    // سلطةُ التنفيذ تُقرأ من القاعدة داخل المعاملة — لا من رايةِ جلسةٍ قد تكون شاخت
    // بين الالتقاط والترحيل (نفس اشتراط `returnSaleAsOwner` و`assertTreasuryOutException`).
    const [owner] = await tx
      .select({ isActive: users.isActive, isOwner: users.isOwner })
      .from(users)
      .where(eq(users.id, actor.userId))
      .for("share")
      .limit(1);
    if (!owner?.isActive || !owner.isOwner) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "المرتجع الأوفلاينيّ يُرحَّل بحساب مالكٍ نشط — سجّل الدخول بحساب المالك أو نفّذ المرتجع أونلاين بمسار الطلب والاعتماد",
      });
    }
    return returnSaleInTx(tx, {
      invoiceId: input.invoiceId,
      lines: input.lines,
      refund: {
        amount: input.refund.amount,
        method: "CASH",
        shiftId: input.refund.shiftId ?? null,
      },
      restock: input.restock,
      clientRequestId: input.clientRequestId,
    }, actor);
  });
}
