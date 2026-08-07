package online.alarabiya.superapp.model.inventory

import online.alarabiya.superapp.model.AppBootstrap

enum class InventorySection { BALANCES, MOVEMENTS, TRANSFERS, ADJUSTMENTS, STOCKTAKES, MY_COUNTS }

enum class InventoryAccess {
    NONE, READ, FULL;
    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == FULL

    companion object {
        fun fromWire(value: String?): InventoryAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class InventoryCapabilities(
    val access: InventoryAccess,
    val userId: Long,
    val userName: String,
    val role: String,
    val branchId: Long?,
    val allBranches: Boolean,
) {
    val canRead: Boolean get() = access.canRead
    val canWrite: Boolean get() = access.canWrite && branchId != null
    val canManage: Boolean get() = canWrite && role in setOf("admin", "manager")
    val canViewStocktakes: Boolean get() = canRead && role in setOf("admin", "manager", "warehouse")
    val canCreateStocktake: Boolean get() = canWrite && role in setOf("admin", "manager", "warehouse")
    val canCancelStocktake: Boolean get() = canWrite && role == "admin"
    val visibleSections: List<InventorySection>
        get() = buildList {
            if (canRead && branchId != null) {
                add(InventorySection.BALANCES)
                add(InventorySection.MOVEMENTS)
                add(InventorySection.TRANSFERS)
                add(InventorySection.ADJUSTMENTS)
                if (canViewStocktakes) add(InventorySection.STOCKTAKES)
            }
            add(InventorySection.MY_COUNTS)
        }

    fun canReceive(transfer: TransferDetail): Boolean =
        canWrite && branchId == transfer.toBranchId && transfer.status == TransferStatus.IN_TRANSIT

    fun canCancel(transfer: TransferDetail): Boolean =
        canWrite && branchId == transfer.fromBranchId && transfer.status == TransferStatus.IN_TRANSIT

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): InventoryCapabilities {
            val access = bootstrap.modules.firstOrNull { it.key == "inventory" }?.access
            return InventoryCapabilities(
                access = InventoryAccess.fromWire(access),
                userId = bootstrap.user.id,
                userName = bootstrap.user.name,
                role = bootstrap.user.role,
                branchId = bootstrap.branchId,
                allBranches = bootstrap.allBranches,
            )
        }
    }
}

data class InventoryBranch(val id: Long, val name: String, val code: String?)

data class StockBalance(
    val variantId: Long,
    val branchId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String,
    val quantity: Int,
    val minimum: Int,
    val reorderPoint: Int,
    val isLow: Boolean,
    val lastCountedAt: String?,
) {
    val label: String get() = listOfNotNull(productName, variantName).joinToString(" · ")
}

enum class MovementType { IN, OUT, ADJUST, RETURN, TRANSFER_IN, TRANSFER_OUT, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}

data class InventoryMovement(
    val id: Long,
    val at: String?,
    val type: MovementType,
    val quantity: Int,
    val variantId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String,
    val branchName: String,
    val relatedBranchName: String?,
    val referenceType: String?,
    val referenceId: Long?,
    val notes: String?,
    val createdByName: String?,
)

data class MovementPage(val rows: List<InventoryMovement>, val hasMore: Boolean, val nextCursor: Long?)

enum class TransferStatus { IN_TRANSIT, RECEIVED, CANCELLED, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}

data class TransferSummary(
    val id: Long,
    val number: String,
    val fromBranchId: Long,
    val fromBranchName: String,
    val toBranchId: Long,
    val toBranchName: String,
    val status: TransferStatus,
    val reason: String?,
    val sent: Int,
    val received: Int?,
    val linesCount: Int,
    val createdAt: String?,
)

data class TransferPage(val rows: List<TransferSummary>, val nextCursor: Long?)

data class TransferLine(
    val id: Long,
    val variantId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String,
    val quantitySent: Int,
    val quantityReceived: Int?,
    val note: String?,
) {
    val label: String get() = listOfNotNull(productName, variantName, sku.takeIf(String::isNotBlank)).joinToString(" · ")
}

data class TransferDetail(
    val id: Long,
    val number: String,
    val fromBranchId: Long,
    val fromBranchName: String,
    val toBranchId: Long,
    val toBranchName: String,
    val status: TransferStatus,
    val reason: String?,
    val notes: String?,
    val receiveNotes: String?,
    val createdAt: String?,
    val createdByName: String?,
    val lines: List<TransferLine>,
)

data class TransferDraft(
    val variantId: Long = 0,
    val itemLabel: String = "",
    val toBranchId: Long? = null,
    val quantity: String = "",
    val reason: String = "REBALANCE",
    val notes: String = "",
    val clientRequestId: String = "",
)

data class ReceiveLineDraft(val lineId: Long, val quantity: String, val note: String = "")
data class ReceiveDraft(
    val transferId: Long,
    val lines: List<ReceiveLineDraft>,
    val notes: String = "",
    val clientRequestId: String,
)

enum class AdjustmentStatus { PENDING_APPROVAL, APPROVED, REJECTED, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}

data class AdjustmentRequest(
    val id: Long,
    val variantId: Long,
    val branchId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String,
    val expectedQuantity: Int,
    val currentQuantity: Int,
    val targetQuantity: Int,
    val status: AdjustmentStatus,
    val notes: String?,
    val createdBy: Long?,
    val createdByName: String?,
    val createdAt: String?,
    val rejectionReason: String?,
)

data class AdjustmentDraft(
    val variantId: Long,
    val itemLabel: String,
    val targetQuantity: String,
    val notes: String = "",
)

