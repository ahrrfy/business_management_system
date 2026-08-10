package online.alarabiya.superapp.ui

import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.feature.executive.ExecutiveHomeState
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.UserIdentity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExecutiveRequestGateTest {
    @Test
    fun `new request supersedes an in-flight result for the same user and scope`() {
        val gate = ExecutiveRequestGate()
        val lifecycle = gate.invalidate()
        val bootstrap = bootstrap(userId = 7, branchId = 3)

        val stale = gate.begin(bootstrap, lifecycle)!!
        val current = gate.begin(bootstrap, lifecycle)!!

        assertFalse(gate.accepts(stale, bootstrap))
        assertTrue(gate.accepts(current, bootstrap))
    }

    @Test
    fun `logout or unauthorized invalidation rejects the old result`() {
        val gate = ExecutiveRequestGate()
        val lifecycle = gate.invalidate()
        val bootstrap = bootstrap(userId = 7, branchId = 3)
        val request = gate.begin(bootstrap, lifecycle)!!

        gate.invalidate()

        assertFalse(gate.accepts(request, bootstrap))
        assertNull(gate.begin(bootstrap, lifecycle))
    }

    @Test
    fun `result is bound to authenticated user and server-authorized scope`() {
        val gate = ExecutiveRequestGate()
        val lifecycle = gate.invalidate()
        val expected = bootstrap(userId = 7, branchId = 3)
        val request = gate.begin(expected, lifecycle)!!

        assertFalse(gate.accepts(request, bootstrap(userId = 8, branchId = 3)))
        assertFalse(gate.accepts(request, bootstrap(userId = 7, branchId = 4)))
        assertFalse(gate.accepts(request, bootstrap(userId = 7, branchId = null, allBranches = true)))
        assertFalse(gate.accepts(request, expected.copy(isExecutive = false, roleDegraded = true)))
        assertTrue(gate.accepts(request, expected))
    }

    @Test
    fun `cached executive session settles to an explicit offline error`() {
        val gate = ExecutiveRequestGate()
        val lifecycle = gate.invalidate()
        val expected = bootstrap(userId = 7, branchId = null, allBranches = true)
        val state = offlineExecutiveState(expected)

        assertTrue(gate.acceptsSnapshot(lifecycle, expected, expected))
        assertFalse(gate.acceptsSnapshot(lifecycle, expected, bootstrap(userId = 8, branchId = null, allBranches = true)))
        assertTrue(state is ExecutiveHomeState.Error)
        assertFalse(state is ExecutiveHomeState.Loading)
    }

    @Test
    fun `401 and unauthorized code are classified as session failures`() {
        assertTrue(ApiException("expired", status = 401).isUnauthorized())
        assertTrue(ApiException("expired", code = "UNAUTHORIZED").isUnauthorized())
        assertFalse(ApiException("forbidden", status = 403).isUnauthorized())
        assertFalse(IllegalStateException("offline").isUnauthorized())
    }

    private fun bootstrap(
        userId: Long,
        branchId: Long?,
        allBranches: Boolean = false,
    ) = AppBootstrap(
        user = UserIdentity(
            id = userId,
            name = "Executive $userId",
            username = "executive$userId",
            email = null,
            role = "manager",
            roleLabel = "Manager",
        ),
        modules = emptyList(),
        branchId = branchId,
        allBranches = allBranches,
        hasPersonalWorkspace = false,
        isExecutive = true,
    )
}
