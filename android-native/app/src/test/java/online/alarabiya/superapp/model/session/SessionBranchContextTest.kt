package online.alarabiya.superapp.model.session

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionBranchContextTest {
    @Test
    fun ownerAllBranchSessionNeverChoosesAnImplicitDefault() {
        val initial = SessionBranchContext.initial(bootstrap(userId = 11, role = "owner", owner = true))
        val loaded = initial.loading().loaded(
            listOf(SessionBranch(7, "الرئيسي"), SessionBranch(8, "المبيعات")),
        )

        assertTrue(loaded.principal.canSelectBranch)
        assertTrue(loaded.requiresExplicitSelection)
        assertNull(loaded.effectiveBranchId)
        assertEquals(BranchDirectoryStatus.READY, loaded.directoryStatus)
    }

    @Test
    fun selectionIsAcceptedOnlyFromTheLatestServerDirectory() {
        val ready = SessionBranchContext.initial(bootstrap()).loaded(
            listOf(SessionBranch(7, "الرئيسي"), SessionBranch(8, "المبيعات")),
        )

        val rejected = ready.select(99)
        assertNull(rejected.effectiveBranchId)
        assertTrue(rejected.error?.isNotBlank() == true)

        val selected = ready.select(8)
        assertEquals(8L, selected.effectiveBranchId)
        assertEquals("المبيعات", selected.selectedBranch?.name)

        val refreshed = selected.loaded(listOf(SessionBranch(7, "الرئيسي")))
        assertNull(refreshed.effectiveBranchId)
        assertTrue(refreshed.requiresExplicitSelection)
    }

    @Test
    fun accountOrAuthorityChangeClearsTheSessionSelection() {
        val selected = SessionBranchContext.initial(bootstrap(userId = 11))
            .loaded(listOf(SessionBranch(7, "الرئيسي")))
            .select(7)

        assertEquals(7L, selected.resetFor(bootstrap(userId = 11)).effectiveBranchId)

        val anotherUser = selected.resetFor(bootstrap(userId = 12))
        assertNull(anotherUser.effectiveBranchId)
        assertTrue(anotherUser.requiresExplicitSelection)

        val changedAuthority = selected.resetFor(
            bootstrap(userId = 11, modules = listOf(ModuleAccess("sales", "المبيعات", "READ"))),
        )
        assertNull(changedAuthority.effectiveBranchId)
    }

    @Test
    fun assignedBranchIsFixedAndCannotBeOverridden() {
        val context = SessionBranchContext.initial(
            bootstrap(role = "manager", allBranches = false, fixedBranchId = 4),
        )

        assertFalse(context.principal.canSelectBranch)
        assertFalse(context.requiresExplicitSelection)
        assertEquals(4L, context.effectiveBranchId)
        assertEquals(4L, context.select(7).effectiveBranchId)
        assertEquals(BranchDirectoryStatus.NOT_REQUIRED, context.directoryStatus)
    }

    private fun bootstrap(
        userId: Long = 11,
        role: String = "admin",
        owner: Boolean = false,
        allBranches: Boolean = true,
        fixedBranchId: Long? = null,
        modules: List<ModuleAccess> = listOf(ModuleAccess("sales", "المبيعات", "FULL")),
    ) = AppBootstrap(
        user = UserIdentity(
            id = userId,
            name = "اختبار",
            username = "qa$userId",
            email = null,
            role = role,
            isOwner = owner,
        ),
        modules = modules,
        branchId = fixedBranchId,
        allBranches = allBranches,
        isOwner = owner,
    )
}
