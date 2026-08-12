package online.alarabiya.superapp.core.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeEndpointPolicyTest {
    @Test
    fun `accepts https in every environment`() {
        assertTrue(NativeEndpointPolicy.isAllowed("https://example.test", "prod"))
        assertTrue(NativeEndpointPolicy.isAllowed("https://staging.example.test/", "staging"))
    }

    @Test
    fun `accepts emulator and local cleartext only in dev`() {
        assertTrue(NativeEndpointPolicy.isAllowed("http://10.0.2.2:3000", "dev"))
        assertTrue(NativeEndpointPolicy.isAllowed("http://127.0.0.1:3000", "dev"))
        assertTrue(NativeEndpointPolicy.isAllowed("http://localhost:3000", "dev"))
        assertFalse(NativeEndpointPolicy.isAllowed("http://10.0.2.2:3000", "prod"))
    }

    @Test
    fun `rejects remote cleartext and endpoint smuggling`() {
        assertFalse(NativeEndpointPolicy.isAllowed("http://example.test", "dev"))
        assertFalse(NativeEndpointPolicy.isAllowed("https://user@example.test", "prod"))
        assertFalse(NativeEndpointPolicy.isAllowed("https://example.test/api", "prod"))
        assertFalse(NativeEndpointPolicy.isAllowed("https://example.test?next=http://evil.test", "prod"))
    }

    @Test
    fun `never accepts production cleartext even when host resembles a loopback`() {
        assertFalse(NativeEndpointPolicy.isAllowed("http://localhost:3000", "prod"))
        assertFalse(NativeEndpointPolicy.isAllowed("http://127.0.0.1:3000", "staging"))
        assertFalse(NativeEndpointPolicy.isAllowed("ftp://example.test", "dev"))
    }
}
