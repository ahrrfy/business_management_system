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

enum class AssetCategory(val wire: String, val label: String, val defaultLifeYears: Int) {
    Computers("computers", "أجهزة حاسوب", 4),
    Display("display", "شاشات وعرض", 5),
    Furniture("furniture", "أثاث مكتبي", 10),
    Vehicles("vehicles", "مركبات ونقل", 8),
    Printing("printing", "معدات الطباعة", 7),
    Devices("devices", "أجهزة تقنية", 5),
    Unknown("unknown", "فئة غير معروفة", 5);

    companion object {
        fun fromWire(value: String?): AssetCategory = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

enum class DepreciationMethod(val wire: String, val label: String) {
    StraightLine("sl", "القسط الثابت"),
    DecliningBalance("db", "القسط المتناقص");

    companion object {
        fun fromWire(value: String?): DepreciationMethod =
            entries.firstOrNull { it.wire == value } ?: StraightLine
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

data class AssetDocument(
    val id: Long,
    val title: String,
    val dataUrl: String?,
)

data class AssetDetail(
    val summary: AssetSummary,
    val brand: String?,
    val serial: String?,
    val supplierId: Long?,
    val supplierName: String?,
    val salvageValue: String,
    val usefulLifeYears: Int,
    val depreciationMethod: DepreciationMethod,
    val accumulatedDepreciation: String,
    val maintenanceTotal: String,
    val disposalDate: String?,
    val disposalReason: String?,
    val disposalValue: String?,
    val documents: List<AssetDocument>,
    val maintenance: List<AssetMaintenanceRecord>,
    val custody: List<AssetCustodyRecord>,
    val limitedToScopedSummary: Boolean,
)

data class AssetFormOption(
    val id: Long,
    val name: String,
    val branchId: Long? = null,
    val subtitle: String? = null,
)

data class AssetFormOptions(
    val employees: List<AssetFormOption>,
    val branches: List<AssetFormOption>,
    val suppliers: List<AssetFormOption>,
)

data class AssetUpsertInput(
    val id: Long? = null,
    val name: String,
    val category: AssetCategory,
    val brand: String?,
    val serial: String?,
    val branchId: Long?,
    val location: String?,
    val custodianId: Long? = null,
    val supplierId: Long?,
    val purchaseDate: String,
    val purchaseValue: String,
    val salvageValue: String,
    val usefulLifeYears: Int,
    val depreciationMethod: DepreciationMethod,
    val condition: String?,
    val warrantyEnd: String?,
)

data class AssetDisposalInput(
    val assetId: Long,
    val status: AssetStatus,
    val date: String,
    val reason: String?,
    val value: String?,
)

data class AssetDepreciationResult(
    val period: String,
    val assetsPosted: Int,
    val totalDepreciation: String,
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
    val isOwner: Boolean = false,
) {
    val isAdmin: Boolean get() = isOwner || role.equals("admin", ignoreCase = true)

    fun effectiveBranch(requestedBranchId: Long? = null): Long? =
        if (isAdmin) branchId ?: requestedBranchId else branchId

    fun acceptsBranch(candidateBranchId: Long?): Boolean =
        (isAdmin && branchId == null) ||
            (branchId != null && branchId > 0 && candidateBranchId == branchId)
}

data class OperationsCapabilities(
    val canReadAssets: Boolean,
    val canManageAssetState: Boolean,
    val canReadConsignments: Boolean,
    val canReadConsignmentLineDetails: Boolean,
    val canCreateConsignmentNotes: Boolean,
    val canReadMyCommission: Boolean,
    val canPostDepreciation: Boolean,
) {
    val canCreateAssets: Boolean get() = canManageAssetState
    val canEditAssets: Boolean get() = canManageAssetState
    val canManageCustody: Boolean get() = canManageAssetState
    val canDisposeAssets: Boolean get() = canManageAssetState
    val canManageAssetDocuments: Boolean get() = canManageAssetState

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
            isOwner: Boolean = false,
        ): OperationsCapabilities {
            val normalizedRole = if (isOwner) "admin" else role.lowercase()
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
                canPostDepreciation = assets == "FULL" && elevatedAssetWriter,
            )
        }
    }
}

object OperationsPolicy {
    fun canStartMaintenance(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canManageAssetState && asset.status == AssetStatus.Active

    fun canReturnFromMaintenance(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canManageAssetState && asset.status == AssetStatus.Maintenance

    fun canEditAsset(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canEditAssets && asset.status != AssetStatus.Disposed

    fun canHandoverAsset(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canManageCustody && asset.status in setOf(AssetStatus.Active, AssetStatus.Maintenance)

    fun canDisposeAsset(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canDisposeAssets && asset.status !in setOf(AssetStatus.Disposed, AssetStatus.Unknown)

    fun canManageDocuments(asset: AssetSummary, capabilities: OperationsCapabilities): Boolean =
        capabilities.canManageAssetDocuments && asset.status != AssetStatus.Unknown

    fun canCreateFollowUpNote(
        note: ConsignmentNoteSummary,
        capabilities: OperationsCapabilities,
        scope: OperationsScope,
    ): Boolean = capabilities.canCreateConsignmentNotes && scope.acceptsBranch(note.branchId)
}

object OperationsValidation {
    private val quantity = Regex("^\\d+(\\.\\d{1,3})?$")
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")
    private val date = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    fun isPositiveQuantity(value: String): Boolean =
        quantity.matches(value.trim()) && value.any { it in '1'..'9' }

    fun asset(input: AssetUpsertInput, scope: OperationsScope): String? {
        if (input.name.trim().isEmpty()) return "اسم الأصل مطلوب"
        if (input.category == AssetCategory.Unknown) return "فئة الأصل غير صالحة"
        if (!date.matches(input.purchaseDate)) return "تاريخ الشراء غير صالح"
        if (!money.matches(input.purchaseValue) || input.purchaseValue.toBigDecimalOrNull()?.signum() != 1) {
            return "قيمة الشراء يجب أن تكون أكبر من صفر وبمنزلتين كحد أقصى"
        }
        if (!money.matches(input.salvageValue)) return "القيمة التخريدية غير صالحة"
        val purchase = input.purchaseValue.toBigDecimalOrNull() ?: return "قيمة الشراء غير صالحة"
        val salvage = input.salvageValue.toBigDecimalOrNull() ?: return "القيمة التخريدية غير صالحة"
        if (salvage > purchase) return "القيمة التخريدية لا تتجاوز قيمة الشراء"
        if (input.usefulLifeYears !in 1..100) return "العمر الإنتاجي بين سنة و100 سنة"
        if (input.warrantyEnd != null && !date.matches(input.warrantyEnd)) return "تاريخ الكفالة غير صالح"
        if (!scope.isAdmin && input.branchId != scope.branchId) return "الأصل خارج نطاق الفرع"
        if (scope.branchId != null && input.branchId != scope.branchId) return "اختر فرع الجلسة الحالي"
        return null
    }

    fun disposal(input: AssetDisposalInput): String? {
        if (input.status !in setOf(AssetStatus.Retired, AssetStatus.Disposed)) return "نوع الاستبعاد غير صالح"
        if (!date.matches(input.date)) return "تاريخ الاستبعاد غير صالح"
        if (input.status == AssetStatus.Disposed && (input.value == null || !money.matches(input.value))) {
            return "أدخل عائد الاستبعاد، ويمكن أن يكون صفراً"
        }
        return null
    }
}
