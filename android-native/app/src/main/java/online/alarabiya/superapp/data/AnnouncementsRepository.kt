package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.announcements.Announcement
import online.alarabiya.superapp.model.announcements.AnnouncementAudienceType
import online.alarabiya.superapp.model.announcements.AnnouncementDetail
import online.alarabiya.superapp.model.announcements.AnnouncementFeed
import online.alarabiya.superapp.model.announcements.AnnouncementPriority
import online.alarabiya.superapp.model.announcements.AnnouncementReader
import online.alarabiya.superapp.model.announcements.AnnouncementSummary
import online.alarabiya.superapp.model.announcements.AnnouncementsCapabilities
import online.alarabiya.superapp.model.announcements.CreateAnnouncementCommand
import org.json.JSONArray
import org.json.JSONObject

interface AnnouncementsDataSource {
    // ─── الموظف (متاح لكل مصادَق) ───
    suspend fun myFeed(limit: Int = 40): AnnouncementFeed
    suspend fun markRead(id: Long)
    suspend fun acknowledge(id: Long)

    // ─── الإدارة (admin/manager FULL · auditor READ) ───
    suspend fun manageList(includeInactive: Boolean = false, limit: Int = 50): List<AnnouncementSummary>
    suspend fun manageDetail(id: Long): AnnouncementDetail
    suspend fun create(command: CreateAnnouncementCommand): Long
    suspend fun setActive(id: Long, isActive: Boolean)
}

/**
 * واجهة أصيلة فوق راوتر `announcements` (المرحلة ١). التغذية الشخصيّة عالميّة؛ عمليات الإدارة
 * محروسة بـ[capabilities] (الخادم هو الحاجز النهائيّ — هذا فحصٌ مبكّر يمنع نداءً بلا صلاحية).
 */
class AnnouncementsRepository(
    private val api: TrpcClient,
    private val capabilities: AnnouncementsCapabilities,
) : AnnouncementsDataSource {

    override suspend fun myFeed(limit: Int): AnnouncementFeed =
        AnnouncementParser.feed(api.query("announcements.mine", JSONObject().put("limit", limit.coerceIn(1, 100))))

    override suspend fun markRead(id: Long) {
        require(id > 0) { "معرّف الإعلان غير صالح" }
        api.mutate("announcements.markRead", JSONObject().put("id", id))
    }

    override suspend fun acknowledge(id: Long) {
        require(id > 0) { "معرّف الإعلان غير صالح" }
        api.mutate("announcements.acknowledge", JSONObject().put("id", id))
    }

    override suspend fun manageList(includeInactive: Boolean, limit: Int): List<AnnouncementSummary> {
        require(capabilities.canReadManagement) { "لا صلاحية لعرض إدارة الإعلانات" }
        return api.queryArray(
            "announcements.list",
            JSONObject().put("includeInactive", includeInactive).put("limit", limit.coerceIn(1, 200)),
        ).objects().mapNotNull(AnnouncementParser::summaryOrNull)
    }

    override suspend fun manageDetail(id: Long): AnnouncementDetail {
        require(capabilities.canReadManagement) { "لا صلاحية لعرض تفاصيل الإعلان" }
        require(id > 0) { "معرّف الإعلان غير صالح" }
        return AnnouncementParser.detail(api.query("announcements.get", JSONObject().put("id", id)))
    }

    override suspend fun create(command: CreateAnnouncementCommand): Long {
        require(capabilities.canManage) { "لا صلاحية لإنشاء إعلان" }
        val title = command.title.trim()
        val body = command.body.trim()
        require(title.isNotEmpty()) { "عنوان الإعلان مطلوب" }
        require(body.isNotEmpty()) { "نص الإعلان مطلوب" }
        val input = JSONObject()
            .put("title", title)
            .put("body", body)
            .put("priority", command.priority.wire)
            .put("audienceType", command.audienceType.wire)
            .put("requiresAck", command.requiresAck)
        if (command.audienceType == AnnouncementAudienceType.BRANCH) {
            val branch = command.audienceBranchId ?: throw IllegalArgumentException("اختر الفرع المستهدَف")
            input.put("audienceBranchId", branch)
        }
        if (command.audienceType == AnnouncementAudienceType.ROLE) {
            val role = command.audienceRole?.takeIf { it.isNotBlank() }
                ?: throw IllegalArgumentException("اختر الدور المستهدَف")
            input.put("audienceRole", role)
        }
        command.expiresAt?.takeIf { it.isNotBlank() }?.let { input.put("expiresAt", it) }
        val created = api.mutate("announcements.create", input)
        return created.optLong("id").takeIf { it > 0 } ?: error("لم يؤكّد الخادم إنشاء الإعلان")
    }

    override suspend fun setActive(id: Long, isActive: Boolean) {
        require(capabilities.canManage) { "لا صلاحية لتعديل حالة الإعلان" }
        require(id > 0) { "معرّف الإعلان غير صالح" }
        api.mutate("announcements.setActive", JSONObject().put("id", id).put("isActive", isActive))
    }
}

