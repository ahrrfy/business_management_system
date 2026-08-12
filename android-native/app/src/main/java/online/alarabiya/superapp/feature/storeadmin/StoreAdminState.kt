package online.alarabiya.superapp.feature.storeadmin

import online.alarabiya.superapp.model.storeadmin.StoreAdminSection
import online.alarabiya.superapp.model.storeadmin.StoreBannerDraft
import online.alarabiya.superapp.model.storeadmin.StoreSettingsDraft

data class StoreAdminState(
    val section: StoreAdminSection = StoreAdminSection.SETTINGS,
    val loading: Boolean = false,
    /** True only after both settings and banners were loaded from the server successfully. */
    val initialized: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val settings: StoreSettingsDraft = StoreSettingsDraft(),
    val banners: List<StoreBannerDraft> = emptyList(),
    val editor: StoreBannerDraft? = null,
    val pendingDelete: StoreBannerDraft? = null,
    val staleAfterMutation: Boolean = false,
)

internal fun StoreAdminState.canMutate(capabilitiesCanManage: Boolean): Boolean =
    capabilitiesCanManage && initialized && !staleAfterMutation && !loading

internal const val STORE_ADMIN_REFRESH_REQUIRED =
    "تمت العملية وتعذر تحديث العرض. أعد المحاولة قبل تنفيذ عملية أخرى"

internal fun StoreAdminState.commitSettings(value: StoreSettingsDraft): StoreAdminState = copy(
    settings = value,
    initialized = false,
    staleAfterMutation = true,
)

internal fun StoreAdminState.commitBanner(value: StoreBannerDraft, createdId: Long? = null): StoreAdminState {
    val committed = if (value.id == null) value.copy(id = createdId) else value
    return copy(
        banners = if (value.id == null) {
            (listOf(committed) + banners).distinctBy { it.id ?: it.title }
        } else {
            banners.map { if (it.id == value.id) committed else it }
        },
        editor = null,
        initialized = false,
        staleAfterMutation = true,
    )
}

internal fun StoreAdminState.commitBannerDeleted(id: Long): StoreAdminState = copy(
    banners = banners.filterNot { it.id == id },
    pendingDelete = null,
    initialized = false,
    staleAfterMutation = true,
)
