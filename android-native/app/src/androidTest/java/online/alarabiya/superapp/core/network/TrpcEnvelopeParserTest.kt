package online.alarabiya.superapp.core.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class TrpcEnvelopeParserTest {
    @Test
    fun parsesObjectResult() {
        val value = TrpcEnvelopeParser.parse(
            """[{"result":{"data":{"json":{"id":17,"name":"موظف"}}}}]""",
            200,
        )

        assertTrue(value is JSONObject)
        assertEquals(17, (value as JSONObject).getInt("id"))
    }

    @Test
    fun parsesArrayResultWithoutForcingItIntoAnObject() {
        val value = TrpcEnvelopeParser.parse(
            """[{"result":{"data":{"json":[{"id":1},{"id":2}]}}}]""",
            200,
        )

        assertTrue(value is JSONArray)
        assertEquals(2, (value as JSONArray).length())
    }

    @Test
    fun preservesTrpcAndApplicationErrorMetadata() {
        val payload = """
            [{"error":{"json":{"message":"يلزم تغيير كلمة المرور","data":{
              "code":"FORBIDDEN","httpStatus":403,
              "appCode":"PASSWORD_CHANGE_REQUIRED",
              "correlationId":"req-42","dbCode":"ER_LOCK_WAIT_TIMEOUT"
            }}}}]
        """.trimIndent()

        try {
            TrpcEnvelopeParser.parse(payload, 200)
            fail("Expected ApiException")
        } catch (error: ApiException) {
            assertEquals(403, error.status)
            assertEquals("FORBIDDEN", error.code)
            assertEquals("PASSWORD_CHANGE_REQUIRED", error.appCode)
            assertEquals("req-42", error.correlationId)
            assertEquals("ER_LOCK_WAIT_TIMEOUT", error.dbCode)
        }
    }

    @Test
    fun rejectsIncompleteEnvelope() {
        try {
            TrpcEnvelopeParser.parse("""[{"result":{"data":{}}}]""", 200)
            fail("Expected ApiException")
        } catch (error: ApiException) {
            assertEquals(200, error.status)
        }
    }
}
