package online.alarabiya.superapp.feature.storeadmin

import online.alarabiya.superapp.model.storeadmin.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StoreAdminModelsTest {
    @Test fun `mutations stay disabled until the initial server load succeeds`() {
        assertFalse(StoreAdminState(initialized = false).canMutate(capabilitiesCanManage = true))
        assertFalse(StoreAdminState(initialized = true, loading = true).canMutate(capabilitiesCanManage = true))
        assertFalse(StoreAdminState(initialized = true, staleAfterMutation = true).canMutate(capabilitiesCanManage = true))
        assertFalse(StoreAdminState(initialized = true).canMutate(capabilitiesCanManage = false))
        assertTrue(StoreAdminState(initialized = true).canMutate(capabilitiesCanManage = true))
    }
    @Test fun `successful mutations commit locally close dialogs and require a fresh retry`() {
        val original = StoreBannerDraft(id = 4, title = "قديم")
        val state = StoreAdminState(
            initialized = true,
            settings = StoreSettingsDraft(isOpen = true),
            banners = listOf(original),
            editor = original,
            pendingDelete = original,
        )

        val settingsCommitted = state.commitSettings(StoreSettingsDraft(isOpen = false))
        assertFalse(settingsCommitted.settings.isOpen)
        assertFalse(settingsCommitted.initialized)
        assertTrue(settingsCommitted.staleAfterMutation)
        assertFalse(settingsCommitted.canMutate(capabilitiesCanManage = true))

        val updated = state.commitBanner(original.copy(title = "محدث"))
        assertEquals("محدث", updated.banners.single().title)
        assertNull(updated.editor)
        assertTrue(updated.staleAfterMutation)

        val created = state.copy(editor = StoreBannerDraft(title = "جديد")).commitBanner(StoreBannerDraft(title = "جديد"), 9)
        assertEquals(9L, created.banners.first().id)
        assertNull(created.editor)

        val deleted = state.commitBannerDeleted(original.id!!)
        assertTrue(deleted.banners.isEmpty())
        assertNull(deleted.pendingDelete)
        assertFalse(deleted.canMutate(capabilitiesCanManage = true))
    }
    @Test fun `manager needs full store grant to mutate`() {
        assertTrue(StoreAdminCapabilities.from("manager", "FULL").canManage)
        assertFalse(StoreAdminCapabilities.from("manager", "READ").canManage)
        assertFalse(StoreAdminCapabilities.from("cashier", "FULL").canRead)
    }
    @Test fun `banner mapper preserves server state`() {
        val mapped = StoreAdminMappers.banners(JSONArray().put(JSONObject().put("id", 4).put("title", "عرض").put("placement", "INLINE").put("isActive", false))).single()
        assertEquals(4L, mapped.id); assertEquals(BannerPlacement.INLINE, mapped.placement); assertFalse(mapped.active)
    }
    @Test fun `validation blocks external paths and reversed dates`() {
        assertNotNull(StoreAdminValidation.banner(StoreBannerDraft(title = "عرض", ctaUrl = "https://evil.test")))
        assertNotNull(StoreAdminValidation.banner(StoreBannerDraft(title = "عرض", effectiveFrom = "2026-08-10", effectiveTo = "2026-08-09")))
        assertNull(StoreAdminValidation.banner(StoreBannerDraft(title = "عرض", ctaUrl = "/store")))
    }
}
