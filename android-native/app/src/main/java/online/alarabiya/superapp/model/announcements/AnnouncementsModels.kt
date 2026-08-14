package online.alarabiya.superapp.model.announcements

import online.alarabiya.superapp.model.AppBootstrap

/** أولويّة الإعلان (تطابق قيم الخادم). */
enum class AnnouncementPriority(val wire: String, val label: String) {
    NORMAL("NORMAL", "عاديّ"),
    IMPORTANT("IMPORTANT", "مهمّ"),
    CRITICAL("CRITICAL", "حرِج");

    companion object {
        fun fromWire(value: String?): AnnouncementPriority =
            entries.firstOrNull { it.wire == value } ?: NORMAL
    }
}

/** جمهور الإعلان المستهدَف. */
enum class AnnouncementAudienceType(val wire: String, val label: String) {
    ALL("ALL", "كل الموظفين"),
    BRANCH("BRANCH", "فرع بعينه"),
    ROLE("ROLE", "دور بعينه");

    companion object {
        fun fromWire(value: String?): AnnouncementAudienceType =
            entries.firstOrNull { it.wire == value } ?: ALL
    }
}

/** إعلانٌ كما يراه الموظف في تغذية «إعلاناتي». */
data class Announcement(
    val id: Long,
    val title: String,
    val body: String,
    val priority: AnnouncementPriority,
    val requiresAck: Boolean,
    val createdAt: String,
    val expiresAt: String?,
    val readAt: String?,
    val acknowledgedAt: String?,
) {
    val isRead: Boolean get() = readAt != null
    val isAcknowledged: Boolean get() = acknowledgedAt != null
    /** يحتاج فعلاً من الموظف: إعلانٌ يتطلّب إقراراً ولم يُقَرّ بعد. */
    val needsAcknowledgement: Boolean get() = requiresAck && acknowledgedAt == null
}

data class AnnouncementFeed(
    val rows: List<Announcement>,
    val unreadCount: Int,
)

/** ملخّص إداريّ (قائمة الإدارة) + عدّادَا القراءة والإقرار. */
data class AnnouncementSummary(
    val id: Long,
    val title: String,
    val body: String,
    val priority: AnnouncementPriority,
    val audienceType: AnnouncementAudienceType,
    val audienceBranchId: Long?,
    val audienceRole: String?,
    val requiresAck: Boolean,
    val isActive: Boolean,
    val createdAt: String,
    val expiresAt: String?,
    val readCount: Int,
    val ackCount: Int,
)

data class AnnouncementReader(
    val userId: Long,
    val userName: String,
    val readAt: String,
    val acknowledgedAt: String?,
)

data class AnnouncementDetail(
    val summary: AnnouncementSummary,
    val readers: List<AnnouncementReader>,
)

/** أمر إنشاء إعلان (من شاشة الإدارة). */
data class CreateAnnouncementCommand(
    val title: String,
    val body: String,
    val priority: AnnouncementPriority = AnnouncementPriority.NORMAL,
    val audienceType: AnnouncementAudienceType = AnnouncementAudienceType.ALL,
    val audienceBranchId: Long? = null,
    val audienceRole: String? = null,
    val requiresAck: Boolean = false,
    val expiresAt: String? = null,
)

/**
 * بوّابة إدارة الإعلانات — مشتقّة من عقد البداية.
 * admin/manager: FULL (إنشاء/إدارة) · auditor: READ (رقابة) · غيرهم: NONE.
 * التغذية الشخصيّة «إعلاناتي» متاحة لكل موظّف مصادَق (لا تُقيَّد بهذه البوّابة).
 */
data class AnnouncementsCapabilities(
    val access: String,
    val role: String,
    val branchId: Long?,
    val isOwner: Boolean,
) {
    val canManage: Boolean get() = access == "FULL"
    val canReadManagement: Boolean get() = access == "FULL" || access == "READ"

    /** admin/المالك يبثّون عبر الفروع؛ مدير الفرع مقصورٌ بفرعه (يطابق حوكمة الخادم). */
    val canCrossBranches: Boolean get() = role == "admin" || isOwner

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): AnnouncementsCapabilities {
            val access = bootstrap.modules.firstOrNull { it.key == "announcements" }?.access ?: "NONE"
            return AnnouncementsCapabilities(
                access = access,
                role = bootstrap.user.role,
                branchId = bootstrap.branchId,
                isOwner = bootstrap.isOwner || bootstrap.user.isOwner,
            )
        }
    }
}
