package online.alarabiya.superapp.data

import kotlinx.coroutines.runBlocking
import online.alarabiya.superapp.model.shifts.ShiftCloseCommand
import online.alarabiya.superapp.model.shifts.ShiftMoney
import online.alarabiya.superapp.model.shifts.ShiftType
import org.json.JSONArray
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

    @Test
    fun handoverRecipientsUseTheNamedActiveRecipientContract() = runBlocking {
        val api = FakeShiftApi(
            arrayResponse = JSONArray()
                .put(JSONObject().put("id", 11).put("name", "مدير الكرادة").put("branchId", 7))
                .put(JSONObject().put("id", 12).put("name", "الإدارة العامة").put("branchId", JSONObject.NULL))
                .put(JSONObject().put("id", 0).put("name", "غير صالح").put("branchId", 7)),
        )

        val recipients = ShiftRepository(api).handoverRecipients()

        assertEquals(listOf(11L, 12L), recipients.map { it.id })
        assertEquals(7L, recipients.first().branchId)
        assertNull(recipients.last().branchId)
        assertEquals("shifts.handoverRecipients", api.calls.single().procedure)
    }

    @Test
    fun closePassesTheSelectedHandoverRecipientToTheServer() = runBlocking {
        val api = FakeShiftApi(
            mutationResponse = JSONObject()
                .put("shiftId", 41)
                .put("openingBalance", "100")
                .put("expectedCash", "125000")
                .put("countedCash", "125000")
                .put("variance", "0")
                .put("reconciliationStatus", "MATCHED")
                .put("requiresManagerReview", false)
                .put("alreadyClosed", false)
                .put(
                    "treasuryReturn",
                    JSONObject()
                        .put("handoverNumber", "CH-7-20260831-0001")
                        .put("recipientName", "مدير الكرادة"),
                ),
        )

        val result = ShiftRepository(api).close(
            ShiftCloseCommand(
                shiftId = 41,
                countedCash = ShiftMoney.fromServer("125000"),
                handoverToUserId = 11,
            ),
        )

        assertEquals("CH-7-20260831-0001", result.treasuryHandoverNumber)
        assertEquals("مدير الكرادة", result.treasuryRecipientName)
        val call = api.calls.single()
        assertEquals("shifts.close", call.procedure)
        assertEquals(41L, call.input?.getLong("shiftId"))
        assertEquals("125000", call.input?.getString("countedCash"))
        assertEquals(11L, call.input?.getLong("handoverToUserId"))
    }

    @Test
    fun closeRefusesPositiveCashBeforeCallingTheServerWithoutARecipient() = runBlocking {
        val api = FakeShiftApi()

        val error = runCatching {
            ShiftRepository(api).close(
                ShiftCloseCommand(
                    shiftId = 41,
                    countedCash = ShiftMoney.fromServer("125000"),
                    handoverToUserId = null,
                ),
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(error?.message.orEmpty().contains("مديراً"))
        assertTrue(api.calls.isEmpty())
    }
}

private data class ShiftApiCall(
    val procedure: String,
    val input: JSONObject?,
    val nullable: Boolean,
)

private class FakeShiftApi(
    private val nullableResponse: JSONObject? = null,
    private val arrayResponse: JSONArray = JSONArray(),
    private val mutationResponse: JSONObject? = null,
) : ShiftApi {
    val calls = mutableListOf<ShiftApiCall>()

    override suspend fun queryObject(procedure: String, input: JSONObject?): JSONObject {
        calls += ShiftApiCall(procedure, input, nullable = false)
        error("Unexpected non-nullable query: $procedure")
    }

    override suspend fun queryNullableObject(procedure: String, input: JSONObject?): JSONObject? {
        calls += ShiftApiCall(procedure, input, nullable = true)
        return nullableResponse
    }

    override suspend fun queryArray(procedure: String, input: JSONObject?): JSONArray {
        calls += ShiftApiCall(procedure, input, nullable = false)
        return arrayResponse
    }

    override suspend fun mutateObject(procedure: String, input: JSONObject?): JSONObject {
        calls += ShiftApiCall(procedure, input, nullable = false)
        return mutationResponse ?: error("Unexpected mutation: $procedure")
    }
}
