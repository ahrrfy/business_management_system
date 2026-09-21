/**
 * لاحقة «بواسطة …» لإظهار اسم الفاعل في نص الإشعار.
 *
 * النمط المعتمد في المشروع: الاسم يُضمَّن في `title` أو `body` عند إنشاء الإشعار
 * (كما في `attendanceNotification.ts` و`sessionEventNotifier.ts`).
 *
 * الاستعمال:
 * ```ts
 * body: `${consignmentNumber} — ${eventType}${actorSuffix(actorName)}`
 * // ⇒ "CN-1-00008 — ASSIGNED · بواسطة أحمد محمد"
 * ```
 */

/** تقصّ الاسم بطولٍ آمن وتُرجع لاحقةً مُنسَّقة، أو سلسلةً فارغة إن غاب الاسم. */
export function actorSuffix(
  name: string | null | undefined,
  maxLen = 50,
): string {
  const trimmed = (name ?? "").trim().slice(0, maxLen);
  return trimmed ? ` · بواسطة ${trimmed}` : "";
}
