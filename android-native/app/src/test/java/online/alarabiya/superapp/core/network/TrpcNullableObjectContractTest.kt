package online.alarabiya.superapp.core.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class TrpcNullableObjectContractTest {
    @Test
    fun nullableParserPreservesAnExplicitJsonNull() {
        val value = TrpcEnvelopeParser.parseNullable(
            """[{"result":{"data":{"json":null}}}]""",
            200,
        )

        assertNull(value)
    }

    @Test
    fun strictParserContinuesToRejectJsonNull() {
        val error = assertThrows(ApiException::class.java) {
            TrpcEnvelopeParser.parse(
                """[{"result":{"data":{"json":null}}}]""",
                200,
            )
        }

        assertEquals(200, error.status)
    }

    @Test
    fun nullableParserStillRejectsAMissingResultField() {
        val error = assertThrows(ApiException::class.java) {
            TrpcEnvelopeParser.parseNullable(
                """[{"result":{"data":{}}}]""",
                200,
            )
        }

        assertEquals(200, error.status)
    }

    @Test
    fun nullableObjectTypeAcceptsOnlyAnObjectOrNull() {
        val objectResult = JSONObject().put("id", 17)

        assertSame(objectResult, TrpcResultType.objectOrNull(objectResult))
        assertNull(TrpcResultType.objectOrNull(null))
        assertThrows(ApiException::class.java) {
            TrpcResultType.objectOrNull(JSONArray().put(17))
        }
    }

    @Test
    fun nullableParserStillPropagatesTypedTrpcErrors() {
        val error = assertThrows(ApiException::class.java) {
            TrpcEnvelopeParser.parseNullable(
                """[{"error":{"json":{"message":"missing","data":{"code":"NOT_FOUND","httpStatus":404}}}}]""",
                200,
            )
        }

        assertEquals(404, error.status)
        assertEquals("NOT_FOUND", error.code)
    }
}
