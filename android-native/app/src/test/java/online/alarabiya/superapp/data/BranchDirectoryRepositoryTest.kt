package online.alarabiya.superapp.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class BranchDirectoryRepositoryTest {
    @Test
    fun mapperKeepsOnlyValidDistinctServerBranches() {
        val rows = JSONArray()
            .put(JSONObject().put("id", 7).put("name", " الرئيسي ").put("code", " HQ "))
            .put(JSONObject().put("id", 7).put("name", "نسخة مكررة"))
            .put(JSONObject().put("id", 0).put("name", "غير صالح"))
            .put(JSONObject().put("id", 8).put("name", " "))
            .put("not-an-object")

        val result = BranchDirectoryMapper.fromJson(rows)

        assertEquals(1, result.size)
        assertEquals(7L, result.single().id)
        assertEquals("الرئيسي", result.single().name)
        assertEquals("HQ", result.single().code)
    }
}
