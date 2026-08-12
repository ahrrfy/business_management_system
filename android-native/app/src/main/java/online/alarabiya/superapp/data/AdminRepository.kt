package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.admin.AccessLevel
import online.alarabiya.superapp.model.admin.AdminAuditEvent
import online.alarabiya.superapp.model.admin.AdminAuditPage
import online.alarabiya.superapp.model.admin.AdminBranch
import online.alarabiya.superapp.model.admin.AdminOverview
import online.alarabiya.superapp.model.admin.AdminRole
import online.alarabiya.superapp.model.admin.AdminUser
import online.alarabiya.superapp.model.admin.AdminUserSession
import online.alarabiya.superapp.model.admin.CreateAdminRoleCommand
import online.alarabiya.superapp.model.admin.CreateAdminUserCommand
import online.alarabiya.superapp.model.admin.RoleAssignment
import online.alarabiya.superapp.model.admin.UpdateAdminRoleCommand
import online.alarabiya.superapp.model.admin.UpdateAdminUserCommand
import online.alarabiya.superapp.model.admin.EffectivePermission
import online.alarabiya.superapp.model.admin.UserPermissionProfile
import org.json.JSONArray
import org.json.JSONObject

interface AdminDataSource {
    suspend fun loadOverview(query: String = "", includeInactive: Boolean = false): AdminOverview
    suspend fun loadAudit(cursor: Long? = null): AdminAuditPage
    suspend fun generateTemporaryPassword(): String
    suspend fun createUser(command: CreateAdminUserCommand): Long
    suspend fun updateUser(command: UpdateAdminUserCommand)
    suspend fun assignRole(userId: Long, assignment: RoleAssignment)
    suspend fun setUserActive(userId: Long, active: Boolean)
    suspend fun loadUserPermissions(userId: Long): UserPermissionProfile
    suspend fun updateUserPermissions(userId: Long, overrides: Map<String, AccessLevel>)
    suspend fun resetUserPassword(userId: Long, temporaryPassword: String)
    suspend fun loadUserSessions(userId: Long): List<AdminUserSession>
    suspend fun revokeUserSession(userId: Long, sessionId: Long)
    suspend fun revokeAllUserSessions(userId: Long)
    suspend fun resetUserTwoFactor(userId: Long)
    suspend fun createRole(command: CreateAdminRoleCommand): Long
    suspend fun updateRole(command: UpdateAdminRoleCommand)
    suspend fun setRoleActive(roleId: Long, active: Boolean)
}

data class AdminUserPayload(
    val id: Long,
    val name: String,
    val email: String?,
    val username: String?,
    val phone: String?,
    val role: String,
    val customRoleId: Long?,
    val customRoleLabel: String?,
    val branchId: Long?,
    val isActive: Boolean,
    val isOwner: Boolean,
    val jobTitle: String?,
    val hiredAt: String?,
    val mustChangePassword: Boolean,
    val lastSignedIn: String?,
    val createdAt: String?,
    val effectiveStation: String?,
)

data class AdminAuditPayload(
    val id: Long,
    val userId: Long?,
    val userName: String?,
    val branchId: Long?,
    val action: String,
    val entityType: String,
    val entityId: Long?,
    val oldFields: Set<String>,
    val newFields: Set<String>,
    val ipAddress: String?,
    val createdAt: String,
)

object AdminMapper {
    fun user(payload: AdminUserPayload): AdminUser? {
        if (payload.id <= 0 || payload.name.isBlank() || payload.role.isBlank()) return null
        return AdminUser(
            id = payload.id,
            name = payload.name,
            email = payload.email,
            username = payload.username,
            phone = payload.phone,
            role = payload.role,
            customRoleId = payload.customRoleId,
            customRoleLabel = payload.customRoleLabel,
            branchId = payload.branchId,
            isActive = payload.isActive,
            isOwner = payload.isOwner,
            jobTitle = payload.jobTitle,
            hiredAt = payload.hiredAt,
            mustChangePassword = payload.mustChangePassword,
            lastSignedIn = payload.lastSignedIn,
            createdAt = payload.createdAt,
            effectiveStation = payload.effectiveStation,
        )
    }

    /** Raw before/after values are deliberately discarded; only server-redacted field names survive. */
    fun audit(payload: AdminAuditPayload): AdminAuditEvent? {
        if (payload.id <= 0 || payload.action.isBlank() || payload.entityType.isBlank()) return null
        return AdminAuditEvent(
            id = payload.id,
            actorId = payload.userId,
            actorName = payload.userName?.takeIf(String::isNotBlank) ?: "النظام",
            branchId = payload.branchId,
            action = payload.action,
            entityType = payload.entityType,
            entityId = payload.entityId,
            changedFields = (payload.oldFields + payload.newFields).sorted(),
            maskedIpAddress = maskIp(payload.ipAddress),
            createdAt = payload.createdAt,
        )
    }

