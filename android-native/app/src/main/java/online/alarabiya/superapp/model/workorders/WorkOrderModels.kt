package online.alarabiya.superapp.model.workorders

import online.alarabiya.superapp.model.AppBootstrap

enum class WorkOrdersSection { ORDERS, PRINT_SERVICES, PRICING, PRODUCTION }
enum class ModuleAccess { NONE, READ, FULL;
    val canRead get() = this != NONE
    val canWrite get() = this == FULL
    companion object { fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: NONE }
}

data class WorkOrdersCapabilities(
    val workorders: ModuleAccess,
    val pos: ModuleAccess,
    val inventory: ModuleAccess,
    val role: String,
    val userId: Long,
    val branchId: Long?,
) {
    val canReadOrders get() = workorders.canRead && branchId != null
    val canCreateOrders get() = workorders.canWrite && branchId != null && role in setOf("admin", "manager", "cashier")
    val canExecuteOrders get() = workorders.canWrite && branchId != null && role in setOf("admin", "manager", "cashier", "print_operator")
    val canManageOrders get() = workorders.canWrite && branchId != null && role in setOf("admin", "manager")
    val canDeliverOrders get() = canCreateOrders
    val canReadPrintServices get() = pos.canWrite && role in setOf("admin", "manager", "cashier")
    val canUsePricing get() = role in setOf("admin", "manager")
    val canManageProduction get() = inventory.canWrite && branchId != null && role in setOf("admin", "manager")
    val sections get() = buildList {
        if (canReadOrders) add(WorkOrdersSection.ORDERS)
        if (canReadPrintServices) add(WorkOrdersSection.PRINT_SERVICES)
        if (canUsePricing) add(WorkOrdersSection.PRICING)
        if (canManageProduction) add(WorkOrdersSection.PRODUCTION)
    }
    companion object {
        fun fromBootstrap(value: AppBootstrap) = WorkOrdersCapabilities(
            workorders = ModuleAccess.wire(value.modules.firstOrNull { it.key == "workorders" }?.access),
            pos = ModuleAccess.wire(value.modules.firstOrNull { it.key == "pos" }?.access),
            inventory = ModuleAccess.wire(value.modules.firstOrNull { it.key == "inventory" }?.access),
            role = value.user.role,
            userId = value.user.id,
            branchId = value.branchId,
        )
    }
}

