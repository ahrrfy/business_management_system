import { isPublicStorefrontHost } from "./publicStorefrontHost";

/**
 * تصنيف أولوية الطلب لحارس الحِمل الزائد (فحص معمارية الحمل ٣٠/٨/٢٦).
 *
 * المشكلة الأصلية: الحارس كان يحجب بعتبةٍ واحدة، و`sales.create` ليست مستثناة ⇒ ضغطُ
 * زوّار المتجر يُسقط بيعَ الكاشير بـ503 أمام زبونٍ واقفٍ على الصندوق — انقلاب أولوية
 * تجارية كامل. الحلّ ثلاث حارات:
 *
 * - **critical**: عمليات الصندوق التي يقف خلفها زبونٌ فعلياً (بيع/قبض/مرتجع/تسليم/وردية).
 *   تتحمّل تأخّراً أعلى بكثير قبل الحجب (سقفٌ صلبٌ يبقى لحماية العملية نفسها).
 * - **storefront**: سطح المتجر العام (زائر مجهول) — يُخفَّف **أولاً** بعتبةٍ أدنى: زائرٌ
 *   يرى «أعد المحاولة» أهون تجارياً من كاشيرٍ مجمّد.
 * - **normal**: كل ما عدا ذلك (شاشات الإدارة والتقارير وبقية الموظفين) بالعتبة الافتراضية.
 *
 * ملاحظة أمنية مقصودة: مهاجمٌ قد يحقن اسم إجراءٍ حرج في دفعةٍ ليتجنّب التخفيف — هذا لا
 * يمنحه شيئاً ذا قيمة: بوّابة المضيف العام تسقط غير المسموح قبل الحارس أصلاً، وحدود المعدّل
 * وبوّابة CSRF ورفض المصادقة كلّها أرخص بكثير من العمل المحميّ، والحارس طبقةُ رشاقةٍ لا طبقةُ
 * أمان. التصنيف نقيّ وقابل للاختبار بلا Express.
 */

const TRPC_FULL_PATH = /^\/api\/trpc\/([^/?]+)$/;

/** يفكّ أسماء إجراءات دفعة tRPC من مسارٍ كامل (`/api/trpc/a.b,c.d`)، أو null لغير tRPC. */
export function trpcProceduresFromPath(path: string): string[] | null {
  const match = TRPC_FULL_PATH.exec(path);
  if (!match) return null;
  return match[1].split(",");
}

/**
 * عمليات الصندوق الحرجة — مطابقة اسمية صريحة (لا بادئات): كل واحدةٍ منها يقف خلفها
 * زبونٌ حاضرٌ جسدياً ولا بديل لها لحظتها. القوائم والتقارير عمداً خارجها.
 *
 * ⚠️ مراجعة عدائية ٣٠/٨: الحارة تشمل **مقدّمات** التدفّق لا خاتمته وحدها — بيع البطاقة
 * يمرّ إلزامياً بـinitiate/confirmExternalPayment قبل sales.create، وcommit المسوّدة
 * يسبقه draftSync؛ حمايةُ الخاتمة وحدها كانت تُسقط بيعَ البطاقة عند أول تخفيفٍ بينما
 * النقدي يمرّ — انقلاب الأولوية نفسه الذي بُنيت الحارة لمنعه.
 */
export const CRITICAL_CASHIER_PROCEDURES: ReadonlySet<string> = new Set([
  "sales.create",
  "sales.pay",
  "sales.initiateExternalPayment",
  "sales.confirmExternalPayment",
  "printPos.createSale",
  "printPos.initiateExternalPayment",
  "printPos.confirmExternalPayment",
  "returns.create",
  "returns.request",
  "workOrders.deliver",
  "reception.collectOnInvoice",
  "reception.collectDeposit",
  "reception.refundDeposit",
  "reception.draftCommit",
  "reception.draftSync",
  "digitalCards.pos.confirmCard",
  "shifts.open",
  "shifts.close",
]);

/**
 * مسارات تطبيق المناديب TWA على الدومين العام (مرآة SHARED_PATHS في
 * client/src/lib/siteHosts.ts): وثائق التطبيق نفسها يجب ألّا تُخفَّف بعتبة المتجر —
 * المندوب موظفٌ ميدانيّ لا زائرٌ مجهول.
 */
const COURIER_APP_PATHS = ["/login", "/my-deliveries", "/account"] as const;

function isCourierAppPath(path: string): boolean {
  return COURIER_APP_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

export type RequestPriorityLane = "critical" | "storefront" | "normal";

export function classifyRequestLane(path: string, hostname?: string): RequestPriorityLane {
  const procedures = trpcProceduresFromPath(path);
  if (procedures?.some((p) => CRITICAL_CASHIER_PROCEDURES.has(p))) return "critical";
  // دفعةٌ كل إجراءاتها storefront.* = زائر متجر أياً كان المضيف.
  if (procedures && procedures.length > 0 && procedures.every((p) => p.startsWith("storefront."))) {
    return "storefront";
  }
  // على المضيف العام: كل ما ليس نداءَ tRPC (صفحات المتجر، /api/img/*) يُصنَّف متجراً —
  // عدا وثائق تطبيق المناديب TWA. نداءات الموظفين المسموحة عبره (courier/auth/push/
  // recruitment) تبقى عادية عمداً.
  if (!procedures && isPublicStorefrontHost(hostname)) {
    return isCourierAppPath(path) ? "normal" : "storefront";
  }
  return "normal";
}
