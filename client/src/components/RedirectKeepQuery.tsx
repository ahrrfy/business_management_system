// RedirectKeepQuery — إعادة توجيه تَحفظ سلسلة الاستعلام (deep-link) عند تحويل مسار قديم إلى تبويب hub.
//
// المشكلة: wouter's `<Redirect to="/hub?tab=X" />` بسلسلة ثابتة **يُسقط** أيّ `?id=`/`?q=`/`?focus=`
// على الرابط الوارد ⇒ `/customers-statement?id=181` ينتهي إلى `/customers?tab=statement` بلا معرّف،
// فتُفتح شاشة فارغة تَطلب إعادة الاختيار (فقدان الاستقلالية/السياق).
//
// الحل (وحدة عميقة، واجهة صغيرة): مرّر الوجهة فقط؛ تُدمَج معاملات الرابط الوارد مع معاملات الوجهة
// (معاملات الوجهة تَغلِب عند التعارض، فمثلاً tab=statement تُضبَط دائماً) ⇒ يَصِل المعرّف سليماً.
// مصدر الحقيقة هو الـURL، فيبقى كل مسار قابلاً للمشاركة (locality: إصلاح واحد يُغطّي كل مُستدعٍ).
import { Redirect, useSearch } from "wouter";

export function RedirectKeepQuery({ to }: { to: string }) {
  const search = useSearch(); // سلسلة استعلام الرابط الوارد (بلا ?)، مثل "id=181"
  const [path, targetQuery = ""] = to.split("?");
  const params = new URLSearchParams(search); // معاملات الوارد أولاً (id/q/focus…)
  // الوجهة تَغلِب عند التعارض (tab=… دائماً مضبوط). forEach بدل for…of (قيد هدف tsc).
  new URLSearchParams(targetQuery).forEach((v, k) => params.set(k, v));
  const qs = params.toString();
  return <Redirect to={qs ? `${path}?${qs}` : path} replace />;
}