private object AnnouncementParser {
    fun feed(root: JSONObject): AnnouncementFeed = AnnouncementFeed(
        rows = root.optJSONArray("rows").objects().mapNotNull(::announcementOrNull),
        unreadCount = root.optInt("unreadCount", 0).coerceAtLeast(0),
    )

    fun detail(root: JSONObject): AnnouncementDetail {
        val summary = summaryOrNull(root.optJSONObject("announcement") ?: JSONObject())
            ?: throw IllegalStateException("تعذّر تحميل الإعلان")
        return AnnouncementDetail(
            summary = summary,
            readers = root.optJSONArray("readers").objects().mapNotNull(::readerOrNull),
        )
    }

    fun summaryOrNull(obj: JSONObject): AnnouncementSummary? {
        val id = obj.optLong("id")
        if (id <= 0) return null
        return AnnouncementSummary(
            id = id,
            title = obj.optString("title"),
            body = obj.optString("body"),
            priority = AnnouncementPriority.fromWire(obj.nullableText("priority")),
            audienceType = AnnouncementAudienceType.fromWire(obj.nullableText("audienceType")),
            audienceBranchId = obj.nullableLong("audienceBranchId"),
            audienceRole = obj.nullableText("audienceRole"),
            requiresAck = obj.optBoolean("requiresAck"),
            isActive = obj.optBoolean("isActive", true),
            createdAt = obj.optString("createdAt"),
            expiresAt = obj.nullableText("expiresAt"),
            readCount = obj.optInt("readCount", 0),
            ackCount = obj.optInt("ackCount", 0),
        )
    }

    private fun announcementOrNull(obj: JSONObject): Announcement? {
        val id = obj.optLong("id")
        if (id <= 0) return null
        return Announcement(
            id = id,
            title = obj.optString("title"),
            body = obj.optString("body"),
            priority = AnnouncementPriority.fromWire(obj.nullableText("priority")),
            requiresAck = obj.optBoolean("requiresAck"),
            createdAt = obj.optString("createdAt"),
            expiresAt = obj.nullableText("expiresAt"),
            readAt = obj.nullableText("readAt"),
            acknowledgedAt = obj.nullableText("acknowledgedAt"),
        )
    }

    private fun readerOrNull(obj: JSONObject): AnnouncementReader? {
        val userId = obj.optLong("userId")
        if (userId <= 0) return null
        return AnnouncementReader(
            userId = userId,
            userName = obj.optString("userName"),
            readAt = obj.optString("readAt"),
            acknowledgedAt = obj.nullableText("acknowledgedAt"),
        )
    }
}

private fun JSONArray?.objects(): List<JSONObject> {
    if (this == null) return emptyList()
    return buildList { for (index in 0 until length()) optJSONObject(index)?.let(::add) }
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }
