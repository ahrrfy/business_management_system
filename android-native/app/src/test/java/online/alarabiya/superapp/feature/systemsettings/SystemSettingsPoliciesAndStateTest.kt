package online.alarabiya.superapp.feature.systemsettings

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.systemsettings.BranchDraft
import online.alarabiya.superapp.model.systemsettings.OpeningMode
import online.alarabiya.superapp.model.systemsettings.SystemSettingsCapabilities
import online.alarabiya.superapp.model.systemsettings.TaxSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class SystemSettingsPoliciesAndStateTest {
    @Test
    fun sectionsAndWritesFollowServerRoleProcedures() {
        val admin = capabilities("admin")
        val manager = capabilities("manager")
        val employee = capabilities("employee")

        assertTrue(admin.canManageBranches)
        assertTrue(admin.canManageIntegrations)
        assertTrue(admin.canUpdateWhatsAppHub)
        assertEquals(SystemSettingsSection.Overview, admin.readableSections().first())

        assertFalse(manager.canReadIntegrations)
        assertTrue(manager.canReadTemplates)
        assertTrue(manager.canReadWhatsAppHub)
        assertEquals(listOf(SystemSettingsSection.WhatsApp, SystemSettingsSection.Governance), manager.readableSections())

        assertFalse(employee.canReadWhatsAppHub)
        assertTrue(employee.canReadGovernance)
        assertEquals(listOf(SystemSettingsSection.Governance), employee.readableSections())
    }

    @Test
    fun reducerChoosesFirstAuthorizedSectionAndClearsTransientState() {
        val initial = SystemSettingsUiState(section = SystemSettingsSection.Overview, error = "قديم")
        val initialized = SystemSettingsReducer.initialized(initial, listOf(SystemSettingsSection.Governance))
        assertEquals(SystemSettingsSection.Governance, initialized.section)
        val selected = SystemSettingsReducer.selected(initialized, SystemSettingsSection.Governance)
        assertNull(selected.error)
        val loaded = SystemSettingsReducer.loaded(SystemSettingsReducer.loading(selected))
        assertFalse(loaded.loading)
        assertTrue(SystemSettingsSection.Governance in loaded.loaded)
    }

    @Test
    fun publicDraftsEnforceServerBounds() {
        assertNull(BranchDraft(name = "فرع", code = "BGD_01").validate())
        assertTrue(BranchDraft(name = "فرع", code = "عربي").validate()!!.contains("الإنجليزية"))
        assertNull(TaxSettings(true, "15", null, null).validate())
        assertTrue(TaxSettings(true, "101", null, null).validate()!!.contains("بين 0 و100"))
        val today = LocalDate.of(2026, 8, 6)
        assertNull(OpeningMode(true, "2026-08-20", 100, false, null).validateForUpdate(today))
        assertTrue(OpeningMode(true, null, 100, false, null).validateForUpdate(today)!!.contains("مطلوب"))
        assertTrue(OpeningMode(true, "2026-11-20", 100, false, null).validateForUpdate(today)!!.contains("60"))
    }

    private fun capabilities(role: String): SystemSettingsCapabilities =
        SystemSettingsCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(id = 1, name = "مستخدم", username = "user", email = null, role = role),
                modules = emptyList(), branchId = 1, allBranches = role == "admin",
            ),
        )
}
