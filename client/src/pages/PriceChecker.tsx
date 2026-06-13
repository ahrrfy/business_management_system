/**
 * شاشة «قارئ الأسعار» داخل التطبيق (وضع الموظّف) — بملء الشاشة بلا قائمة جانبية.
 * جهاز المتجر مسجَّل الدخول؛ التجربة الكاملة في KioskView (mode="staff").
 * للشاشات الخارجية المستقلّة (مصادقة جهاز) انظر صفحة /kiosk.
 */
import KioskView from "@/components/kiosk/KioskView";

export default function PriceChecker() {
  return <KioskView mode="staff" />;
}
