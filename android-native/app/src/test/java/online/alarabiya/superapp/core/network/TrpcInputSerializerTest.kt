package online.alarabiya.superapp.core.network

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrpcInputSerializerTest {
    @Test
    fun absentInputUsesSuperJsonUndefinedMetadata() {
        val item = TrpcInputSerializer.envelope(null).getJSONObject("0")

        assertTrue(item.isNull("json"))
        assertEquals("undefined", item.getJSONObject("meta").getJSONArray("values").getString(0))
    }

    @Test
    fun objectInputIsPreservedWithoutUndefinedMetadata() {
        val item = TrpcInputSerializer.envelope(JSONObject().put("limit", 30)).getJSONObject("0")

        assertEquals(30, item.getJSONObject("json").getInt("limit"))
        assertFalse(item.has("meta"))
    }
}
