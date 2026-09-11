import { Redirect } from "wouter";

/**
 * رابط توافق يوجه مباشرة إلى كاشير الاستقبال (/pos?mode=RECEPTION).
 * شاشة أوامر الشغل الجديدة دُمجت بالكامل داخل كاشير الاستقبال الموحد.
 */
export default function WorkOrderNew() {
  return <Redirect to="/pos?mode=RECEPTION" />;
}