    fun maskIp(raw: String?): String? {
        val value = raw?.trim()?.takeIf(String::isNotEmpty) ?: return null
        val ipv4 = value.split('.')
        if (ipv4.size == 4 && ipv4.all { part -> part.toIntOrNull()?.let { it in 0..255 } == true }) {
            return "${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.•••"
        }
        if (':' in value) return value.split(':').take(3).joinToString(":") + ":•••"
        return "•••"
    }

    fun session(payload: JSONObject): AdminUserSession? {
        val id = payload.optLong("id").takeIf { it > 0 } ?: return null
        return AdminUserSession(
            id = id,
            deviceLabel = deviceLabel(payload.optString("userAgent")),
            maskedIpAddress = maskIp(payload.nullableText("ipAddress")),
            createdAt = payload.optString("createdAt"),
            lastSeenAt = payload.optString("lastSeenAt"),
            expiresAt = payload.optString("expiresAt"),
        )
    }

    private fun deviceLabel(userAgent: String?): String {
        val value = userAgent.orEmpty()
        return when {
            value.contains("Android", ignoreCase = true) -> "جهاز Android"
            value.contains("iPhone", ignoreCase = true) || value.contains("iPad", ignoreCase = true) -> "جهاز Apple"
            value.contains("Windows", ignoreCase = true) -> "جهاز Windows"
            value.contains("Macintosh", ignoreCase = true) -> "جهاز Mac"
            else -> "جهاز غير معروف"
        }
    }
}

/**
 * Native facade over the authoritative admin-only server contracts. It intentionally does not
 * expose self-registration, deletion, owner assignment, or raw audit values. Privileged
 * permission/password operations remain owner-gated by the UI policy and server authentication.
 */
class AdminRepository(private val api: TrpcClient) : AdminDataSource {
    override suspend fun loadOverview(query: String, includeInactive: Boolean): AdminOverview {
        val usersResponse = api.query(
            "users.list",
            JSONObject()
                .put("q", query.trim())
                .put("includeInactive", includeInactive)
                .put("limit", USER_LIMIT)
                .put("offset", 0),
        )
        val users = usersResponse.optJSONArray("rows").objects()
            .mapNotNull { AdminMapper.user(it.toAdminUserPayload()) }

        // Dedicated guard snapshot: the UI never infers "last admin" from the filtered page.
        val activeGuardRows = api.query(
            "users.list",
            JSONObject()
                .put("includeInactive", false)
                .put("limit", SERVER_MAX_USERS)
                .put("offset", 0),
        ).optJSONArray("rows").objects()
        val activeAdmins = activeGuardRows.count { it.optBoolean("isActive") && it.optString("role") == "admin" }
        val activeOwners = activeGuardRows.count { it.optBoolean("isActive") && it.optBoolean("isOwner") }

        val roleResponse = api.query("roles.list", JSONObject().put("includeInactive", true))
        val counts = roleResponse.optJSONObject("counts") ?: JSONObject()
        val roles = buildList {
            roleResponse.optJSONArray("builtin").objects().mapNotNullTo(this) {
                it.toAdminRole(id = null, count = 0)
            }
            roleResponse.optJSONArray("custom").objects().mapNotNullTo(this) { item ->
                val id = item.optLong("id").takeIf { it > 0 } ?: return@mapNotNullTo null
                item.toAdminRole(id = id, count = counts.optInt(id.toString()))
            }
        }
        val branches = api.queryArray("branches.adminList").objects().mapNotNull(JSONObject::toAdminBranch)

        return AdminOverview(
            users = users,
            totalUsers = usersResponse.optInt("total", users.size),
            activeAdminCount = activeAdmins,
            activeOwnerCount = activeOwners,
            roles = roles,
            branches = branches,
        )
    }

    override suspend fun loadAudit(cursor: Long?): AdminAuditPage {
        val input = JSONObject().put("limit", AUDIT_LIMIT)
        cursor?.let { input.put("cursor", it) }
        val response = api.query("audit.list", input)
        return AdminAuditPage(
            rows = response.optJSONArray("rows").objects()
                .mapNotNull { AdminMapper.audit(it.toAdminAuditPayload()) },
            hasMore = response.optBoolean("hasMore"),
            nextCursor = response.nullableLong("nextCursor"),
        )
    }

    override suspend fun generateTemporaryPassword(): String =
        api.query("users.generatePassword").optString("password")
            .takeIf(String::isNotBlank)
            ?: error("لم يُرجع الخادم كلمة مرور مؤقتة")

