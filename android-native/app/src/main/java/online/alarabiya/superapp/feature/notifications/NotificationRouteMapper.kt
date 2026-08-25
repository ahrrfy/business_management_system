package online.alarabiya.superapp.feature.notifications

import online.alarabiya.superapp.core.navigation.NativeDestination

/**
 * ن-١ (٢٤/٨) — يُحوِّل route الآمن الذي صنعه الخادم (مثل `/mobile#tasks/7`) إلى وجهة أصيلة.
 *
 * القاعدة الحاكمة:
 *   - الخادم يُصفّي أيّ سلسلة لا تبدأ بـ`/` إلى `/mobile` (safeInternalRoute).
 *   - نُضيف طبقة أمانٍ ثانية: أيّ رمزٍ غير معروف يعود إلى NativeDestination.SelfService
 *     (منزل الإشعارات الشخصيّة الافتراضيّ) لا إلى Home، حتى لا يفقد المستخدم السياق.
 *   - المطابقة تعتمد على شظيّة الـURL (`#tasks`, `#approvals`, `#leave`, ...) لا على مسارٍ
 *     ويبيّ كامل — أرقام الكيانات ليست مسموعةً من الأندرويد حالياً.
 *
 * ⚠️ **حدٌّ معلَن**: التنقّل الأعمق (فتحُ بند صرفٍ رقم 12345) يحتاج جسر deep-link كامل
 * بمُحلِّل `route` يُنتج NativeDestination.Feature ذا entityId. هذا الإصدار يُلامس الشاشة
 * الرئيسيّة ذات العلاقة ويترك المستخدم عند بضع نقرات من التفاصيل، بدل CRASH أو صمت.
 */
fun mapNotificationRouteToDestination(route: String?): NativeDestination {
    // Reject anything that could be an open-redirect payload: must start with a single "/"
    // (not "//" which parses as protocol-relative), and must not carry an authority component.
    val safe = route
        ?.takeIf { it.startsWith("/") && !it.startsWith("//") && !it.contains("://") }
        ?: return NativeDestination.SelfService
    val fragment = safe.substringAfter('#', missingDelimiterValue = "")
    val head = fragment.substringBefore('/').trim().lowercase()
    return when (head) {
        "approvals" -> NativeDestination.Approvals
        "tasks" -> NativeDestination.Tasks
        "shifts", "shift" -> NativeDestination.Shifts
        "workorders", "workorder", "wo" -> NativeDestination.WorkOrders
        "collaboration", "chat", "chats" -> NativeDestination.Collaboration
        "collections" -> NativeDestination.Collections
        "receivables", "ar" -> NativeDestination.Receivables
        "insights", "reports" -> NativeDestination.Insights
        "operations", "ops" -> NativeDestination.Operations
        "crm", "customers" -> NativeDestination.CrmWorkspace
        "profile", "me", "account" -> NativeDestination.Profile
        "alerts", "notifications", "inbox" -> NativeDestination.Alerts
        "home", "" -> NativeDestination.Home
        // Payroll / Leave / Attendance / Payslip all live inside SelfService as tabs — the
        // section switch is driven by SelfServiceViewModel.select(); coarse routing here is
        // safe and predictable while a deeper deep-link parser is out of scope.
        "payroll", "payslip", "leave", "leaves", "attendance" -> NativeDestination.SelfService
        else -> NativeDestination.SelfService
    }
}
