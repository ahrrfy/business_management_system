package online.alarabiya.superapp.feature.admin

import online.alarabiya.superapp.model.admin.AdminOverview
import online.alarabiya.superapp.model.admin.AdminUserSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminStateTest {
    @Test
    fun `initial failure never opens an empty interactive workspace`() {
        val initial = AdminUiState()
        val loading = initial.copy(loading = true)
        val failed = loading.failed("تعذر الاتصال")

        assertFalse(canOpenAdminWorkspace(initial, policyCanOpen = true))
        assertFalse(canOpenAdminWorkspace(loading, policyCanOpen = true))
        assertFalse(canOpenAdminWorkspace(failed, policyCanOpen = true))
        assertFalse(failed.overviewLoaded)
    }

    @Test
    fun `successful overview load is the only workspace unlock`() {
        val loaded = AdminUiState().overviewLoaded(overview())

        assertTrue(loaded.overviewLoaded)
        assertTrue(canOpenAdminWorkspace(loaded, policyCanOpen = true))
        assertFalse(canOpenAdminWorkspace(loaded, policyCanOpen = false))
        assertTrue(canOpenAdminWorkspace(loaded.failed("تعذر التحديث"), policyCanOpen = true))
    }

    @Test
    fun `refresh and mutation invalidate overview until an authoritative load succeeds`() {
        val loaded = AdminUiState().overviewLoaded(overview())
        val refreshing = loaded.overviewLoadStarted()
        val mutating = loaded.mutationStarted("user:4")
        val committed = mutating.mutationCommitted("تم تحديث الحساب")
        val refreshFailed = committed.mutationRefreshFailed("تم التنفيذ لكن تعذر التحديث")

        assertFalse(refreshing.overviewLoaded)
        assertFalse(mutating.overviewLoaded)
        assertFalse(committed.overviewLoaded)
        assertFalse(refreshFailed.overviewLoaded)
        assertEquals("تم تحديث الحساب", refreshFailed.notice)
        assertTrue(refreshFailed.overviewLoaded(overview()).overviewLoaded)
    }

    @Test
    fun `incident mutation never exposes old session actions after refresh failure`() {
        val session = AdminUserSession(7, "هاتف المدير", null, "2026-08-10", "2026-08-10", "2026-09-10")
        val loaded = AdminUiState().incidentLoaded(4, listOf(session))
        val mutating = loaded.incidentMutationStarted("session:7")
        val committed = mutating.copy(incidentSessions = emptyList(), notice = "تم إنهاء الجلسة")
        val refreshFailed = committed.incidentRefreshFailed("تم التنفيذ لكن تعذر تحديث الجلسات")

        assertTrue(loaded.incidentFresh)
        assertFalse(mutating.incidentFresh)
        assertFalse(refreshFailed.incidentFresh)
        assertEquals("تم إنهاء الجلسة", refreshFailed.notice)
        assertTrue(refreshFailed.incidentLoaded(4, emptyList()).incidentFresh)
    }

    private fun overview() = AdminOverview(
        users = emptyList(),
        totalUsers = 0,
        activeAdminCount = 0,
        activeOwnerCount = 0,
        roles = emptyList(),
        branches = emptyList(),
    )
}