    override suspend fun createUser(command: CreateAdminUserCommand): Long {
        require(command.name.isNotBlank()) { "اسم المستخدم مطلوب" }
        require(!command.email.isNullOrBlank() || !command.username.isNullOrBlank()) {
            "البريد أو اسم المستخدم مطلوب"
        }
        require(command.temporaryPassword.isNotBlank()) { "كلمة المرور المؤقتة مطلوبة" }
        val input = JSONObject()
            .put("name", command.name.trim())
            .put("password", command.temporaryPassword)
            .put("mustChangePassword", true)
            .putOptional("email", command.email)
            .putOptional("username", command.username)
            .putNullable("branchId", command.branchId)
            .putNullable("phone", command.phone)
            .putNullable("jobTitle", command.jobTitle)
            .putNullable("hiredAt", command.hiredAt)
            .putAssignment(command.assignment)
        return api.mutate("users.create", input).optLong("userId")
            .takeIf { it > 0 } ?: error("لم يُرجع الخادم معرّف المستخدم")
    }

    override suspend fun updateUser(command: UpdateAdminUserCommand) {
        require(command.userId > 0 && command.name.isNotBlank()) { "بيانات المستخدم غير صالحة" }
        api.mutate(
            "users.update",
            JSONObject()
                .put("userId", command.userId)
                .put("name", command.name.trim())
                .put("email", command.email.orEmpty().trim())
                .put("username", command.username.orEmpty().trim())
                .putNullable("branchId", command.branchId)
                .putNullable("phone", command.phone)
                .putNullable("jobTitle", command.jobTitle)
                .putNullable("hiredAt", command.hiredAt),
        )
    }

    override suspend fun assignRole(userId: Long, assignment: RoleAssignment) {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        api.mutate("users.update", JSONObject().put("userId", userId).putAssignment(assignment))
    }

    override suspend fun setUserActive(userId: Long, active: Boolean) {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        api.mutate("users.setActive", JSONObject().put("userId", userId).put("isActive", active))
    }

    override suspend fun loadUserPermissions(userId: Long): UserPermissionProfile {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        val effective = api.query("users.effectivePermissions", JSONObject().put("userId", userId))
        val details = api.query("users.get", JSONObject().put("userId", userId))
        val modules = effective.optJSONArray("modules").objects().mapNotNull { item ->
            val key = item.optString("key").takeIf(String::isNotBlank) ?: return@mapNotNull null
            EffectivePermission(
                key = key,
                label = item.optString("label").takeIf(String::isNotBlank) ?: key,
                level = AccessLevel.fromApi(item.optString("level")),
                source = item.optString("source"),
            )
        }
        return UserPermissionProfile(
            userId = effective.optLong("userId").takeIf { it > 0 } ?: userId,
            effectiveRole = effective.optString("effectiveRole"),
            customRoleLabel = effective.nullableText("customRoleLabel"),
            customRoleInactive = effective.optBoolean("customRoleInactive"),
            modules = modules,
            individualOverrides = details.optJSONObject("permissionsOverride").toPermissionMap(),
        )
    }

    override suspend fun updateUserPermissions(userId: Long, overrides: Map<String, AccessLevel>) {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        api.mutate(
            "users.update",
            JSONObject().put("userId", userId).put(
                "permissionsOverride",
                if (overrides.isEmpty()) JSONObject.NULL else overrides.toJson(),
            ),
        )
    }

    override suspend fun resetUserPassword(userId: Long, temporaryPassword: String) {
        require(userId > 0 && temporaryPassword.isNotBlank()) { "بيانات إعادة التعيين غير صالحة" }
        api.mutate(
            "users.resetPassword",
            JSONObject()
                .put("userId", userId)
                .put("newPassword", temporaryPassword)
                .put("mustChangePassword", true),
        )
    }

    override suspend fun loadUserSessions(userId: Long): List<AdminUserSession> {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        return api.queryArray("users.sessions", JSONObject().put("userId", userId))
            .objects().mapNotNull(AdminMapper::session)
    }

    override suspend fun revokeUserSession(userId: Long, sessionId: Long) {
        require(userId > 0 && sessionId > 0) { "بيانات الجلسة غير صالحة" }
        api.mutate("users.revokeSession", JSONObject().put("userId", userId).put("sessionId", sessionId))
    }

    override suspend fun revokeAllUserSessions(userId: Long) {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        api.mutate("users.revokeSessions", JSONObject().put("userId", userId))
    }

    override suspend fun resetUserTwoFactor(userId: Long) {
        require(userId > 0) { "معرّف المستخدم غير صالح" }
        api.mutate("users.resetTwoFactor", JSONObject().put("userId", userId))
    }

    override suspend fun createRole(command: CreateAdminRoleCommand): Long {
        require(command.label.isNotBlank() && command.baseRole != "admin") { "بيانات الدور غير صالحة" }
        return api.mutate(
            "roles.create",
            JSONObject()
                .put("label", command.label.trim())
                .putNullable("description", command.description)
                .put("baseRole", command.baseRole)
                .put("permissions", command.permissions.toJson()),
        ).optLong("id").takeIf { it > 0 } ?: error("لم يُرجع الخادم معرّف الدور")
    }

