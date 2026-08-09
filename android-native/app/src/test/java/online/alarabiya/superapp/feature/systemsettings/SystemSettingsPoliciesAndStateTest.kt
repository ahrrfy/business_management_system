package online.alarabiya.superapp.feature.systemsettings

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.systemsettings.BranchDraft
import online.alarabiya.superapp.model.systemsettings.OpeningMode
import online.alarabiya.superapp.model.systemsettings.SystemSettingsCapabilities
import online.alarabiya.superapp.model.systemsettings.TaxSettings
import online.alarabiya.superapp.model.systemsettings.OneTimeKioskToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class SystemSettingsPoliciesAndStateTest {
    @Test
    fun sectionsAndWritesFollowServerRoleProcedures() {
        val admin = capabilities("admin")
        val manager = capabilities("manager")
        val employee = capabilities("employee")

        assertTrue(admin.canManageBranches)
        assertTrue(admin.canManageIntegrations)
        assertTrue(admin.canUpdateWhatsAppHub)
        assertTrue(admin.canReadBackups)
        assertTrue(admin.canCreateBackup)
        assertTrue(admin.canManageKioskDevices)
        assertTrue(SystemSettingsSection.KioskDevices in admin.readableSections())
        assertEquals(SystemSettingsSection.Overview, admin.readableSections().first())

        assertFalse(manager.canReadIntegrations)
        assertFalse(manager.canReadBackups)
        assertFalse(manager.canCreateBackup)
        assertFalse(manager.canManageKioskDevices)
        assertTrue(manager.canReadTemplates)
        assertTrue(manager.canReadWhatsAppHub)
        assertEquals(listOf(SystemSettingsSection.WhatsApp, SystemSettingsSection.Governance), manager.readableSections())

        assertFalse(employee.canReadWhatsAppHub)
        assertTrue(employee.canReadGovernance)
        assertEquals(listOf(SystemSettingsSection.Governance), employee.readableSections())
    }

    @Test
    fun backupCreationRequiresAuthorizedSuccessfulCatalogLoadAndNoActiveOperation() {
        val admin = capabilities("admin")
        val selected = SystemSettingsUiState(section = SystemSettingsSection.Backups)
        assertFalse(canMutateLoadedSystemSection(selected))
        assertFalse(canCreateOperationalBackup(selected, admin))

        val loading = SystemSettingsReducer.loading(selected)
        assertFalse(canCreateOperationalBackup(loading, admin))

        val failed = SystemSettingsReducer.failed(loading, "تعذر التحميل")
        assertFalse(canCreateOperationalBackup(failed, admin))

        val loaded = SystemSettingsReducer.loaded(SystemSettingsReducer.loading(selected))
        assertTrue(loaded.backupCatalogReady)
        assertTrue(canMutateLoadedSystemSection(loaded))
        assertTrue(canCreateOperationalBackup(loaded, admin))
        assertFalse(canCreateOperationalBackup(loaded.copy(busyKey = "backup:create"), admin))
        assertFalse(canCreateOperationalBackup(loaded, capabilities("manager")))
    }

    @Test
    fun kioskWritesRequireSuccessfulSectionLoad() {
        val selected = SystemSettingsUiState(section = SystemSettingsSection.KioskDevices)
        assertFalse(canMutateLoadedSystemSection(selected))
        val loaded = SystemSettingsReducer.loaded(SystemSettingsReducer.loading(selected))
        assertTrue(canMutateLoadedSystemSection(loaded))
        assertFalse(canMutateLoadedSystemSection(loaded.copy(busyKey = "kiosk:create")))
    }

    @Test
    fun refreshAndFailureInvalidateSectionFreshnessAndBlockBranchWrites() {
        val selected = SystemSettingsUiState(section = SystemSettingsSection.Branches)
        val loaded = SystemSettingsReducer.loaded(SystemSettingsReducer.loading(selected))
        assertTrue(canMutateLoadedSystemSection(loaded))
        assertFalse(requiresSystemSectionLoadGate(loaded))

        val refreshing = SystemSettingsReducer.loading(loaded)
        assertFalse(canMutateLoadedSystemSection(refreshing))
        assertTrue(requiresSystemSectionLoadGate(refreshing))

        val failed = SystemSettingsReducer.failed(refreshing, "تعذر التحميل")
        assertFalse(canMutateLoadedSystemSection(failed))
        assertTrue(requiresSystemSectionLoadGate(failed))
        assertEquals("تعذر التحميل", failed.error)
    }

    @Test
    fun committedMutationStaysStaleUntilRefetchSucceeds() {
        val selected = SystemSettingsUiState(section = SystemSettingsSection.Governance)
        val loaded = SystemSettingsReducer.loaded(SystemSettingsReducer.loading(selected))

        val committed = SystemSettingsReducer.committed(loaded, "تم الحفظ")
        assertEquals("تم الحفظ", committed.message)
        assertTrue(committed.loading)
        assertTrue(requiresSystemSectionLoadGate(committed))
        assertFalse(canMutateLoadedSystemSection(committed))

        val refreshFailed = SystemSettingsReducer.refreshAfterCommitFailed(committed, "انقطع الاتصال")
        assertTrue(requireNotNull(refreshFailed.error).contains("تم تنفيذ الإجراء"))
        assertEquals("تم الحفظ", refreshFailed.message)
        assertTrue(requiresSystemSectionLoadGate(refreshFailed))

        val reloaded = SystemSettingsReducer.loaded(SystemSettingsReducer.loading(refreshFailed))
        assertFalse(requiresSystemSectionLoadGate(reloaded))
        assertTrue(canMutateLoadedSystemSection(reloaded))
    }

    @Test
    fun oneTimeKioskTokenIsErasedOnAcknowledgement() {
        val secret = OneTimeKioskToken(8, "kde_secret_once", "kde_secret")
        val acknowledged = SystemSettingsReducer.acknowledgedKioskToken(
            SystemSettingsUiState(oneTimeKioskToken = secret, message = "احفظ الرمز"),
        )
        assertNull(acknowledged.oneTimeKioskToken)
        assertNull(acknowledged.message)
        assertFalse(acknowledged.toString().contains("kde_secret_once"))
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

    @Test
    fun backupTimestampUsesOperationalTimeZoneInsteadOfRawUtcText() {
        val formatted = requireNotNull(
            backupDisplayTime("2026-08-09T18:45:00Z", ZoneId.of("Asia/Baghdad")),
        )
        assertTrue(formatted.contains("21:45"))
        assertNull(backupDisplayTime("invalid"))
    }

    private fun capabilities(role: String): SystemSettingsCapabilities =
        SystemSettingsCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(id = 1, name = "مستخدم", username = "user", email = null, role = role),
                modules = emptyList(), branchId = 1, allBranches = role == "admin",
            ),
        )
}
