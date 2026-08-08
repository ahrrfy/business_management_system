package online.alarabiya.superapp.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

class NativeRequestSerializationPolicyTest {
    @Test
    fun `read-only requests do not enter the mutation queue`() {
        assertFalse(NativeRequestSerializationPolicy.requiresSerialization("GET"))
        assertFalse(NativeRequestSerializationPolicy.requiresSerialization("head"))
    }

    @Test
    fun `state-changing requests remain ordered for device proof replay protection`() {
        assertTrue(NativeRequestSerializationPolicy.requiresSerialization("POST"))
        assertTrue(NativeRequestSerializationPolicy.requiresSerialization("PATCH"))
        assertTrue(NativeRequestSerializationPolicy.requiresSerialization("DELETE"))
    }

    @Test
    fun `session cookie parser selects the application session across multiple headers`() {
        assertEquals(
            "app_session_id=signed-token",
            SessionCookieParser.findSessionCookie(
                listOf(
                    "analytics=ignored; Path=/",
                    "app_session_id=signed-token; Path=/; HttpOnly; Secure; SameSite=Lax",
                ),
            ),
        )
    }

    @Test
    fun `session cookie parser rejects unrelated cookies`() {
        assertEquals(null, SessionCookieParser.findSessionCookie(listOf("count_token=other; Path=/")))
    }

    @Test
    fun `offline cache is limited to approved read models`() {
        val first = OfflineReadCachePolicy.cacheKey("customers.search", "{\"q\":\"a\"}")
        val second = OfflineReadCachePolicy.cacheKey("customers.search", "{\"q\":\"b\"}")

        assertNotNull(first)
        assertNotEquals(first, second)
        assertNull(OfflineReadCachePolicy.cacheKey("auth.me", "{}"))
        assertNull(OfflineReadCachePolicy.cacheKey("payroll.list", "{}"))
    }

    @Test
    fun `offline cache rejects stale cross-account and wrong-shape data`() {
        val now = 2_000_000_000_000L
        val valid = JSONObject()
            .put("savedAt", now - 1_000L)
            .put("userId", 42L)
            .put("kind", "array")
            .put("payload", JSONArray())

        assertTrue(OfflineReadCachePolicy.accepts(valid, "array", 42L, now))
        assertFalse(OfflineReadCachePolicy.accepts(valid, "array", 7L, now))
        assertFalse(OfflineReadCachePolicy.accepts(valid, "object", 42L, now))
        assertFalse(
            OfflineReadCachePolicy.accepts(
                JSONObject(valid.toString()).put("savedAt", now - 25L * 60L * 60L * 1_000L),
                "array",
                42L,
                now,
            ),
        )
    }
}
