package online.alarabiya.superapp.data

import kotlinx.coroutines.runBlocking
import online.alarabiya.superapp.model.shifts.ShiftType
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShiftRepositoryNullableContractTest {
    @Test
    fun currentTreatsOnlyAnExplicitNullableResultAsNoOpenShift() = runBlocking {
        val api = FakeShiftApi(nullableResponse = null)

        val result = ShiftRepository(api).current(branchId = 7, type = ShiftType.RECEPTION)

        assertNull(result)
        val call = api.calls.single()
        assertEquals("shifts.current", call.procedure)
        assertTrue(call.nullable)
        assertEquals(7L, call.input?.getLong("branchId"))
        assertEquals("RECEPTION", call.input?.getString("shiftType"))
    }

    @Test
    fun reportMapsAnExplicitNullToTheDomainNotFoundError() = runBlocking {
        val api = FakeShiftApi(nullableResponse = null)

        val error = runCatching { ShiftRepository(api).report(shiftId = 41) }.exceptionOrNull()

        assertTrue(error is ShiftReportNotFoundException)
        assertEquals(41L, (error as ShiftReportNotFoundException).shiftId)
        val call = api.calls.single()
        assertEquals("shifts.report", call.procedure)
        assertTrue(call.nullable)
        assertEquals(41L, call.input?.getLong("shiftId"))
    }

    @Test
    fun malformedCurrentObjectIsNotSilentlyReportedAsNoShift() = runBlocking {
        val api = FakeShiftApi(nullableResponse = JSONObject().put("id", 17))

        val error = runCatching {
            ShiftRepository(api).current(branchId = 7, type = ShiftType.RETAIL)
        }.exceptionOrNull()

        assertTrue(error is IllegalStateException)
        assertTrue(error !is ShiftReportNotFoundException)
    }

    @Test
    fun malformedReportObjectIsNotMisclassifiedAsNotFound() = runBlocking {
        val api = FakeShiftApi(nullableResponse = JSONObject().put("shift", JSONObject()))

        val error = runCatching { ShiftRepository(api).report(shiftId = 41) }.exceptionOrNull()

        assertTrue(error is IllegalStateException)
        assertTrue(error !is ShiftReportNotFoundException)
    }
}

private data class ShiftApiCall(
    val procedure: String,
    val input: JSONObject?,
    val nullable: Boolean,
)

private class FakeShiftApi(private val nullableResponse: JSONObject?) : ShiftApi {
    val calls = mutableListOf<ShiftApiCall>()

    override suspend fun queryObject(procedure: String, input: JSONObject?): JSONObject {
        calls += ShiftApiCall(procedure, input, nullable = false)
        error("Unexpected non-nullable query: $procedure")
    }

    override suspend fun queryNullableObject(procedure: String, input: JSONObject?): JSONObject? {
        calls += ShiftApiCall(procedure, input, nullable = true)
        return nullableResponse
    }

    override suspend fun mutateObject(procedure: String, input: JSONObject?): JSONObject {
        calls += ShiftApiCall(procedure, input, nullable = false)
        error("Unexpected mutation: $procedure")
    }
}