    override suspend fun updateRole(command: UpdateAdminRoleCommand) {
        require(command.id > 0 && command.label.isNotBlank() && command.baseRole != "admin") {
            "بيانات الدور غير صالحة"
        }
        api.mutate(
            "roles.update",
            JSONObject()
                .put("id", command.id)
                .put("label", command.label.trim())
                .putNullable("description", command.description)
                .put("baseRole", command.baseRole)
                .put("permissions", command.permissions.toJson()),
        )
    }

    override suspend fun setRoleActive(roleId: Long, active: Boolean) {
        require(roleId > 0) { "معرّف الدور غير صالح" }
        api.mutate("roles.setActive", JSONObject().put("id", roleId).put("isActive", active))
    }

    private companion object {
        const val USER_LIMIT = 100
        const val SERVER_MAX_USERS = 500
        const val AUDIT_LIMIT = 50
    }
}

private fun JSONObject.toAdminUserPayload() = AdminUserPayload(
    id = optLong("id"),
    name = optString("name"),
    email = nullableText("email"),
    username = nullableText("username"),
    phone = nullableText("phone"),
    role = optString("role"),
    customRoleId = nullableLong("customRoleId"),
    customRoleLabel = nullableText("customRoleLabel"),
    branchId = nullableLong("branchId"),
    isActive = optBoolean("isActive"),
    isOwner = optBoolean("isOwner"),
    jobTitle = nullableText("jobTitle"),
    hiredAt = nullableText("hiredAt"),
    mustChangePassword = optBoolean("mustChangePassword"),
    lastSignedIn = nullableText("lastSignedIn"),
    createdAt = nullableText("createdAt"),
    effectiveStation = nullableText("effectiveStation"),
)

private fun JSONObject.toAdminRole(id: Long?, count: Int): AdminRole? {
    val key = optString("key")
    val label = optString("label")
    val baseRole = optString("baseRole")
    if (key.isBlank() || label.isBlank() || baseRole.isBlank()) return null
    return AdminRole(
        id = id,
        key = key,
        label = label,
        description = nullableText("description"),
        baseRole = baseRole,
        permissions = optJSONObject("permissions").toPermissionMap(),
        isSystem = optBoolean("isSystem"),
        isActive = optBoolean("isActive", true),
        userCount = count,
        canSeeCost = optBoolean("canSeeCost"),
    )
}

private fun JSONObject.toAdminBranch(): AdminBranch? {
    val id = optLong("id").takeIf { it > 0 } ?: return null
    return AdminBranch(id, optString("name"), optString("code"), optBoolean("isActive", true))
}

private fun JSONObject.toAdminAuditPayload() = AdminAuditPayload(
    id = optLong("id"),
    userId = nullableLong("userId"),
    userName = nullableText("userName"),
    branchId = nullableLong("branchId"),
    action = optString("action"),
    entityType = optString("entityType"),
    entityId = nullableLong("entityId"),
    oldFields = optJSONObject("oldValue").fieldNames(),
    newFields = optJSONObject("newValue").fieldNames(),
    ipAddress = nullableText("ipAddress"),
    createdAt = optString("createdAt"),
)

private fun JSONObject?.toPermissionMap(): Map<String, AccessLevel> = buildMap {
    val source = this@toPermissionMap ?: return@buildMap
    val keys = source.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        put(key, AccessLevel.fromApi(source.optString(key)))
    }
}

private fun JSONObject?.fieldNames(): Set<String> = buildSet {
    val source = this@fieldNames ?: return@buildSet
    val keys = source.keys()
    while (keys.hasNext()) add(keys.next())
}

private fun Map<String, AccessLevel>.toJson() = JSONObject().also { json ->
    forEach { (key, level) -> json.put(key, level.apiValue) }
}

private fun JSONObject.putAssignment(assignment: RoleAssignment): JSONObject = apply {
    when (assignment) {
        is RoleAssignment.BuiltIn -> {
            put("role", assignment.role)
            put("customRoleId", JSONObject.NULL)
        }
        is RoleAssignment.Custom -> {
            put("role", assignment.baseRole)
            put("customRoleId", assignment.roleId)
        }
    }
}

private fun JSONObject.putOptional(key: String, value: String?): JSONObject = apply {
    value?.trim()?.takeIf(String::isNotEmpty)?.let { put(key, it) }
}

private fun JSONObject.putNullable(key: String, value: Any?): JSONObject = apply {
    put(key, value ?: JSONObject.NULL)
}

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableLong(key: String): Long? =
    if (!has(key) || isNull(key)) null else optLong(key).takeIf { it > 0 }

private fun JSONArray?.objects(): List<JSONObject> = buildList {
    if (this@objects == null) return@buildList
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}
