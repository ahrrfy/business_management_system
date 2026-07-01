// خدمة التقارير المالية للقراءة فقط — نقطة الدخول العامة.
//
// أُعيد تنظيم المنطق (كان ٩١٠ أسطر في ملف واحد) إلى وحدات متماسكة تحت server/services/reports/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (reportsRouter.ts والاختبارات) بلا أي تعديل.
//
// خريطة الوحدات:
//   shared          — StatementPeriod + أدوات مشتركة (nextDayStr/positiveDiff) — داخلية عدا النوع.
//   arAging         — شيخوخة الذمم المدينة (AR) + كشف حساب عميل.
//   apAging         — شيخوخة الذمم الدائنة (AP) + كشف حساب مورد.
//   dashboard       — مقاييس لوحة التحكم (مخزون منخفض + ذمم متأخّرة).
//   salesAnalytics  — أكثر مبيعاً + بطيئات الحركة + الربح حسب الفئة.
//   wip             — تقرير المواد قيد التشغيل (Work-in-Progress).

export type { StatementPeriod } from "./reports/shared";
export type { ARAgingRow, CustomerStatementInvoice, CustomerStatementPayment, CustomerStatementResult } from "./reports/arAging";
export { getARAging, getCustomerStatement } from "./reports/arAging";
export type { APAgingRow, SupplierStatementPO, SupplierStatementPayment, SupplierStatementResult } from "./reports/apAging";
export { getAPAging, getSupplierStatement } from "./reports/apAging";
export type { DashboardMetricsResult } from "./reports/dashboard";
export { getDashboardMetrics } from "./reports/dashboard";
export type { SalesAnalyticsFilters, TopProductRow, SlowMoverRow, CategoryProfitRow } from "./reports/salesAnalytics";
export { getTopProducts, getSlowMovers, getProfitByCategory } from "./reports/salesAnalytics";
export type { WIPRow, WIPReport } from "./reports/wip";
export { getWIPReport } from "./reports/wip";
