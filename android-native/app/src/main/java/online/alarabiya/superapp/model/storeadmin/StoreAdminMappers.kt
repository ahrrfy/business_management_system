package online.alarabiya.superapp.model.storeadmin

import org.json.JSONArray
import org.json.JSONObject

object StoreAdminMappers {
    fun settings(root: JSONObject) = StoreSettingsDraft(
        isOpen = root.optBoolean("isOpen", true), announcement = root.optString("announcement"),
        whatsappNumber = root.optString("whatsappNumber"), freeShippingThreshold = root.optString("freeShippingThreshold"),
    )
    fun banners(root: JSONArray): List<StoreBannerDraft> = (0 until root.length()).mapNotNull { index ->
        root.optJSONObject(index)?.let { row -> StoreBannerDraft(
            id = row.optLong("id"), title = row.optString("title"), subtitle = row.optString("subtitle"),
            ctaLabel = row.optString("ctaLabel"), ctaUrl = row.optString("ctaUrl"), sortOrder = row.optInt("sortOrder").toString(),
            active = row.optBoolean("isActive", true), effectiveFrom = row.optString("effectiveFrom"), effectiveTo = row.optString("effectiveTo"),
            placement = BannerPlacement.entries.firstOrNull { it.name == row.optString("placement") } ?: BannerPlacement.HERO,
        ) }
    }
}
