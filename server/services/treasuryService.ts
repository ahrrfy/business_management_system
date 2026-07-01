// خدمة لوحة الخزينة (قراءة فقط) — تُغذّي شاشة /treasury الاحترافية — نقطة الدخول العامة.
// المصادر:
//  • DRAWER balance: shifts المفتوحة + receipts بـcashBucket='DRAWER' (نفس صيغة computeExpectedCash في shiftService).
//  • TREASURY balance: receipts بـcashBucket='TREASURY' (تاريخياً بلا فلتر فترة — رصيد تراكمي).
//  • السلاسل الزمنية والـbreakdown والـtrends: receipts المكتملة (receiptStatus='COMPLETED').
// ⚠️ scopedBranchId (IDOR): الكاشير يَرى دَرْجه فقط بلا TREASURY.
// ⚠️ أسماء أعمدة DB الخام في sql template: receipts.receiptStatus / shifts.shiftStatus / expenses.expenseStatus.
//
// أُعيد تنظيم المنطق (كان ٧٥٢ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/treasury/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع (كلها قراءة فقط — بلا withTx). هذا الملف يعيد تصدير
// الواجهة العامة فقط كي يبقى treasuryRouter.ts بلا أي تعديل.
//
// خريطة الوحدات:
//   helpers           — تطبيع نتيجة execute + تسمية طرق الدفع + تصنيف الأدوار الكاشيرية — داخلية.
//   dashboard         — لوحة الخزينة الرئيسية (درج + خزينة + عدّادات اليوم).
//   movements         — آخر حركات نقدية موحَّدة.
//   cashFlow          — سلسلة تدفّق نقدي زمنية.
//   paymentBreakdown  — توزيع طرق الدفع (دونات).
//   kpiTrends         — مؤشّرات KPI مع نسبة التغيّر والاتجاه اليومي.
//   openShifts        — بطاقات الورديات المفتوحة.

export type { DrawerBalanceRow, TreasuryBalanceRow, DashboardOutput } from "./treasury/dashboard";
export { getDashboard } from "./treasury/dashboard";
export type { MovementRow } from "./treasury/movements";
export { getRecentMovements } from "./treasury/movements";
export type { DailyPoint } from "./treasury/cashFlow";
export { getCashFlowSeries } from "./treasury/cashFlow";
export type { MethodSlice, DashboardPeriod } from "./treasury/paymentBreakdown";
export { getPaymentMethodBreakdown } from "./treasury/paymentBreakdown";
export type { KpiTrendPoint, KpiTrends } from "./treasury/kpiTrends";
export { getKpiTrends } from "./treasury/kpiTrends";
export type { OpenShiftCard } from "./treasury/openShifts";
export { getOpenShifts } from "./treasury/openShifts";
