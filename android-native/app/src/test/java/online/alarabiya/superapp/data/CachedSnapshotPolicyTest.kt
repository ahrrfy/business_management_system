package online.alarabiya.superapp.data

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CachedSnapshotPolicyTest {
    private val now = 2_000_000_000_000L

    @Test
    fun `accepts a recent snapshot bound to the current user`() {
        val envelope = CachedSnapshotPolicy.envelope(JSONObject().put("ok", true), now - 1_000L, 42L)

        assertTrue(CachedSnapshotPolicy.isFresh(envelope, now))
        assertTrue(CachedSnapshotPolicy.belongsTo(envelope, 42L))
    }

    @Test
    fun `rejects stale future and cross-account snapshots`() {
        val stale = CachedSnapshotPolicy.envelope(JSONObject(), now - 25L * 60L * 60L * 1_000L, 42L)
        val future = CachedSnapshotPolicy.envelope(JSONObject(), now + 6L * 60L * 1_000L, 42L)
        val current = CachedSnapshotPolicy.envelope(JSONObject(), now, 42L)

        assertFalse(CachedSnapshotPolicy.isFresh(stale, now))
        assertFalse(CachedSnapshotPolicy.isFresh(future, now))
        assertFalse(CachedSnapshotPolicy.belongsTo(current, 7L))
    }
}
