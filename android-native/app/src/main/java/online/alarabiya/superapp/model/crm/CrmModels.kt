package online.alarabiya.superapp.model.crm

import online.alarabiya.superapp.model.AppBootstrap

enum class CrmSection {
    Customers,
    FollowUps,
    Quotations,
    Campaigns,
}

enum class CrmAccess {
    NONE,
    READ,
    FULL,
    ;

    val canRead: Boolean get() = this != NONE
    val canWrite: Boolean get() = this == FULL

    companion object {
        fun fromWire(value: String?): CrmAccess = entries.firstOrNull { it.name == value } ?: NONE
    }
}

data class CrmCapabilities(
    val customers: CrmAccess,
    val sales: CrmAccess,
    val campaigns: CrmAccess,
    val products: CrmAccess,
    val branchId: Long?,
    val allBranches: Boolean,
) {
    val visibleSections: List<CrmSection>
        get() = buildList {
            if (customers.canRead) add(CrmSection.Customers)
            if (customers.canWrite) add(CrmSection.FollowUps)
            if (sales.canRead) add(CrmSection.Quotations)
            if (campaigns.canRead) add(CrmSection.Campaigns)
        }

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): CrmCapabilities {
            val access = bootstrap.modules.associate { it.key to CrmAccess.fromWire(it.access) }
            return CrmCapabilities(
                customers = access["crm"] ?: access["customers"] ?: CrmAccess.NONE,
                sales = access["sales"] ?: CrmAccess.NONE,
                campaigns = access["campaigns"] ?: CrmAccess.NONE,
                products = access["products"] ?: CrmAccess.NONE,
                branchId = bootstrap.branchId,
                allBranches = bootstrap.allBranches,
            )
        }
    }
}

enum class CustomerType(val wire: String) {
    Individual("فرد"),
    Trader("تاجر"),
    Institution("مؤسسة"),
    Company("شركة"),
    Government("حكومي"),
    ;

    companion object {
        fun fromWire(value: String?): CustomerType = entries.firstOrNull { it.wire == value } ?: Individual
    }
}

enum class PriceTier {
    RETAIL,
    WHOLESALE,
    GOVERNMENT,
}

data class CustomerSummary(
    val id: Long,
    val name: String,
    val phone: String?,
    val whatsapp: String?,
    val city: String?,
    val district: String?,
    val customerType: CustomerType,
    val priceTier: PriceTier,
    val creditLimit: String?,
    val currentBalance: String?,
    val legacyCode: String?,
    val isActive: Boolean,
)

data class CustomerPage(
    val rows: List<CustomerSummary>,
    val total: Int,
)

data class CustomerDetail(
    val id: Long,
    val name: String,
    val phone: String?,
    val phone2: String?,
    val phone3: String?,
    val whatsapp: String?,
    val address: String?,
    val city: String?,
    val district: String?,
    val customerType: CustomerType,
    val priceTier: PriceTier,
    val creditLimit: String?,
    val currentBalance: String?,
    val openingBalance: String?,
    val notes: String?,
    val waConsent: String?,
    val isActive: Boolean,
)

data class CustomerFollowUp(
    val id: Long,
    val customerId: Long,
    val customerName: String?,
    val customerPhone: String?,
    val note: String,
    val followUpDate: String?,
    val isResolved: Boolean,
    val createdByName: String?,
    val branchId: Long?,
    val createdAt: String?,
)

data class CustomerFollowUpPage(
    val rows: List<CustomerFollowUp>,
    val total: Int,
)

data class CustomerFollowUpDraft(
    val noteId: Long? = null,
    val note: String = "",
    val followUpDate: String = "",
)

data class CustomerContractPrice(
    val id: Long,
    val customerId: Long,
    val productUnitId: Long,
    val price: String,
    val isActive: Boolean,
    val note: String?,
    val updatedAt: String?,
    val productId: Long,
    val productName: String,
    val variantName: String?,
    val color: String?,
    val size: String?,
    val sku: String,
    val unitName: String,
) {
    val productLabel: String
        get() = listOfNotNull(productName, variantName, color, size, unitName)
            .filter(String::isNotBlank)
            .joinToString(" · ")
}