enum class StocktakeStatus { COUNTING, REVIEW, APPROVED, CANCELLED, UNKNOWN;
    companion object { fun fromWire(value: String?) = entries.firstOrNull { it.name == value } ?: UNKNOWN }
}

data class StocktakeSummary(
    val id: Long,
    val code: String,
    val name: String,
    val branchId: Long,
    val branchName: String,
    val scopeLabel: String,
    val status: StocktakeStatus,
    val itemCount: Int,
    val countedCount: Int,
    val createdAt: String?,
    val createdByName: String,
)

data class StocktakeAssignment(
    val id: Long,
    val name: String,
    val method: String,
    val zone: String?,
    val status: String,
    val counted: Int,
)

data class StocktakeRecentCount(
    val variantId: Long,
    val productName: String,
    val variantName: String?,
    val quantity: Int,
    val byName: String?,
    val at: String?,
)

data class StocktakeDetail(
    val summary: StocktakeSummary,
    val blind: Boolean,
    val notes: String?,
    val assignments: List<StocktakeAssignment>,
    val total: Int,
    val counted: Int,
    val recentCounts: List<StocktakeRecentCount>,
)

data class StocktakeDraft(
    val name: String = "",
    val scopeType: String = "FULL",
    val movingDays: String = "30",
    val notes: String = "",
)

data class CountAssignment(
    val sessionCode: String,
    val sessionName: String,
    val branchId: Long,
    val assignmentId: Long,
    val status: String,
    val zone: String?,
    val lastActivityAt: String?,
)

data class CountItem(
    val variantId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String,
    val counted: Boolean,
    val myQuantity: Int?,
    val colleagueCounted: Boolean,
    val recountReason: String?,
) {
    val label: String get() = listOfNotNull(productName, variantName, sku.takeIf(String::isNotBlank)).joinToString(" · ")
}

data class CountSession(
    val code: String,
    val name: String,
    val branchName: String,
    val assignmentName: String,
    val zone: String?,
    val counted: Int,
    val total: Int,
    val items: List<CountItem>,
)

object InventoryValidation {
    private val transferReasons = setOf("REBALANCE", "STOCKOUT", "BRANCH_REQ", "SEASONAL", "RETURN_HQ", "OTHER")

    fun transfer(draft: TransferDraft, branchId: Long?): String? = when {
        branchId == null -> "لا يوجد فرع مرتبط بالجلسة"
        draft.variantId <= 0 -> "اختر صنفاً من الرصيد"
        draft.toBranchId == null || draft.toBranchId <= 0 -> "اختر الفرع المستلم"
        draft.toBranchId == branchId -> "لا يمكن التحويل إلى الفرع نفسه"
        draft.quantity.toIntOrNull()?.let { it <= 0 } != false -> "الكمية يجب أن تكون عدداً صحيحاً موجباً"
        draft.reason !in transferReasons -> "سبب التحويل غير صالح"
        draft.clientRequestId.isBlank() -> "مفتاح الطلب غير صالح"
        else -> null
    }

    fun receive(detail: TransferDetail, draft: ReceiveDraft): String? {
        if (draft.lines.size != detail.lines.size) return "يجب مطابقة كل أسطر السند"
        detail.lines.forEach { line ->
            val entered = draft.lines.firstOrNull { it.lineId == line.id } ?: return "سطر استلام مفقود"
            val qty = entered.quantity.toIntOrNull() ?: return "كمية الاستلام غير صالحة"
            if (qty !in 0..line.quantitySent) return "الكمية المستلمة خارج نطاق المرسل"
            if (qty != line.quantitySent && entered.note.trim().isEmpty()) return "اشرح سبب الفرق في سطر الاستلام"
        }
        return null
    }

    fun adjustment(draft: AdjustmentDraft, branchId: Long?): String? = when {
        branchId == null -> "لا يوجد فرع مرتبط بالجلسة"
        draft.variantId <= 0 -> "اختر صنفاً"
        draft.targetQuantity.toIntOrNull()?.let { it < 0 } != false -> "الرصيد المستهدف عدد صحيح غير سالب"
        else -> null
    }

    fun stocktake(draft: StocktakeDraft, branchId: Long?): String? = when {
        branchId == null -> "لا يوجد فرع مرتبط بالجلسة"
        draft.name.trim().isEmpty() -> "اسم جلسة الجرد مطلوب"
        draft.scopeType !in setOf("FULL", "MOVING") -> "نطاق الجرد غير مدعوم في التطبيق"
        draft.scopeType == "MOVING" && draft.movingDays.toIntOrNull()?.let { it !in 1..365 } != false -> "أيام الحركة بين 1 و365"
        else -> null
    }

    fun count(quantity: String): String? =
        if (quantity.toIntOrNull()?.let { it < 0 } != false) "الكمية عدد صحيح غير سالب" else null
}

object NativeInventoryContractGaps {
    const val ADJUSTMENT_IDEMPOTENCY = "inventory.adjust لا يقبل clientRequestId؛ يمنع العميل النقر المكرر لكنه لا يستطيع ضمان إعادة إرسال آمنة بعد انقطاع الرد."
    const val STOCKTAKE_IDEMPOTENCY = "stocktakes.create لا يقبل clientRequestId؛ لا يعيد التطبيق الإرسال تلقائياً عند غموض نتيجة الشبكة."
    const val STOCKTAKE_PAGINATION = "stocktakes.list يعتمد offset ولا يعيد total/hasMore؛ التطبيق يعرض الصفحة الموثقة فقط."
    const val MANUAL_MOVEMENT = "inventory.createManualMovement يفشل مغلقاً عمداً؛ الزيادة والنقص تمران عبر مستند المصدر أو طلب التسوية."
}
