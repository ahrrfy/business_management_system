package online.alarabiya.superapp.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeLoginContractTest {
    @Test
    fun `legacy production single tenant response remains supported`() {
        val mode = TenancyMode.fromJson(JSONObject().put("multiTenant", false))

        assertFalse(mode.multiTenant)
        assertFalse(mode.companyCodeRequired)
    }

    @Test
    fun `multi tenant response requires company code`() {
        val mode = TenancyMode.fromJson(
            JSONObject()
                .put("multiTenant", true)
                .put("mode", "multi")
                .put("companyCodeRequired", true),
        )

        assertTrue(mode.multiTenant)
        assertTrue(mode.companyCodeRequired)
    }

    @Test
    fun `login input forwards trimmed company code without changing single tenant contract`() {
        val tenantInput = buildLoginInput(" admin ", "secret", true, " acme ")
        assertEquals("admin", tenantInput.getString("identifier"))
        assertEquals("acme", tenantInput.getString("companyCode"))

        val singleTenantInput = buildLoginInput("admin", "secret", false, null)
        assertFalse(singleTenantInput.has("companyCode"))
    }

    @Test
    fun `owner identity and executive bootstrap survive cache round trip`() {
        val user = online.alarabiya.superapp.model.UserIdentity(
            id = 7,
            name = "Owner",
            username = "owner",
            email = "owner@example.test",
            role = "admin",
            roleLabel = "مدير النظام",
            isOwner = true,
        )
        val restoredUser = parseUserIdentity(JSONObject(encodeUserIdentity(user).toString()))
        assertTrue(restoredUser.isOwner)
        assertEquals(user.id, restoredUser.id)

        val payload = JSONObject()
            .put("user", encodeUserIdentity(user))
            .put("scope", JSONObject().put("branchId", JSONObject.NULL).put("allBranches", true))
            .put("modules", org.json.JSONArray().put(
                JSONObject().put("key", "reports").put("label", "التقارير").put("access", "FULL"),
            ))
            .put("capabilities", JSONObject()
                .put("isOwner", true)
                .put("isExecutive", true)
                .put("canSeeCost", true)
                .put("canViewReports", true)
                .put("roleDegraded", false)
                .put("hasPersonalWorkspace", false))
        val envelope = CachedSnapshotPolicy.envelope(payload, System.currentTimeMillis())
        val restored = parseBootstrapContract(envelope.getJSONObject("payload"))

        assertTrue(restored.user.isOwner)
        assertTrue(restored.isOwner)
        assertTrue(restored.isExecutive)
        assertTrue(restored.canSeeCost)
        assertTrue(restored.canViewReports)
        assertFalse(restored.roleDegraded)
    }

    @Test
    fun `legacy cached identity migrates safely with owner default false`() {
        val legacy = JSONObject()
            .put("id", 8)
            .put("name", "Legacy")
            .put("role", "manager")
        assertFalse(parseUserIdentity(legacy).isOwner)
    }
}