data class CustomerContractPricePage(
    val rows: List<CustomerContractPrice>,
    val total: Int,
    val hasMore: Boolean,
    val nextCursor: String?,
)

data class CustomerContractPriceMutation(
    val id: Long,
    val updated: Boolean,
)

data class CustomerContractPriceDraft(
    val priceId: Long? = null,
    val productUnitId: Long? = null,
    val productLabel: String = "",
    val price: String = "",
    val note: String = "",
)

data class CustomerDraft(
    val name: String = "",
    val phone: String = "",
    val whatsapp: String = "",
    val address: String = "",
    val city: String = "",
    val district: String = "",
    val customerType: CustomerType = CustomerType.Individual,
    val priceTier: PriceTier = PriceTier.RETAIL,
    val notes: String = "",
    val clientRequestId: String = "",
) {
    companion object {
        fun from(detail: CustomerDetail): CustomerDraft = CustomerDraft(
            name = detail.name,
            phone = detail.phone.orEmpty(),
            whatsapp = detail.whatsapp.orEmpty(),
            address = detail.address.orEmpty(),
            city = detail.city.orEmpty(),
            district = detail.district.orEmpty(),
            customerType = detail.customerType,
            priceTier = detail.priceTier,
            notes = detail.notes.orEmpty(),
        )
    }
}

enum class QuotationStatus {
    DRAFT,
    SENT,
    ACCEPTED,
    REJECTED,
    CONVERTED,
    EXPIRED,
    ;

    companion object {
        fun fromWire(value: String?): QuotationStatus = entries.firstOrNull { it.name == value } ?: DRAFT
    }
}

data class QuotationSummary(
    val id: Long,
    val quoteNumber: String,
    val quoteDate: String?,
    val validUntil: String?,
    val total: String,
    val status: QuotationStatus,
    val convertedInvoiceId: Long?,
    val customerId: Long?,
    val customerName: String?,
    val customerPhone: String?,
)

data class QuotationPage(
    val rows: List<QuotationSummary>,
    val hasMore: Boolean,
    val nextCursor: Long?,
)

data class QuotationLine(
    val id: Long,
    val variantId: Long,
    val productUnitId: Long,
    val productName: String,
    val variantName: String?,
    val unitName: String?,
    val sku: String?,
    val quantity: String,
    val unitPrice: String,
    val discountAmount: String,
    val total: String,
)

data class QuotationDetail(
    val id: Long,
    val quoteNumber: String,
    val branchId: Long,
    val customerId: Long?,
    val customerName: String?,
    val customerPhone: String?,
    val priceTier: PriceTier,
    val quoteDate: String?,
    val validUntil: String?,
    val subtotal: String,
    val taxAmount: String,
    val taxRatePercent: String,
    val discountAmount: String,
    val total: String,
    val status: QuotationStatus,
    val convertedInvoiceId: Long?,
    val notes: String?,
    val items: List<QuotationLine>,
) {
    val canEdit: Boolean get() = status == QuotationStatus.DRAFT
}

data class QuotationLineDraft(
    val variantId: Long,
    val productUnitId: Long,
    val label: String,
    val quantity: String = "1",
    val unitPriceOverride: String = "",
    val discountPercent: String = "",
    val discountAmount: String = "",
)

data class QuotationDraft(
    val branchId: Long? = null,
    val customerId: Long? = null,
    val priceTier: PriceTier = PriceTier.RETAIL,
    val validUntil: String = "",
    val invoiceDiscount: String = "",
    val taxRatePercent: String = "",
    val notes: String = "",
    val lines: List<QuotationLineDraft> = emptyList(),
    val clientRequestId: String = "",
) {
    companion object {
        fun from(detail: QuotationDetail): QuotationDraft = QuotationDraft(
            branchId = detail.branchId,
            customerId = detail.customerId,
            priceTier = detail.priceTier,
            validUntil = detail.validUntil.orEmpty(),
            invoiceDiscount = detail.discountAmount,
            taxRatePercent = detail.taxRatePercent,
            notes = detail.notes.orEmpty(),
            lines = detail.items.map { item ->
                QuotationLineDraft(
                    variantId = item.variantId,
                    productUnitId = item.productUnitId,
                    label = listOfNotNull(item.productName, item.variantName, item.unitName).joinToString(" · "),
                    quantity = item.quantity,
                    unitPriceOverride = item.unitPrice,
                    discountAmount = item.discountAmount,
                )
            },
        )
    }
}

