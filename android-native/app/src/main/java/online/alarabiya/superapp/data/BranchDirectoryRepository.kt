package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.session.SessionBranch
import org.json.JSONArray
import org.json.JSONObject

interface BranchDirectoryDataSource {
    suspend fun availableBranches(): List<SessionBranch>
}

class BranchDirectoryRepository(
    private val api: TrpcClient,
) : BranchDirectoryDataSource {
    override suspend fun availableBranches(): List<SessionBranch> =
        BranchDirectoryMapper.fromJson(api.queryArray("branches.list"))
}

internal object BranchDirectoryMapper {
    fun fromJson(rows: JSONArray): List<SessionBranch> = buildList {
        for (index in 0 until rows.length()) {
            val row = rows.opt(index) as? JSONObject ?: continue
            val id = row.optLong("id").takeIf { it > 0 } ?: continue
            val name = row.optString("name").trim().takeIf(String::isNotEmpty) ?: continue
            val code = row.optString("code").trim().takeIf(String::isNotEmpty)
            add(SessionBranch(id = id, name = name, code = code))
        }
    }.distinctBy(SessionBranch::id)
}