enum class WorkOrderStatus { RECEIVED, IN_PROGRESS, READY, DELIVERED, CANCELLED, UNKNOWN;
    companion object { fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}
enum class WorkOrderPriority { LOW, NORMAL, URGENT, UNKNOWN;
    companion object { fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}
enum class ReceptionChannel { WALK_IN, WHATSAPP, INSTAGRAM, TIKTOK, PHONE, OTHER }
enum class PaymentMethod { CASH, CARD, CHECK, TRANSFER, WALLET }
enum class PriceTier { RETAIL, WHOLESALE, GOVERNMENT }
enum class WorkQueue { ALL, MINE, UNASSIGNED }
enum class WorkOrderAction { ASSIGN, CLAIM, START, MARK_READY, DELIVER, CANCEL }

data class WorkOrderCounts(val received: Int, val inProgress: Int, val ready: Int, val delivered: Int, val cancelled: Int, val late: Int)
data class WorkOrderSummary(
    val id: Long, val number: String, val title: String, val quantity: Int,
    val status: WorkOrderStatus, val priority: WorkOrderPriority, val channel: String?,
    val salePrice: String, val deposit: String, val dueDate: String?, val createdAt: String?,
    val assignedTo: Long?, val assigneeName: String?, val customerName: String?,
    val hasDelivery: Boolean, val deliveryAddress: String?, val consignmentStatus: String?, val deliveryPartyName: String?,
)
data class WorkOrderMaterial(val id: Long, val variantId: Long, val label: String, val sku: String, val baseQuantity: Int, val unitCost: String?)
data class WorkOrderTimeline(val id: Long, val action: String, val at: String?, val userName: String?)
data class WorkOrderDetail(
    val id: Long, val number: String, val title: String, val customizationText: String?, val quantity: Int,
    val status: WorkOrderStatus, val priority: WorkOrderPriority, val branchId: Long,
    val customerId: Long?, val customerName: String?, val customerPhone: String?,
    val materialsCost: String?, val laborCost: String?, val salePrice: String, val deposit: String,
    val dueDate: String?, val hasDelivery: Boolean, val deliveryAddress: String?, val deliveryPhone: String?,
    val deliveryCost: String?, val assignedTo: Long?, val assigneeName: String?, val workStartedAt: String?,
    val workSeconds: Long?, val deliveredAt: String?, val materials: List<WorkOrderMaterial>, val timeline: List<WorkOrderTimeline>,
)

fun WorkOrdersCapabilities.actionsFor(order: WorkOrderDetail): Set<WorkOrderAction> = buildSet {
    val active = order.status !in setOf(WorkOrderStatus.DELIVERED, WorkOrderStatus.CANCELLED)
    if (canManageOrders && active) { add(WorkOrderAction.ASSIGN); add(WorkOrderAction.CANCEL) }
    if (canExecuteOrders && order.status == WorkOrderStatus.RECEIVED && order.assignedTo == null) add(WorkOrderAction.CLAIM)
    val ownsExecution = role != "print_operator" || order.assignedTo == userId
    if (canExecuteOrders && ownsExecution && order.status == WorkOrderStatus.RECEIVED && (role != "print_operator" || order.assignedTo != null)) add(WorkOrderAction.START)
    if (canExecuteOrders && ownsExecution && order.status == WorkOrderStatus.IN_PROGRESS) add(WorkOrderAction.MARK_READY)
    if (canDeliverOrders && order.status == WorkOrderStatus.READY) add(WorkOrderAction.DELIVER)
}
data class StaffOption(val id: Long, val name: String)
data class WorkOrderDraft(
    val title: String = "", val customizationText: String = "", val quantity: String = "1",
    val salePrice: String = "", val dueDate: String = "", val notes: String = "",
    val assignedTo: Long? = null, val channel: ReceptionChannel = ReceptionChannel.WALK_IN,
    val priority: WorkOrderPriority = WorkOrderPriority.NORMAL, val hasDelivery: Boolean = false,
    val deliveryAddress: String = "", val deliveryPhone: String = "", val deliveryCost: String = "0",
    val clientRequestId: String,
)
data class DeliveryDraft(val amount: String = "", val method: PaymentMethod = PaymentMethod.CASH, val reference: String = "", val clientRequestId: String)

data class PrintService(val productId: Long, val productName: String, val variantId: Long, val sku: String, val productUnitId: Long, val unitName: String, val categoryName: String?, val price: String?)
data class PricingOption(val id: Long, val name: String, val unit: String, val price: String)
data class PricingBundle(
    val mode: String, val margin: String, val setupFee: String,
    val paperUpcharges: List<PricingOption>, val wideMedia: List<PricingOption>, val finishings: List<PricingOption>,
)
data class PricingDraft(
    val category: String = "SMALL", val paperSize: String = "A4", val colorMode: String = "BW",
    val sides: Int = 1, val copies: String = "1", val pagesPerCopy: String = "1",
    val mediaId: Long? = null, val width: String = "1", val height: String = "1", val quantity: String = "1",
    val paperUpchargeId: Long? = null, val finishingIds: Set<Long> = emptySet(), val applySetupFee: Boolean = true,
)
data class EstimateLine(val label: String, val amount: String, val detail: String?)
data class PrintEstimate(val category: String, val units: Int, val faces: Int?, val sheets: Int?, val areaSqm: String?, val totalCost: String, val suggestedPrice: String, val unitPrice: String, val lines: List<EstimateLine>)

enum class ProductionStatus { CONFIRMED, CANCELLED, UNKNOWN;
    companion object { fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}
data class ProductionSummary(val id: Long, val number: String, val branchId: Long, val branchName: String, val status: ProductionStatus, val outputQty: Int, val totalCost: String, val createdAt: String?)
data class ProductionLine(val id: Long, val direction: String, val label: String, val sku: String, val baseQuantity: Int, val lineCost: String?, val allocatedCost: String?)
data class ProductionDetail(val id: Long, val number: String, val branchId: Long, val status: ProductionStatus, val branchName: String, val batchQty: Int?, val goodQty: Int?, val scrapQty: Int?, val totalCost: String, val recipeName: String?, val linkedWorkOrderId: Long?, val inputs: List<ProductionLine>, val outputs: List<ProductionLine>)
data class RecipeSummary(val id: Long, val name: String, val outputName: String, val outputUnit: String, val linesCount: Int, val active: Boolean)
data class RecipeRunDraft(val recipeId: Long? = null, val batchQty: String = "1", val scrapQty: String = "0", val laborPerUnit: String = "", val notes: String = "", val clientRequestId: String)
data class RecipePreview(val recipeId: Long, val outputName: String, val outputBase: Int, val laborCost: String, val materialsCost: String, val totalCost: String, val anyShort: Boolean, val inputs: List<RecipePreviewLine>)
data class RecipePreviewLine(val label: String, val sku: String, val required: Int, val available: Int?, val lineCost: String)

object WorkOrderValidation {
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")
    private val quantity = Regex("^\\d+(\\.\\d{1,3})?$")
    private val ymd = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    fun create(draft: WorkOrderDraft, branchId: Long?): String? = when {
        branchId == null -> "لا يوجد فرع مرتبط بالجلسة"
        draft.title.trim().isEmpty() -> "عنوان أمر الشغل مطلوب"
        draft.quantity.toIntOrNull()?.let { it <= 0 } != false -> "الكمية عدد صحيح موجب"
        !money.matches(draft.salePrice) || draft.salePrice.toDoubleOrNull()?.let { it <= 0 } != false -> "سعر البيع غير صالح"
        draft.dueDate.isNotBlank() && !ymd.matches(draft.dueDate.trim()) -> "تاريخ الاستحقاق بصيغة YYYY-MM-DD"
        draft.hasDelivery && draft.deliveryAddress.trim().isEmpty() -> "عنوان التوصيل مطلوب"
        draft.deliveryCost.isNotBlank() && !money.matches(draft.deliveryCost) -> "كلفة التوصيل غير صالحة"
        draft.clientRequestId.isBlank() -> "مفتاح الطلب غير صالح"
        else -> null
    }
    fun delivery(draft: DeliveryDraft, customerId: Long?): String? = when {
        draft.amount.isBlank() && customerId == null -> "أدخل المبلغ الكامل لطلب بلا عميل"
        draft.amount.isNotBlank() && (!money.matches(draft.amount) || draft.amount.toDoubleOrNull()?.let { it <= 0 } != false) -> "مبلغ التسليم غير صالح"
        draft.amount.isNotBlank() && draft.method != PaymentMethod.CASH && draft.reference.trim().isEmpty() -> "مرجع الدفع مطلوب"
        draft.clientRequestId.isBlank() -> "مفتاح الطلب غير صالح"
        else -> null
    }
    fun pricing(draft: PricingDraft): String? = when {
        draft.finishingIds.size > 30 -> "عدد خدمات الإنهاء يتجاوز الحد المسموح"
        draft.category == "SMALL" && draft.paperSize !in PAPER_SIZES -> "حجم الورق غير صالح"
        draft.category == "SMALL" && draft.colorMode !in setOf("BW", "COLOR") -> "نمط اللون غير صالح"
        draft.category == "SMALL" && draft.sides !in setOf(1, 2) -> "عدد الأوجه غير صالح"
        draft.category == "SMALL" && draft.copies.toIntOrNull()?.let { it !in 1..1_000_000 } != false -> "عدد النسخ غير صالح"
        draft.category == "SMALL" && draft.pagesPerCopy.toIntOrNull()?.let { it !in 1..1_000_000 } != false -> "عدد الصفحات غير صالح"
        draft.category == "WIDE" && draft.mediaId == null -> "اختر وسيط الطباعة"
        draft.category == "WIDE" && (!quantity.matches(draft.width) || draft.width.toDoubleOrNull()?.let { it <= 0 } != false) -> "العرض غير صالح"
        draft.category == "WIDE" && (!quantity.matches(draft.height) || draft.height.toDoubleOrNull()?.let { it <= 0 } != false) -> "الارتفاع غير صالح"
        draft.category == "WIDE" && draft.quantity.toIntOrNull()?.let { it !in 1..1_000_000 } != false -> "الكمية غير صالحة"
        draft.category !in setOf("SMALL", "WIDE") -> "فئة الطباعة غير صالحة"
        else -> null
    }
    fun production(draft: RecipeRunDraft, branchId: Long?): String? = when {
        branchId == null -> "لا يوجد فرع مرتبط بالجلسة"
        draft.recipeId == null -> "اختر وصفة إنتاج"
        draft.batchQty.toIntOrNull()?.let { it <= 0 } != false -> "كمية الدفعة عدد صحيح موجب"
        draft.scrapQty.toIntOrNull()?.let { it < 0 } != false -> "الهدر عدد صحيح غير سالب"
        draft.batchQty.toIntOrNull() != null && draft.scrapQty.toIntOrNull() != null && draft.scrapQty.toInt() >= draft.batchQty.toInt() -> "الهدر يجب أن يكون أقل من الدفعة"
        draft.laborPerUnit.isNotBlank() && !money.matches(draft.laborPerUnit) -> "كلفة العمل للوحدة غير صالحة"
        draft.clientRequestId.isBlank() -> "مفتاح الطلب غير صالح"
        else -> null
    }

    private val PAPER_SIZES = setOf("A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10")
}

object NativeWorkOrderContractGaps {
    const val PRINT_SALE_SHIFT = "printPos.createSale يتطلب سياق وردية/درج مالي غير موجود في AppBootstrap؛ لم يُنفّذ بيع صوري داخل وحدة أوامر الشغل."
    const val WORK_ORDER_MATERIAL_PICKER = "workOrders.create يحتاج variantId للمواد ولا يوجد عقد بحث مواد مخصص داخل workOrders؛ الإنشاء الأصلي هنا خدمة خالصة بلا خصم مواد."
    const val CREATE_PRICING_LINK = "printPricing.estimate مستقل صراحةً ولا يرتبط بأمر الشغل؛ السعر المقترح لا يُرسل تلقائياً دون مراجعة المستخدم."
    const val TRANSITION_IDEMPOTENCY = "claim/start/markReady/cancel لا تقبل clientRequestId؛ تُرسل مرة واحدة ولا يعاد تشغيلها تلقائياً عند غموض الشبكة."
}
