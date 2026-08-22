/**
 * **علامةُ رفض الإرسال الجزئيّ** — مصدرُ حقيقةٍ واحدٌ للخادم والشاشتين (٢٠/٨).
 *
 * الشاشتان تتعرّفان على هذا الرفض بعينه لتعرضا زرَّ الإقرار بدل رسالة خطأٍ عابرة. وكان
 * التعرّفُ بمطابقة **نصٍّ حرفيّ** مكرَّرٍ في ثلاثة ملفّات: تعديلُ كلمةٍ واحدةٍ في رسالة
 * الخادم يجعل الزرَّ لا يظهر أبداً — والموظّف يقف أمام خطأٍ بلا مخرج، ولا اختبارَ يسقط.
 *
 * فالعلامةُ هنا ثابتٌ مشتركٌ يستهلكه الطرفان، ويحرسه اختبارٌ نصّيّ يقرأ الملفّات الحيّة
 * (نمط `shared/workOrderStatus.ts`): من كتبَ المطابقةَ بنصٍّ حرفيٍّ سقط بناؤه.
 *
 * ⚠️ **لا تُغيّر القيمة** — هي جزءٌ من عقدٍ بين الخادم والواجهة، لا نصٌّ تحريريّ. النصُّ
 * المعروض للموظّف تبنيه `partialDispatchMessage` حولها.
 */
export const PARTIAL_DISPATCH_MARKER = "أمر شغل لم يجهز" as const;

/** يُنشئ رسالةَ الرفض كاملةً — تحوي العلامة حتماً، فلا تنفصل الرسالةُ عن مفتاحها. */
export function partialDispatchMessage(count: number, names: string, more: boolean): string {
  return (
    `الطلب نفسه يحوي ${count} ${PARTIAL_DISPATCH_MARKER} بعد (${names}${more ? "…" : ""}) — `
    + "إرسالُ الفاتورة الآن يُخرج جزءاً من الطلب ويترك باقيه. أكمِلها أوّلاً، أو أقرّ الإرسال الجزئيّ صراحةً."
  );
}

/** هل هذا الخطأ هو رفضُ الإرسال الجزئيّ؟ تستهلكها كلُّ شاشةٍ تعرض زرّ الإقرار. */
export function isPartialDispatchRejection(err: { message?: string; data?: { code?: string } | null } | null | undefined): boolean {
  if (!err?.message) return false;
  return err.data?.code === "PRECONDITION_FAILED" && err.message.includes(PARTIAL_DISPATCH_MARKER);
}
