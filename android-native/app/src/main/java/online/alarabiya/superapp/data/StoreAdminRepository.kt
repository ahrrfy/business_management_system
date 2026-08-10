package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.storeadmin.StoreAdminMappers
import online.alarabiya.superapp.model.storeadmin.StoreAdminValidation
import online.alarabiya.superapp.model.storeadmin.StoreBannerDraft
import online.alarabiya.superapp.model.storeadmin.StoreSettingsDraft
import org.json.JSONObject

interface StoreAdminDataSource {
    suspend fun settings(): StoreSettingsDraft
    suspend fun saveSettings(value: StoreSettingsDraft): StoreSettingsDraft
    suspend fun banners(): List<StoreBannerDraft>
    suspend fun createBanner(value: StoreBannerDraft): Long
    suspend fun updateBanner(value: StoreBannerDraft)
    suspend fun removeBanner(id: Long)
}

class StoreAdminRepository(private val api: TrpcClient) : StoreAdminDataSource {
    override suspend fun settings() = StoreAdminMappers.settings(api.query("storeAdmin.settings.get"))
    override suspend fun saveSettings(value: StoreSettingsDraft): StoreSettingsDraft {
        StoreAdminValidation.settings(value)?.let { throw IllegalArgumentException(it) }
        return StoreAdminMappers.settings(api.mutate("storeAdmin.settings.update", value.wire()))
    }
    override suspend fun banners() = StoreAdminMappers.banners(api.queryArray("storeAdmin.banners.list"))
    override suspend fun createBanner(value: StoreBannerDraft): Long {
        StoreAdminValidation.banner(value)?.let { throw IllegalArgumentException(it) }
        return api.mutate("storeAdmin.banners.create", value.wire()).optLong("id")
    }
    override suspend fun updateBanner(value: StoreBannerDraft) {
        val id = requireNotNull(value.id)
        StoreAdminValidation.banner(value)?.let { throw IllegalArgumentException(it) }
        api.mutate("storeAdmin.banners.update", value.wire().put("id", id))
    }
    override suspend fun removeBanner(id: Long) { api.mutate("storeAdmin.banners.remove", JSONObject().put("id", id)) }
}

private fun StoreSettingsDraft.wire() = JSONObject().put("isOpen", isOpen)
    .putNullable("announcement", announcement.trim().takeIf(String::isNotEmpty))
    .putNullable("whatsappNumber", whatsappNumber.trim().takeIf(String::isNotEmpty))
    .putNullable("freeShippingThreshold", freeShippingThreshold.trim().takeIf(String::isNotEmpty))

private fun StoreBannerDraft.wire() = JSONObject().put("title", title.trim())
    .putNullable("subtitle", subtitle.trim().takeIf(String::isNotEmpty)).putNullable("ctaLabel", ctaLabel.trim().takeIf(String::isNotEmpty))
    .putNullable("ctaUrl", ctaUrl.trim().takeIf(String::isNotEmpty)).put("sortOrder", sortOrder.toInt())
    .put("isActive", active).putNullable("effectiveFrom", effectiveFrom.takeIf(String::isNotEmpty))
    .putNullable("effectiveTo", effectiveTo.takeIf(String::isNotEmpty)).put("placement", placement.name)

private fun JSONObject.putNullable(key: String, value: Any?) = put(key, value ?: JSONObject.NULL)
