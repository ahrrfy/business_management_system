package online.alarabiya.superapp.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class AdminMapperTest {
    @Test
    fun `maps only the safe user projection returned by the server`() {
        val user = AdminMapper.user(
            AdminUserPayload(
                id = 18,
                name = "مدير الفرع",
                email = "manager@example.test",
                username = "branch.manager",
                phone = null,
                role = "manager",
                customRoleId = 4,
                customRoleLabel = "مدير مبيعات",
                branchId = 2,
                isActive = true,
                isOwner = false,
                jobTitle = "مدير فرع",
                hiredAt = "2026-01-03",
                mustChangePassword = false,
                lastSignedIn = "2026-08-06T10:00:00Z",
                createdAt = "2026-01-03T10:00:00Z",
                effectiveStation = "RETAIL",
            ),
        )

        requireNotNull(user)
        assertEquals("مدير مبيعات", user.displayRole)
        assertEquals("branch.manager", user.identifier)
        assertEquals(2L, user.branchId)
        assertFalse(user.isOwner)
    }

    @Test
    fun `rejects malformed user rows instead of inventing identity`() {
        val malformed = AdminUserPayload(
            id = 0,
            name = "",
            email = null,
            username = null,
            phone = null,
            role = "",
            customRoleId = null,
            customRoleLabel = null,
            branchId = null,
            isActive = false,
            isOwner = false,
            jobTitle = null,
            hiredAt = null,
            mustChangePassword = false,
            lastSignedIn = null,
            createdAt = null,
            effectiveStation = null,
        )

        assertNull(AdminMapper.user(malformed))
    }

    @Test
    fun `audit mapper retains field names but not before after values`() {
        val event = AdminMapper.audit(
            AdminAuditPayload(
                id = 91,
                userId = 1,
                userName = "المدير",
                branchId = 2,
                action = "user.update",
                entityType = "user",
                entityId = 18,
                oldFields = setOf("role", "passwordHash"),
                newFields = setOf("role", "permissionsOverride"),
                ipAddress = "192.168.10.44",
                createdAt = "2026-08-06T11:00:00Z",
            ),
        )

        requireNotNull(event)
        assertEquals(listOf("passwordHash", "permissionsOverride", "role"), event.changedFields)
        assertEquals("192.168.10.•••", event.maskedIpAddress)
        assertFalse(event.toString().contains("oldValue"))
        assertFalse(event.toString().contains("newValue"))
    }

    @Test
    fun `ip masking never returns an unrecognized raw value`() {
        assertEquals("2001:db8:85a3:•••", AdminMapper.maskIp("2001:db8:85a3::8a2e:370:7334"))
        assertEquals("•••", AdminMapper.maskIp("internal-proxy-secret"))
        assertNull(AdminMapper.maskIp(null))
    }
}
