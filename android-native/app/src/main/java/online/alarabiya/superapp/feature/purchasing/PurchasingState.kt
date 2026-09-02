package online.alarabiya.superapp.feature.purchasing

import online.alarabiya.superapp.model.purchasing.PurchaseOrderDetail
import online.alarabiya.superapp.model.purchasing.PurchaseCatalogItem
import online.alarabiya.superapp.model.purchasing.PurchaseOrderSummary
import online.alarabiya.superapp.model.purchasing.PurchaseReturnPage
import online.alarabiya.superapp.model.purchasing.PurchasingSection
import online.alarabiya.superapp.model.purchasing.ReminderHistoryItem
import online.alarabiya.superapp.model.purchasing.ReminderQueueItem
import online.alarabiya.superapp.model.purchasing.SupplierDetail
import online.alarabiya.superapp.model.purchasing.SupplierPage

sealed interface PurchasingConfirmation {
    val title: String
    val explanation: String

    data class ConfirmOrder(val id: Long, val number: String, val version: Int) : PurchasingConfirmation {
        override val title = "إرسال فاتورة الشراء للاعتماد"
        override val explanation = "سيُراجعها مستخدم مستقل. عند اعتماده بعد التأكد من وصول البضاعة، يضيف النظام كامل الكميات إلى المخزون ويرحّل القيد والذمة تلقائياً."
    }
    data class CancelOrder(val id: Long, val number: String, val version: Int) : PurchasingConfirmation {
        override val title = "إلغاء أمر الشراء"
        override val explanation = "سيتم إلغاء المسودة بعد تحقق الخادم من عدم وجود ترحيل مخزني أو أثر مالي."
    }
    data class SupplierActivation(val id: Long, val name: String, val active: Boolean) : PurchasingConfirmation {
        override val title = if (active) "إعادة تفعيل المورد" else "تعطيل المورد"
        override val explanation = if (active) "سيظهر المورد مجدداً في العمليات الجديدة." else "لن يقبل الخادم التعطيل إن وجدت التزامات مفتوحة."
    }
    data class SendReminder(val item: ReminderQueueItem) : PurchasingConfirmation {
        override val title = "إرسال تذكير"
        override val explanation = "سيُرسل عبر مزود الرسائل المعتمد ويسجل في سجل الذمم."
    }
}

enum class PurchasingExecutiveView { PAYABLES }

data class PurchasingUiState(
    val section: PurchasingSection,
    val busyKey: String? = null,
    val error: String? = null,
    val notice: String? = null,
    val query: String = "",
    val orders: List<PurchaseOrderSummary> = emptyList(),
    val catalog: List<PurchaseCatalogItem> = emptyList(),
    val selectedOrder: PurchaseOrderDetail? = null,
    val suppliers: SupplierPage = SupplierPage(emptyList(), 0),
    val selectedSupplier: SupplierDetail? = null,
    val returns: PurchaseReturnPage = PurchaseReturnPage(emptyList(), 0),
    val reminderQueue: List<ReminderQueueItem> = emptyList(),
    val reminderHistory: List<ReminderHistoryItem> = emptyList(),
    val executiveView: PurchasingExecutiveView? = null,
    val confirmation: PurchasingConfirmation? = null,
) {
    val locked get() = busyKey != null

    fun start(key: String): PurchasingUiState? = if (locked) null else copy(busyKey = key, error = null, notice = null)
    fun fail(message: String) = copy(busyKey = null, error = message, notice = null)
    fun succeed(message: String? = null) = copy(busyKey = null, error = null, notice = message, confirmation = null)
    fun switchTo(next: PurchasingSection) = copy(section = next, query = "", selectedOrder = null, selectedSupplier = null, executiveView = null, confirmation = null, error = null, notice = null)
}

/** Returns the state one level up inside Purchasing, or null when the module itself should close. */
internal fun PurchasingUiState.popNestedNavigation(): PurchasingUiState? = when {
    confirmation != null -> copy(confirmation = null, error = null)
    selectedOrder != null -> copy(selectedOrder = null, error = null)
    selectedSupplier != null -> copy(selectedSupplier = null, error = null)
    else -> null
}

internal fun PurchasingUiState.applyExecutiveNavigation(
    arguments: Map<String, String>,
    visibleSections: Collection<PurchasingSection>,
): PurchasingUiState {
    if (arguments["view"] != "payables" || PurchasingSection.REMINDERS !in visibleSections) return this
    return copy(
        section = PurchasingSection.REMINDERS,
        query = "",
        selectedOrder = null,
        selectedSupplier = null,
        executiveView = PurchasingExecutiveView.PAYABLES,
        confirmation = null,
        error = null,
        notice = null,
    )
}
