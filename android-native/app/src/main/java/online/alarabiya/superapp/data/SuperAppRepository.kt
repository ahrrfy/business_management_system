package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.core.security.SecureSessionStore
import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.AttendanceSummary
import online.alarabiya.superapp.model.EmployeeSummary
import online.alarabiya.superapp.model.LoginOutcome
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.ModuleMetric
import online.alarabiya.superapp.model.NotificationSummary
import online.alarabiya.superapp.model.PayrollSummary
import online.alarabiya.superapp.model.PersonalWorkspace
import online.alarabiya.superapp.model.TaskSummary
import online.alarabiya.superapp.model.TwoFactorSetup
import online.alarabiya.superapp.model.TwoFactorStatus
import online.alarabiya.superapp.model.UserIdentity
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.withTimeoutOrNull

class SuperAppRepository(
    private val api: TrpcClient,
    private val sessionStore: SecureSessionStore,
    private val beforeLogout: suspend () -> Boolean = { true },
) {
    @Volatile private var singleTenantContractConfirmed = false

    fun hasSession(): Boolean = !sessionStore.loadCookie().isNullOrBlank()
    fun isBiometricEnabled(): Boolean = sessionStore.isBiometricEnabled()
    fun setBiometricEnabled(enabled: Boolean) = sessionStore.setBiometricEnabled(enabled)

    fun cachedUserName(): String? = sessionStore.loadUserSnapshot()?.let {
        runCatching { JSONObject(it).optString("name") }.getOrNull()
    }?.takeIf { it.isNotBlank() }

    fun cachedUser(): UserIdentity? = sessionStore.loadUserSnapshot()?.let { snapshot ->
        runCatching { parseLoginUser(JSONObject(snapshot)) }.getOrNull()
    }

    suspend fun verifyRuntimeContract() = ensureSingleTenantContract()

    suspend fun login(identifier: String, password: String, remember: Boolean): LoginOutcome {
        ensureSingleTenantContract()
        val json = api.mutate(
            "auth.login",
            JSONObject()
                .put("identifier", identifier.trim())
                .put("password", password)
                .put("remember", remember),
        )
        if (json.optBoolean("requiresTwoFactor")) {
            return LoginOutcome.TwoFactorRequired(json.getString("ticket"))
        }
        return LoginOutcome.Success(parseLoginUser(json).also(::cacheUser))
    }

    suspend fun currentUser(): UserIdentity = parseLoginUser(api.query("auth.me")).also(::cacheUser)

    suspend fun changePassword(oldPassword: String, newPassword: String) {
        api.mutate(
            "auth.changePassword",
            JSONObject()
                .put("oldPassword", oldPassword)
                .put("newPassword", newPassword),
        )
    }

    suspend fun getTwoFactorStatus(): TwoFactorStatus {
        val item = api.query("auth.twoFactorStatus")
        return TwoFactorStatus(
            enabled = item.optBoolean("enabled"),
            pending = item.optBoolean("pending"),
            recoveryCodesRemaining = item.optInt("recoveryCodesRemaining"),
            cryptoReady = item.optBoolean("cryptoReady"),
        )
    }

    suspend fun startTwoFactorEnrollment(password: String): TwoFactorSetup {
        val item = api.mutate(
            "auth.twoFactorSetupStart",
            JSONObject().put("password", password),
        )
        return TwoFactorSetup(
            secretBase32 = item.getString("secretB32"),
            otpauthUri = item.getString("otpauthUri"),
        )
    }

    suspend fun confirmTwoFactorEnrollment(code: String): List<String> {
        val item = api.mutate(
            "auth.twoFactorSetupConfirm",
            JSONObject().put("code", code.trim()),
        )
        val codes = item.optJSONArray("recoveryCodes") ?: return emptyList()
        return buildList {
            for (index in 0 until codes.length()) {
                codes.optString(index).takeIf { it.isNotBlank() }?.let(::add)
            }
        }
    }

    suspend fun verifyTwoFactor(ticket: String, code: String): LoginOutcome.Success {
        val clean = code.trim()
        val input = JSONObject().put("ticket", ticket)
        if (clean.length == 6 && clean.all(Char::isDigit)) input.put("code", clean)
        else input.put("recoveryCode", clean)
        val user = parseLoginUser(api.mutate("auth.twoFactorVerify", input))
        cacheUser(user)
        return LoginOutcome.Success(user)
    }

    suspend fun loadBootstrap(): AppBootstrap {
        val root = api.query("superApp.bootstrap")
        val bootstrap = parseBootstrap(root)
        sessionStore.saveBootstrapSnapshot(
            CachedSnapshotPolicy.envelope(root, System.currentTimeMillis()).toString(),
        )
        return bootstrap
    }

    private fun parseBootstrap(root: JSONObject): AppBootstrap {
        val userJson = root.getJSONObject("user")
        val user = UserIdentity(
            id = userJson.getLong("id"),
            name = userJson.optString("name"),
            username = null,
            email = null,
            role = userJson.getString("role"),
            roleLabel = userJson.optString("roleLabel", userJson.getString("role")),
        )
        cacheUser(user)
        val scope = root.optJSONObject("scope") ?: JSONObject()
        val capabilities = root.optJSONObject("capabilities") ?: JSONObject()
        return AppBootstrap(
            user = user,
            modules = root.optJSONArray("modules").objects().map { item ->
                ModuleAccess(
                    key = item.getString("key"),
                    label = item.getString("label"),
                    access = item.getString("access"),
                )
            },
            branchId = scope.nullableLong("branchId"),
            allBranches = scope.optBoolean("allBranches"),
            hasPersonalWorkspace = capabilities.optBoolean("hasPersonalWorkspace", false),
        )
    }

    suspend fun loadWorkspace(): PersonalWorkspace {
        val root = api.query("superApp.myWorkspace")
        val workspace = parseWorkspace(root)
        val userId = cachedUser()?.id
        if (userId != null) {
            sessionStore.saveWorkspaceSnapshot(
                CachedSnapshotPolicy.envelope(root, System.currentTimeMillis(), userId).toString(),
            )
        }
        return workspace
    }

    fun loadCachedHome(): Pair<AppBootstrap, PersonalWorkspace>? {
        val bootstrapEnvelope = sessionStore.loadBootstrapSnapshot()?.let { snapshot ->
            runCatching { JSONObject(snapshot) }.getOrNull()
        } ?: return null
        if (!CachedSnapshotPolicy.isFresh(bootstrapEnvelope, System.currentTimeMillis())) return null
        val bootstrapRoot = bootstrapEnvelope.optJSONObject("payload") ?: return null
        val bootstrap = runCatching { parseBootstrap(bootstrapRoot) }.getOrNull() ?: return null
        val workspaceEnvelope = sessionStore.loadWorkspaceSnapshot()?.let { snapshot ->
            runCatching { JSONObject(snapshot) }.getOrNull()
        } ?: return null
        if (!CachedSnapshotPolicy.isFresh(workspaceEnvelope, System.currentTimeMillis())) return null
        if (!CachedSnapshotPolicy.belongsTo(workspaceEnvelope, bootstrap.user.id)) return null
        val workspaceRoot = workspaceEnvelope.optJSONObject("payload") ?: return null
        val workspace = runCatching { parseWorkspace(workspaceRoot) }.getOrNull() ?: return null
        return bootstrap to workspace
    }

    private fun parseWorkspace(root: JSONObject): PersonalWorkspace {
        val employee = root.optJSONObject("employee")?.let { item ->
            EmployeeSummary(
                name = item.optString("name"),
                position = item.nullableString("position"),
                department = item.nullableString("department"),
                email = item.nullableString("email"),
                phone = item.nullableString("phone"),
                annualLeaveBalance = item.optString("annualLeaveBalance", "0"),
                sickLeaveBalance = item.optString("sickLeaveBalance", "0"),
            )
        }
        val attendance = root.optJSONObject("attendance")?.let { item ->
            AttendanceSummary(
                date = item.optString("date", root.optString("date")),
                checkIn = item.nullableString("checkIn"),
                checkOut = item.nullableString("checkOut"),
                status = item.nullableString("status"),
                needsReview = item.optBoolean("needsReview"),
            )
        }
        val payroll = root.optJSONObject("latestPayroll")?.let { item ->
            PayrollSummary(
                period = item.optString("period"),
                status = item.optString("status"),
                gross = item.optString("gross", "0"),
                deductions = item.optString("deductions", "0"),
                net = item.optString("net", "0"),
            )
        }
        return PersonalWorkspace(
            date = root.optString("date"),
            employee = employee,
            attendance = attendance,
            tasks = root.optJSONArray("tasks").objects().map { item ->
                TaskSummary(
                    id = item.getLong("id"),
                    number = item.optString("taskNumber"),
                    title = item.optString("title"),
                    priority = item.optString("priority"),
                    status = item.optString("status"),
                    dueAt = item.nullableString("dueAt"),
                )
            },
            notifications = root.optJSONArray("notifications").objects().map { item ->
                NotificationSummary(
                    id = item.optString("id"),
                    kind = item.optString("kind"),
                    title = item.optString("title"),
                    body = item.optString("body"),
                    createdAt = item.optString("createdAt"),
                    requiresAction = item.optBoolean("requiresAction"),
                )
            },
            payroll = payroll,
        )
    }

    suspend fun loadModuleMetrics(moduleKey: String): List<ModuleMetric> {
        val root = api.query("superApp.modulePulse", JSONObject().put("moduleKey", moduleKey))
        return root.optJSONArray("metrics").objects().map { item ->
            ModuleMetric(
                key = item.optString("key"),
                label = item.optString("label"),
                value = item.optDouble("value", 0.0),
                format = item.optString("format", "count"),
            )
        }
    }

    suspend fun logout() {
        try {
            withTimeoutOrNull(5_000) { beforeLogout() }
            runCatching { api.mutate("auth.logout") }
        } finally {
            api.clearSession()
        }
    }

    fun clearLocalSession() = api.clearSession()

    private fun parseLoginUser(item: JSONObject) = UserIdentity(
        id = item.getLong("id"),
        name = item.optString("name"),
        username = item.nullableString("username"),
        email = item.nullableString("email"),
        role = item.optString("role"),
        roleLabel = item.optString("roleLabel", item.optString("role")),
        mustChangePassword = item.optBoolean("mustChangePassword"),
        mustEnrollTwoFactor = when {
            item.has("mustEnrollTwoFactor") -> item.optBoolean("mustEnrollTwoFactor")
            else -> item.optBoolean("mustEnroll2FA")
        },
    )

    private fun cacheUser(user: UserIdentity) {
        sessionStore.saveUserSnapshot(
            JSONObject()
                .put("id", user.id)
                .put("name", user.name)
                .put("username", user.username ?: JSONObject.NULL)
                .put("email", user.email ?: JSONObject.NULL)
                .put("role", user.role)
                .put("roleLabel", user.roleLabel)
                .put("mustChangePassword", user.mustChangePassword)
                .put("mustEnrollTwoFactor", user.mustEnrollTwoFactor)
                .toString(),
        )
    }

    private suspend fun ensureSingleTenantContract() {
        if (singleTenantContractConfirmed) return
        val mode = api.query("auth.tenancyMode")
        val multiTenant = mode.optBoolean("multiTenant", true)
        val explicitMode = mode.optString("mode")
        if (multiTenant || (explicitMode.isNotBlank() && explicitMode != "single")) {
            throw ApiException(
                message = "هذا الإصدار مخصص لبيئة شركة واحدة. حدّث التطبيق أو راجع مسؤول النظام.",
                code = "PRECONDITION_FAILED",
                appCode = "UNSUPPORTED_TENANCY_MODE",
            )
        }
        singleTenantContractConfirmed = true
    }
}

internal object CachedSnapshotPolicy {
    private const val MAX_AGE_MS = 24L * 60L * 60L * 1_000L
    private const val CLOCK_SKEW_MS = 5L * 60L * 1_000L

    fun envelope(payload: JSONObject, savedAt: Long, userId: Long? = null): JSONObject =
        JSONObject()
            .put("savedAt", savedAt)
            .put("payload", payload)
            .also { value -> if (userId != null) value.put("userId", userId) }

    fun isFresh(envelope: JSONObject, now: Long): Boolean {
        val savedAt = envelope.optLong("savedAt", -1L)
        if (savedAt <= 0L || savedAt > now + CLOCK_SKEW_MS) return false
        return now - savedAt <= MAX_AGE_MS
    }

    fun belongsTo(envelope: JSONObject, userId: Long): Boolean =
        envelope.optLong("userId", -1L) == userId
}

private fun JSONArray?.objects(): List<JSONObject> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) optJSONObject(index)?.let(::add)
    }
}

private fun JSONObject.nullableString(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

private fun JSONObject.nullableLong(key: String): Long? =
    if (isNull(key) || !has(key)) null else optLong(key)
