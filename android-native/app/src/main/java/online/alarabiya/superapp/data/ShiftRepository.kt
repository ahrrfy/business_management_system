package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.shifts.CurrentShift
import online.alarabiya.superapp.model.shifts.ShiftCloseCommand
import online.alarabiya.superapp.model.shifts.ShiftCloseResult
import online.alarabiya.superapp.model.shifts.ShiftFilters
import online.alarabiya.superapp.model.shifts.ShiftMappers
import online.alarabiya.superapp.model.shifts.ShiftPage
import online.alarabiya.superapp.model.shifts.ShiftReport
import online.alarabiya.superapp.model.shifts.ShiftType
import org.json.JSONArray
import org.json.JSONObject

interface ShiftDataSource {
    suspend fun list(filters: ShiftFilters, cursor: Long? = null, limit: Int = 50): ShiftPage
    suspend fun report(shiftId: Long): ShiftReport
    suspend fun current(branchId: Long, type: ShiftType): CurrentShift?
    suspend fun close(command: ShiftCloseCommand): ShiftCloseResult
}

class ShiftReportNotFoundException(val shiftId: Long) :
    NoSuchElementException("لم يعد تقرير الوردية رقم $shiftId متاحاً")

internal interface ShiftApi {
    suspend fun queryObject(procedure: String, input: JSONObject? = null): JSONObject
    suspend fun queryNullableObject(procedure: String, input: JSONObject? = null): JSONObject?
    suspend fun mutateObject(procedure: String, input: JSONObject? = null): JSONObject
}

private class TrpcShiftApi(private val client: TrpcClient) : ShiftApi {
    override suspend fun queryObject(procedure: String, input: JSONObject?): JSONObject =
        client.query(procedure, input)

    override suspend fun queryNullableObject(procedure: String, input: JSONObject?): JSONObject? =
        client.queryNullableObject(procedure, input)

    override suspend fun mutateObject(procedure: String, input: JSONObject?): JSONObject =
        client.mutate(procedure, input)
}

/** Native, typed facade over the existing `shifts` tRPC contract. */
class ShiftRepository internal constructor(private val api: ShiftApi) : ShiftDataSource {
    constructor(client: TrpcClient) : this(TrpcShiftApi(client))

    override suspend fun list(filters: ShiftFilters, cursor: Long?, limit: Int): ShiftPage {
        require(limit in 1..MAX_PAGE_SIZE) { "حجم الصفحة غير صالح" }
        require(filters.validate(canSelectBranch = true) == null) { "فلاتر الورديات غير صالحة" }
        require(cursor == null || cursor > 0) { "مؤشر الصفحة غير صالح" }
        val input = JSONObject()
            .put("limit", limit)
            .put("offset", 0)
            .putOptional("branchId", filters.branchIdOrNull())
            .putOptional("status", filters.status?.wire)
            .putOptional("shiftType", filters.type?.wire)
            .putOptional("varianceState", filters.variance?.wire)
            .putOptional("q", filters.search.trim().takeIf(String::isNotEmpty))
            .putOptional("from", filters.from.takeIf(String::isNotEmpty))
            .putOptional("to", filters.to.takeIf(String::isNotEmpty))
            .putOptional("cursor", cursor)
        return ShiftMappers.page(api.queryObject("shifts.list", input).wireMap())
    }

    override suspend fun report(shiftId: Long): ShiftReport {
        require(shiftId > 0) { "معرّف الوردية غير صالح" }
        val root = api.queryNullableObject("shifts.report", JSONObject().put("shiftId", shiftId))
            ?: throw ShiftReportNotFoundException(shiftId)
        return ShiftMappers.report(root.wireMap())
            ?: throw IllegalStateException("استجابة تقرير الوردية غير صالحة")
    }

    override suspend fun current(branchId: Long, type: ShiftType): CurrentShift? {
        require(branchId > 0) { "معرّف الفرع غير صالح" }
        val input = JSONObject()
            .put("branchId", branchId)
            .put("shiftType", type.wire)
        val root = api.queryNullableObject("shifts.current", input) ?: return null
        return ShiftMappers.current(root.wireMap())
            ?: throw IllegalStateException("استجابة الوردية الحالية غير صالحة")
    }

    override suspend fun close(command: ShiftCloseCommand): ShiftCloseResult {
        require(command.shiftId > 0) { "معرّف الوردية غير صالح" }
        val response = api.mutateObject(
            "shifts.close",
            JSONObject()
                .put("shiftId", command.shiftId)
                .put("countedCash", command.countedCash.value),
        )
        return ShiftMappers.closeResult(response.wireMap())
            ?: throw IllegalStateException("لم يصل تأكيد صالح لإغلاق الوردية")
    }

    private companion object {
        const val MAX_PAGE_SIZE = 200
    }
}

private fun JSONObject.putOptional(key: String, value: Any?): JSONObject = apply {
    if (value != null) put(key, value)
}

private fun JSONObject.wireMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
    valueAt(opt(key))
}

private fun JSONArray.wireList(): List<Any?> = List(length()) { index -> valueAt(opt(index)) }

private fun valueAt(value: Any?): Any? = when {
    value == null || value === JSONObject.NULL -> null
    value is JSONObject -> value.wireMap()
    value is JSONArray -> value.wireList()
    else -> value
}