data class CatalogOption(
    val productId: Long,
    val productName: String,
    val variantId: Long,
    val variantName: String?,
    val productUnitId: Long,
    val unitName: String,
    val sku: String,
    val price: String?,
    val promotionEffectivePrice: String?,
    val availableBase: Int,
    val isService: Boolean,
) {
    val effectivePrice: String? get() = promotionEffectivePrice ?: price
    val label: String get() = listOfNotNull(productName, variantName, unitName).joinToString(" · ")
}

data class BranchOption(val id: Long, val name: String, val code: String?)

data class CrmDashboard(
    val campaignsTotal: Int,
    val campaignsActive: Int,
    val programsTotal: Int,
    val programsActive: Int,
    val redemptionsTotal: Int,
    val redemptionDiscount: String,
)

enum class CampaignStatus {
    DRAFT,
    REVIEW,
    APPROVED,
    SCHEDULED,
    ACTIVE,
    PAUSED,
    ENDED,
    ;

    companion object {
        fun fromWire(value: String?): CampaignStatus = entries.firstOrNull { it.name == value } ?: DRAFT
    }
}

data class CampaignSummary(
    val id: Long,
    val name: String,
    val objective: String?,
    val branchId: Long?,
    val startsOn: String?,
    val endsOn: String?,
    val status: CampaignStatus,
) {
    fun allowedTransitions(): List<CampaignStatus> = when (status) {
        CampaignStatus.DRAFT -> listOf(CampaignStatus.REVIEW, CampaignStatus.ENDED)
        CampaignStatus.REVIEW -> listOf(CampaignStatus.DRAFT, CampaignStatus.APPROVED, CampaignStatus.ENDED)
        CampaignStatus.APPROVED -> listOf(CampaignStatus.SCHEDULED, CampaignStatus.ACTIVE, CampaignStatus.ENDED)
        CampaignStatus.SCHEDULED -> listOf(CampaignStatus.ACTIVE, CampaignStatus.PAUSED, CampaignStatus.ENDED)
        CampaignStatus.ACTIVE -> listOf(CampaignStatus.PAUSED, CampaignStatus.ENDED)
        CampaignStatus.PAUSED -> listOf(CampaignStatus.ACTIVE, CampaignStatus.ENDED)
        CampaignStatus.ENDED -> emptyList()
    }
}

data class CampaignDraft(
    val name: String = "",
    val objective: String = "",
    val branchId: Long? = null,
    val startsOn: String = "",
    val endsOn: String = "",
)

object CrmValidation {
    private val date = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val decimal = Regex("^\\d+(\\.\\d{1,3})?$")
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")

    fun customer(draft: CustomerDraft): String? {
        if (draft.name.trim().isEmpty()) return "اسم العميل مطلوب"
        if (draft.name.trim().length > 255) return "اسم العميل أطول من الحد المسموح"
        listOf(draft.phone, draft.whatsapp).filter(String::isNotBlank).forEach {
            if (it.length > 20) return "رقم الهاتف أطول من الحد المسموح"
            if (WhatsappIntentSanitizer.normalizePhone(it) == null) return "رقم الهاتف غير صالح"
        }
        if (draft.city.length > 100 || draft.district.length > 100) return "المدينة أو المنطقة أطول من الحد المسموح"
        return null
    }

