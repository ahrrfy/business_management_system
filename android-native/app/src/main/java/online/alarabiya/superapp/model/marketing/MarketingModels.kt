package online.alarabiya.superapp.model.marketing

enum class MarketingSection(val label: String) {
    Promotions("العروض"),
    Coupons("الكوبونات"),
    CatalogQuality("جودة الكتالوج"),
}

enum class PromotionType(val wire: String, val label: String) {
    Percent("PERCENT", "نسبة"),
    Amount("AMOUNT", "مبلغ ثابت"),
    Unknown("UNKNOWN", "غير معروف");

    companion object {
        fun fromWire(value: String?): PromotionType = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

enum class PromotionScope(val wire: String, val label: String) {
    All("ALL", "كل الكتالوج"),
    Categories("CATEGORIES", "فئات محددة"),
    Products("PRODUCTS", "منتجات محددة"),
    Unknown("UNKNOWN", "غير معروف");

    companion object {
        fun fromWire(value: String?): PromotionScope = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

enum class CustomerTier(val wire: String, val label: String) {
    Retail("RETAIL", "تجزئة"),
    Wholesale("WHOLESALE", "جملة"),
    Government("GOVERNMENT", "حكومي");

    companion object {
        fun fromWire(value: String?): CustomerTier? = entries.firstOrNull { it.wire == value }
    }
}

enum class PromotionMode(val wire: String, val label: String) {
    Auto("AUTO", "تلقائي"),
    Coupon("COUPON", "كوبون");

    companion object {
        fun fromWire(value: String?): PromotionMode = entries.firstOrNull { it.wire == value } ?: Auto
    }
}

enum class PromotionChannel(val wire: String, val label: String) {
    Pos("POS", "نقطة البيع"),
    Store("STORE", "المتجر");
}

data class PromotionTarget(
    val categoryId: Long? = null,
    val productId: Long? = null,
    val variantId: Long? = null,
)

data class PromotionSummary(
    val id: Long,
    val campaignId: Long?,
    val name: String,
    val description: String?,
    val type: PromotionType,
    val discountPercent: String,
    val discountAmount: String,
    val scope: PromotionScope,
    val effectiveFrom: String,
    val effectiveTo: String?,
    val customerTier: CustomerTier?,
    val branchId: Long?,
    val minLineAmount: String,
    val priority: Int,
    val isActive: Boolean,
    val mode: PromotionMode,
    val channel: PromotionChannel,
)

data class PromotionDetail(
    val promotion: PromotionSummary,
    val targets: List<PromotionTarget>,
)

data class PromotionDraft(
    val name: String,
    val description: String = "",
    val type: PromotionType,
    val discountValue: String,
    val scope: PromotionScope,
    val effectiveFrom: String,
    val effectiveTo: String? = null,
    val customerTier: CustomerTier? = null,
    val branchId: Long? = null,
    val minLineAmount: String = "0",
    val priority: Int = 0,
    val mode: PromotionMode = PromotionMode.Auto,
    val channel: PromotionChannel = PromotionChannel.Pos,
    val campaignId: Long? = null,
    val targets: List<PromotionTarget> = emptyList(),
)

enum class CouponProgramStatus(val wire: String, val label: String) {
    Draft("DRAFT", "مسودة"),
    Active("ACTIVE", "نشط"),
    Paused("PAUSED", "متوقف"),
    Ended("ENDED", "منتهي"),
    Unknown("UNKNOWN", "غير معروف");

    companion object {
        fun fromWire(value: String?): CouponProgramStatus = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

data class CouponProgram(
    val id: Long,
    val campaignId: Long?,
    val promotionId: Long,
    val name: String,
    val status: CouponProgramStatus,
    val branchId: Long?,
    val validFrom: String,
    val validTo: String?,
    val perCouponLimit: Int,
    val perCustomerLimit: Int,
    val codePrefix: String,
    val designTitle: String?,
    val designSubtitle: String?,
    val designTerms: String?,
    val designColor: String?,
    val issued: Int,
    val redeemed: Int,
    val createdAt: String?,
)

data class CouponProgramDraft(
    val promotionId: Long,
    val name: String,
    val branchId: Long?,
    val validFrom: String,
    val validTo: String? = null,
    val perCouponLimit: Int = 1,
    val perCustomerLimit: Int = 1,
    val codePrefix: String = "CRM",
    val campaignId: Long? = null,
    val title: String = "",
    val subtitle: String = "",
    val terms: String = "",
    val color: String = "#0F766E",
)

enum class CouponStatus(val wire: String, val label: String) {
    Active("ACTIVE", "نشط"),
    Redeemed("REDEEMED", "مستخدم"),
    Void("VOID", "ملغى"),
    Unknown("UNKNOWN", "غير معروف");

    companion object {
        fun fromWire(value: String?): CouponStatus = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

data class IssuedCoupon(
    val id: Long,
    val programId: Long,
    val code: String,
    val customerId: Long?,
    val status: CouponStatus,
    val redemptionCount: Int,
    val issuedAt: String?,
)

data class IssuedCouponPage(
    val rows: List<IssuedCoupon>,
    val total: Int,
    val activeCount: Int,
    val offset: Int,
    val limit: Int,
) {
    val hasMore: Boolean get() = offset + rows.size < total
}

data class CouponPreviewLineInput(
    val productId: Long,
    val variantId: Long,
    val productUnitId: Long,
    val unitPrice: String,
    val quantity: Int,
    val hasContractPrice: Boolean = false,
)

data class CouponPreviewRequest(
    val code: String,
    val branchId: Long,
    val customerId: Long?,
    val customerTier: CustomerTier,
    val lines: List<CouponPreviewLineInput>,
)

data class CouponPriceEffect(
    val productUnitId: Long,
    val promotionId: Long,
    val promotionName: String,
    val discountPerUnit: String,
    val effectivePrice: String,
)

data class CouponPreview(
    val code: String,
    val programName: String,
    val lines: List<CouponPriceEffect>,
)

enum class AnomalyCode(val wire: String, val label: String) {
    L1("L1", "تكلفة أعلى بشدة من البيع"),
    L2("L2", "تكلفة أعلى من البيع"),
    L3("L3", "تكلفة مساوية للبيع"),
    L4("L4", "تكلفة مفقودة"),
    L5("L5", "معامل وحدة غير سليم"),
    L6("L6", "سعر وحدة غير متزن"),
    Unknown("UNKNOWN", "عدسة غير معروفة");

    companion object {
        fun fromWire(value: String?): AnomalyCode = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

enum class AnomalySeverity(val wire: String, val label: String) {
    Blocker("blocker", "حرج"),
    Warning("warning", "تحذير"),
    Info("info", "معلومة"),
    Unknown("unknown", "غير معروف");

    companion object {
        fun fromWire(value: String?): AnomalySeverity = entries.firstOrNull { it.wire == value } ?: Unknown
    }
}

data class CatalogAnomaly(
    val variantId: Long,
    val productId: Long,
    val sku: String,
    val productName: String,
    val code: AnomalyCode,
    val severity: AnomalySeverity,
    val metrics: Map<String, String>,
    val note: String,
    val overrideKind: String?,
    val overrideUntil: String?,
)

data class CatalogAnomalyPage(
    val findings: List<CatalogAnomaly>,
    val blockerCount: Int,
    val warningCount: Int,
    val infoCount: Int,
    val overriddenCount: Int,
    val total: Int,
    val hasMore: Boolean,
    val truncatedLenses: List<String>,
    val offset: Int,
    val limit: Int,
)

data class MarketingScope(
    val role: String,
    val branchId: Long?,
) {
    val isAdmin: Boolean get() = role.equals("admin", ignoreCase = true)

    fun effectiveBranch(requested: Long? = null): Long? = if (isAdmin) requested else branchId

    /** Global rows (null) are intentionally visible; branch rows must match for non-admins. */
    fun acceptsVisibleBranch(candidate: Long?): Boolean = isAdmin || candidate == null || candidate == branchId

    /** Writes by non-admin users always belong to their assigned branch. */
    fun acceptsWriteBranch(candidate: Long?): Boolean = isAdmin || (branchId != null && candidate == branchId)
}

data class MarketingCapabilities(
    val canReadCampaigns: Boolean,
    val canManageCampaigns: Boolean,
    val canReadCatalogQuality: Boolean,
    val canManageCatalogQuality: Boolean,
) {
    companion object {
        fun from(role: String, campaignsAccess: String?, catalogAnomaliesAccess: String?): MarketingCapabilities {
            val normalized = role.lowercase()
            val campaigns = campaignsAccess?.uppercase() ?: "NONE"
            val anomalies = catalogAnomaliesAccess?.uppercase() ?: "NONE"
            return MarketingCapabilities(
                canReadCampaigns = campaigns in setOf("READ", "FULL"),
                canManageCampaigns = campaigns == "FULL" && normalized in setOf("admin", "manager"),
                canReadCatalogQuality = anomalies in setOf("READ", "FULL") && normalized in setOf("admin", "manager", "accountant", "auditor"),
                canManageCatalogQuality = anomalies == "FULL" && normalized in setOf("admin", "manager"),
            )
        }
    }
}

object MarketingPolicy {
    private val transitions = mapOf(
        CouponProgramStatus.Draft to setOf(CouponProgramStatus.Active, CouponProgramStatus.Ended),
        CouponProgramStatus.Active to setOf(CouponProgramStatus.Paused, CouponProgramStatus.Ended),
        CouponProgramStatus.Paused to setOf(CouponProgramStatus.Active, CouponProgramStatus.Ended),
        CouponProgramStatus.Ended to emptySet(),
        CouponProgramStatus.Unknown to emptySet(),
    )

    fun allowedProgramTransitions(status: CouponProgramStatus): Set<CouponProgramStatus> = transitions.getValue(status)

    fun canManageProgram(program: CouponProgram, scope: MarketingScope, capabilities: MarketingCapabilities): Boolean =
        capabilities.canManageCampaigns && scope.acceptsWriteBranch(program.branchId)
}

object MarketingValidation {
    private val ymd = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")
    private val color = Regex("^#[0-9a-fA-F]{6}$")

    fun promotion(draft: PromotionDraft, editing: Boolean = false): String? {
        if (draft.name.trim().isEmpty()) return "اسم العرض مطلوب"
        if (draft.name.trim().length > 255 || draft.description.trim().length > 2000) return "نص العرض أطول من الحد المسموح"
        if (!ymd.matches(draft.effectiveFrom)) return "تاريخ بداية العرض غير صالح"
        if (draft.effectiveTo != null && (!ymd.matches(draft.effectiveTo) || draft.effectiveTo < draft.effectiveFrom)) return "تاريخ نهاية العرض غير صالح"
        if (!money.matches(draft.discountValue)) return "قيمة الخصم غير صالحة"
        val discount = draft.discountValue.toBigDecimalOrNull() ?: return "قيمة الخصم غير صالحة"
        if (discount.signum() <= 0 || (draft.type == PromotionType.Percent && discount > 100.toBigDecimal())) return "قيمة الخصم خارج النطاق"
        if (!money.matches(draft.minLineAmount)) return "الحد الأدنى للسطر غير صالح"
        if (!editing && draft.scope != PromotionScope.All && draft.targets.isEmpty()) return "أضف هدفًا واحدًا على الأقل"
        if (draft.type == PromotionType.Unknown || draft.scope == PromotionScope.Unknown) return "نوع العرض أو نطاقه غير صالح"
        return null
    }

    fun couponProgram(draft: CouponProgramDraft): String? {
        if (draft.promotionId <= 0 || draft.name.trim().length !in 2..255) return "بيانات برنامج الكوبون غير مكتملة"
        if (!ymd.matches(draft.validFrom) || (draft.validTo != null && (!ymd.matches(draft.validTo) || draft.validTo < draft.validFrom))) return "مدة البرنامج غير صالحة"
        if (draft.perCouponLimit !in 1..1000 || draft.perCustomerLimit !in 1..1000) return "حدود الاستخدام غير صالحة"
        if (draft.codePrefix.trim().length !in 1..12) return "بادئة الكوبون غير صالحة"
        if (!color.matches(draft.color)) return "لون التصميم غير صالح"
        if (draft.title.length > 80 || draft.subtitle.length > 140 || draft.terms.length > 500) return "نص تصميم الكوبون أطول من الحد المسموح"
        return null
    }

    fun optionalDate(value: String?): Boolean = value == null || ymd.matches(value)

    fun couponPreview(request: CouponPreviewRequest): String? {
        if (request.code.trim().length !in 3..64 || request.branchId <= 0) return "بيانات معاينة الكوبون غير مكتملة"
        if (request.lines.isEmpty() || request.lines.size > 200) return "أضف صنفًا واحدًا على الأقل للمعاينة"
        val invalid = request.lines.any { line ->
            line.productId <= 0 || line.variantId <= 0 || line.productUnitId <= 0 ||
                line.quantity !in 1..100_000 || !money.matches(line.unitPrice)
        }
        return if (invalid) "أحد أسطر المعاينة غير صالح" else null
    }
}
