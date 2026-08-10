package online.alarabiya.superapp.model.storeadmin

enum class StoreAdminSection { SETTINGS, BANNERS }
enum class BannerPlacement { HERO, SIDE, INLINE }

data class StoreAdminCapabilities(val canRead: Boolean, val canManage: Boolean) {
    companion object {
        fun from(role: String, storeAccess: String?): StoreAdminCapabilities {
            val access = storeAccess?.uppercase() ?: "NONE"
            val elevated = role.lowercase() in setOf("admin", "manager")
            return StoreAdminCapabilities(canRead = elevated && access in setOf("READ", "FULL"), canManage = elevated && access == "FULL")
        }
    }
}

data class StoreSettingsDraft(
    val isOpen: Boolean = true,
    val announcement: String = "",
    val whatsappNumber: String = "",
    val freeShippingThreshold: String = "",
)

data class StoreBannerDraft(
    val id: Long? = null,
    val title: String = "",
    val subtitle: String = "",
    val ctaLabel: String = "",
    val ctaUrl: String = "",
    val sortOrder: String = "0",
    val active: Boolean = true,
    val effectiveFrom: String = "",
    val effectiveTo: String = "",
    val placement: BannerPlacement = BannerPlacement.HERO,
)

object StoreAdminValidation {
    private val date = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val money = Regex("^\\d+(\\.\\d{1,2})?$")
    fun settings(value: StoreSettingsDraft): String? {
        if (value.announcement.length > 500) return "الإعلان يتجاوز 500 حرف"
        if (value.whatsappNumber.length > 20) return "رقم واتساب طويل جداً"
        if (value.freeShippingThreshold.isNotBlank() && !money.matches(value.freeShippingThreshold)) return "حد التوصيل المجاني غير صالح"
        return null
    }
    fun banner(value: StoreBannerDraft): String? {
        if (value.title.trim().isEmpty()) return "عنوان البنر مطلوب"
        if (value.title.length > 255 || value.subtitle.length > 500) return "نص البنر يتجاوز الحد المسموح"
        if (value.sortOrder.toIntOrNull() !in 0..9999) return "ترتيب البنر غير صالح"
        if (value.effectiveFrom.isNotBlank() && !date.matches(value.effectiveFrom)) return "تاريخ البداية غير صالح"
        if (value.effectiveTo.isNotBlank() && !date.matches(value.effectiveTo)) return "تاريخ النهاية غير صالح"
        if (value.effectiveFrom.isNotBlank() && value.effectiveTo.isNotBlank() && value.effectiveFrom > value.effectiveTo) return "تاريخ النهاية يسبق البداية"
        if (value.ctaUrl.isNotBlank() && !value.ctaUrl.startsWith("/")) return "رابط الإجراء يجب أن يكون مساراً داخلياً"
        return null
    }
}
