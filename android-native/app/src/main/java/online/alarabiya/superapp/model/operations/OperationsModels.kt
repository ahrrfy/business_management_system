package online.alarabiya.superapp.model.operations

enum class OperationsSection(val label: String) {
    Assets("الأصول"),
    Custody("العُهد"),
    MyCommission("أدائي"),
    Consignment("الأمانة"),
}

enum class AssetStatus(val wire: String, val label: String) {
    Active("active", "بالخدمة"),
    Maintenance("maintenance", "في الصيانة"),
    Retired("retired", "خارج الخدمة"),
    Disposed("disposed", "مُستبعَد"),
    Unknown("unknown", "حالة غير معروفة");

    companion object {
        val filterable: List<AssetStatus> = entries.filterNot { it == Unknown }
        fun fromWire(value: String?): AssetStatus = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

enum class AssetCategory(val wire: String, val label: String) {
    Computers("computers", "أجهزة حاسوب"),
    Display("display", "شاشات وعرض"),
    Furniture("furniture", "أثاث مكتبي"),
    Vehicles("vehicles", "مركبات ونقل"),
    Printing("printing", "معدات الطباعة"),
    Devices("devices", "أجهزة تقنية"),
    Unknown("unknown", "فئة غير معروفة");

    companion object {
        fun fromWire(value: String?): AssetCategory = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

data class AssetSummary(
    val id: Long,
    val code: String,
    val name: String,
    val category: AssetCategory,
    val status: AssetStatus,
    val branchId: Long?,
    val branchName: String?,
    val location: String?,
    val custodianId: Long?,
    val custodianName: String?,
    val purchaseDate: String?,
    val purchaseValue: String,
    val bookValue: String,
    val depreciationPct: String,
    val condition: String?,
    val warrantyEnd: String?,
)

data class AssetMaintenanceRecord(
    val id: Long,
    val date: String?,
    val type: String,
    val vendor: String?,
    val cost: String,
    val note: String?,
)

data class AssetCustodyRecord(
    val id: Long,
    val employeeName: String?,
    val fromDate: String?,
    val toDate: String?,
    val note: String?,
)

data class AssetDetail(
    val summary: AssetSummary,
    val supplierName: String?,
    val maintenance: List<AssetMaintenanceRecord>,
    val custody: List<AssetCustodyRecord>,
    val limitedToScopedSummary: Boolean,
)

data class CommissionHistoryEntry(
    val period: String,
    val effectiveBase: String,
    val commissionAmount: String,
    val approved: Boolean,
)

data class MyCommissionStatus(
    val period: String,
    val employeeName: String,
    val planName: String?,
    val sales: String,
    val returns: String,
    val consignmentDeduction: String,
    val carryIn: String,
    val effectiveBase: String,
    val target: String?,
    val achievementPct: String?,
    val projectedCommission: String,
    val settledAmount: String?,
    val settledApproved: Boolean,
    val history: List<CommissionHistoryEntry>,
)

enum class ConsignmentNoteType(val wire: String, val label: String) {
    Deposit("DEPOSIT", "إيداع"),
    Withdraw("WITHDRAW", "سحب"),
    Exchange("EXCHANGE", "استبدال"),
    Unknown("UNKNOWN", "نوع غير معروف");

    companion object {
        val filterable: List<ConsignmentNoteType> = entries.filterNot { it == Unknown }
        fun fromWire(value: String?): ConsignmentNoteType = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

data class ConsignmentNoteSummary(
    val id: Long,
    val noteNumber: String,
    val type: ConsignmentNoteType,
    val consignorId: Long,
    val consignorName: String,
    val branchId: Long,
    val hasAttachment: Boolean,
    val createdAt: String?,
)

data class ConsignmentLine(
    val id: Long,
    val directionIn: Boolean,
    val variantId: Long,
    val productName: String,
    val sku: String?,
    val quantity: String,
    val baseQuantity: String,
    val unitShare: String?,
    val notes: String?,
)

data class ConsignmentNoteDetail(
    val summary: ConsignmentNoteSummary,
    val consignorPhone: String?,
    val notes: String?,
    val hasAttachment: Boolean,
    val lines: List<ConsignmentLine>,
    val limitedToScopedSummary: Boolean,
)

data class ConsignorProduct(
    val variantId: Long,
    val productUnitId: Long,
    val productName: String,
    val sku: String?,
    val color: String?,
    val unitName: String?,
)

data class QuickConsignmentInput(
    val type: ConsignmentNoteType,
    val consignorId: Long,
    val branchId: Long,
    val product: ConsignorProduct,
    val quantity: String,
    val notes: String?,
    val clientRequestId: String,
)

data class ConsignmentPage(
    val rows: List<ConsignmentNoteSummary>,
    val total: Int,
    val offset: Int,
    val limit: Int,
) {
    val hasMore: Boolean get() = offset + rows.size < total
}

data class OperationsScope(
    val role: String,
    val branchId: Long?,
) {
    val isAdmin: Boolean get() = role.equals("admin", ignoreCase = true)

    fun effectiveBranch(requestedBranchId: Long? = null): Long? =
        if (isAdmin) requestedBranchId else branchId

    fun acceptsBranch(candidateBranchId: Long?): Boolean =
        isAdmin || (branchId != null && branchId > 0 && candidateBranchId == branchId)
}

data class OperationsCapabilities(
    val canReadAssets: Boolean,
    val canManageAssetState: Boolean,
    val canReadConsignments: Boolean,
    val canReadConsignmentLineDetails: Boolean,
    val canCreateConsignmentNotes: Boolean,
    val canReadMyCommission: Boolean,
) {
    val sections: List<OperationsSection>
        get() = buildList {
            if (canReadAssets) {
                add(OperationsSection.Assets)
                add(OperationsSection.Custody)
            }
            if (canReadMyCommission) add(OperationsSection.MyCommission)
            if (canReadConsignments) add(OperationsSection.Consignment)
        }

    companion object {
        fun from(
            role: String,
            branchId: Long?,
            assetsAccess: String?,
            consignmentAccess: String?,
            commissionsAccess: String? = null,
        ): OperationsCapabilities {
            val normalizedRole = role.lowercase()
            val assets = assetsAccess?.uppercase() ?: "NONE"
            val consignments = consignmentAccess?.uppercase() ?: "NONE"
            val commissions = commissionsAccess?.uppercase() ?: "NONE"
            val elevatedAssetWriter = normalizedRole in setOf("admin", "manager")
            val consignmentWriter = normalizedRole in setOf("admin", "manager", "warehouse", "accountant")
            return OperationsCapabilities(
                canReadAssets = assets == "READ" || assets == "FULL",
                canManageAssetState = assets == "FULL" && elevatedAssetWriter,
                canReadConsignments = consignments == "READ" || consignments == "FULL",
                // consignments.get currently leaks unitShareSnapshot without canSeeCostForUser masking.
                canReadConsignmentLineDetails = consignments != "NONE" && normalizedRole == "admin",
                canCreateConsignmentNotes = consignments == "FULL" && consignmentWriter &&
                    (normalizedRole == "admin" || branchId != null),
                canReadMyCommission = commissions == "READ" || commissions == "FULL",
            )
        }
    }
}

object OperationsPolicy {
    fun canStartMaintenance(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canManageAssetState && asset.status == AssetStatus.Active

    fun canReturnFromMaintenance(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canManageAssetState && asset.status == AssetStatus.Maintenance

    fun canCreateFollowUpNote(
        note: ConsignmentNoteSummary,
        capabilities: OperationsCapabilities,
        scope: OperationsScope,
    ): Boolean = capabilities.canCreateConsignmentNotes && scope.acceptsBranch(note.branchId)
}

object OperationsValidation {
    private val quantity = Regex("^\\d+(\\.\\d{1,3})?$")

    fun isPositiveQuantity(value: String): Boolean =
        quantity.matches(value.trim()) && value.any { it in '1'..'9' }
}