    fun quotation(draft: QuotationDraft): String? {
        if (draft.branchId == null || draft.branchId <= 0) return "اختر الفرع"
        if (draft.validUntil.isNotBlank() && !date.matches(draft.validUntil)) return "تاريخ الصلاحية يجب أن يكون YYYY-MM-DD"
        if (draft.lines.isEmpty()) return "أضف صنفاً واحداً على الأقل"
        draft.lines.forEach { line ->
            if (!decimal.matches(line.quantity) || line.quantity.toDoubleOrNull()?.let { it <= 0 } != false) return "كمية أحد الأصناف غير صالحة"
            listOf(line.unitPriceOverride, line.discountAmount)
                .filter(String::isNotBlank)
                .forEach { if (!money.matches(it)) return "قيمة سعر أو خصم غير صالحة" }
            if (line.discountPercent.isNotBlank() &&
                (!money.matches(line.discountPercent) || line.discountPercent.toDoubleOrNull()?.let { it > 100 } != false)
            ) return "نسبة خصم أحد الأصناف غير صالحة"
        }
        if (draft.invoiceDiscount.isNotBlank() && !money.matches(draft.invoiceDiscount)) return "قيمة خصم العرض غير صالحة"
        if (draft.taxRatePercent.isNotBlank() &&
            (!money.matches(draft.taxRatePercent) || draft.taxRatePercent.toDoubleOrNull()?.let { it > 100 } != false)
        ) return "نسبة الضريبة غير صالحة"
        return null
    }

    fun campaign(draft: CampaignDraft): String? {
        if (draft.name.trim().length !in 2..255) return "اسم الحملة يجب أن يكون بين حرفين و255 حرفاً"
        if (draft.objective.length > 4000) return "هدف الحملة أطول من الحد المسموح"
        if (draft.startsOn.isNotBlank() && !date.matches(draft.startsOn)) return "تاريخ بداية الحملة غير صالح"
        if (draft.endsOn.isNotBlank() && !date.matches(draft.endsOn)) return "تاريخ نهاية الحملة غير صالح"
        if (draft.startsOn.isNotBlank() && draft.endsOn.isNotBlank() && draft.endsOn < draft.startsOn) {
            return "تاريخ نهاية الحملة يسبق بدايتها"
        }
        return null
    }

    fun followUp(draft: CustomerFollowUpDraft): String? {
        if (draft.note.trim().isEmpty()) return "نص المتابعة مطلوب"
        if (draft.note.trim().length > 2000) return "نص المتابعة أطول من الحد المسموح"
        if (draft.followUpDate.isNotBlank() && !date.matches(draft.followUpDate)) {
            return "تاريخ المتابعة يجب أن يكون YYYY-MM-DD"
        }
        return null
    }

    fun contractPrice(draft: CustomerContractPriceDraft): String? {
        if (draft.productUnitId == null || draft.productUnitId <= 0) return "اختر الصنف والوحدة"
        if (!money.matches(draft.price) || draft.price.toBigDecimalOrNull()?.signum() != 1) {
            return "السعر التعاقدي يجب أن يكون أكبر من صفر وبدقة منزلتين"
        }
        if (draft.note.length > 255) return "ملاحظة العقد أطول من الحد المسموح"
        return null
    }
}

data class WhatsappLaunchTarget(val uri: String, val normalizedPhone: String)

object WhatsappIntentSanitizer {
    fun normalizePhone(raw: String?): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        if (!Regex("^[+0-9\\s().-]+$").matches(value)) return null
        var digits = value.filter(Char::isDigit)
        digits = when {
            digits.startsWith("00964") -> digits.drop(2)
            digits.startsWith("0") && digits.length == 11 -> "964${digits.drop(1)}"
            digits.startsWith("7") && digits.length == 10 -> "964$digits"
            else -> digits
        }
        return digits.takeIf { it.length in 8..15 && it.first() != '0' }
    }

    fun buildTarget(rawPhone: String?, message: String): WhatsappLaunchTarget? {
        val phone = normalizePhone(rawPhone) ?: return null
        val safeMessage = java.net.URLEncoder.encode(message.take(1000), Charsets.UTF_8.name())
            .replace("+", "%20")
        return WhatsappLaunchTarget(
            uri = "https://wa.me/$phone?text=$safeMessage",
            normalizedPhone = phone,
        )
    }
}

object NativeCrmContractGaps {
    const val CAMPAIGN_DETAIL_EDIT =
        "crm.campaigns exposes unfiltered list/create/transition only; there is no campaign search/get/update contract for native search or detail editing."
    const val QUOTATION_DOCUMENT_SHARE =
        "quotations exposes structured data but no server-generated PDF/share token; native sharing cannot claim an official quotation document."
    const val WHATSAPP_DELIVERY_STATE =
        "The requested external WhatsApp Intent cannot provide a trusted server-side sent/delivered receipt; the native UI only claims that WhatsApp was opened."
}
