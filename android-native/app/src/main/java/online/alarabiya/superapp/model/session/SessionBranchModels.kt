package online.alarabiya.superapp.model.session

import online.alarabiya.superapp.model.AppBootstrap

/** A server-authorized branch that may be selected for this signed-in session. */
data class SessionBranch(
    val id: Long,
    val name: String,
    val code: String? = null,
)

enum class BranchDirectoryStatus {
    NOT_REQUIRED,
    IDLE,
    LOADING,
    READY,
    FAILED,
}

/**
 * Identity of the authority scope that owns an in-memory branch selection.
 *
 * It deliberately contains no persisted preference. A logout removes the composition that owns
 * this value, while any user/authority change creates a different key and therefore a fresh scope.
 */
data class SessionBranchPrincipal(
    val userId: Long,
    val role: String,
    val fixedBranchId: Long?,
    val allBranches: Boolean,
    val isOwner: Boolean,
    val authorityFingerprint: String,
) {
    val canSelectBranch: Boolean
        get() = allBranches && fixedBranchId == null &&
            (isOwner || role.equals("admin", ignoreCase = true))

    companion object {
        fun fromBootstrap(bootstrap: AppBootstrap): SessionBranchPrincipal = SessionBranchPrincipal(
            userId = bootstrap.user.id,
            role = bootstrap.user.role,
            fixedBranchId = bootstrap.branchId?.takeIf { it > 0 },
            allBranches = bootstrap.allBranches,
            isOwner = bootstrap.isOwner || bootstrap.user.isOwner,
            authorityFingerprint = bootstrap.modules
                .sortedBy { it.key }
                .joinToString(separator = "|") { "${it.key}:${it.access}" },
        )
    }
}

/**
 * Session-only branch context. The selected id can only come from the latest server directory.
 * No first-row/default fallback is ever applied, so branch-required operations remain fail-closed.
 */
data class SessionBranchContext(
    val principal: SessionBranchPrincipal,
    val branches: List<SessionBranch> = emptyList(),
    val selectedBranchId: Long? = principal.fixedBranchId,
    val directoryStatus: BranchDirectoryStatus = if (principal.canSelectBranch) {
        BranchDirectoryStatus.IDLE
    } else {
        BranchDirectoryStatus.NOT_REQUIRED
    },
    val error: String? = null,
) {
    val effectiveBranchId: Long?
        get() = principal.fixedBranchId ?: selectedBranchId.takeIf { principal.canSelectBranch }

    val requiresExplicitSelection: Boolean
        get() = principal.canSelectBranch && effectiveBranchId == null

    val selectedBranch: SessionBranch?
        get() = effectiveBranchId?.let { id -> branches.firstOrNull { it.id == id } }

    fun loading(): SessionBranchContext = if (!principal.canSelectBranch) this else copy(
        directoryStatus = BranchDirectoryStatus.LOADING,
        error = null,
    )

    fun loaded(serverBranches: List<SessionBranch>): SessionBranchContext {
        if (!principal.canSelectBranch) return this
        val authorized = serverBranches.asSequence()
            .filter { it.id > 0 && it.name.isNotBlank() }
            .distinctBy { it.id }
            .map { it.copy(name = it.name.trim(), code = it.code?.trim()?.takeIf(String::isNotEmpty)) }
            .toList()
        val retained = selectedBranchId?.takeIf { selected -> authorized.any { it.id == selected } }
        return copy(
            branches = authorized,
            selectedBranchId = retained,
            directoryStatus = BranchDirectoryStatus.READY,
            error = null,
        )
    }

    fun failed(message: String): SessionBranchContext = if (!principal.canSelectBranch) this else copy(
        branches = emptyList(),
        selectedBranchId = null,
        directoryStatus = BranchDirectoryStatus.FAILED,
        error = message.trim().takeIf(String::isNotEmpty) ?: "تعذر تحميل الفروع",
    )

    fun select(branchId: Long): SessionBranchContext {
        if (!principal.canSelectBranch) return this
        if (branches.none { it.id == branchId }) {
            return copy(selectedBranchId = null, error = "الفرع غير متاح لهذه الجلسة")
        }
        return copy(selectedBranchId = branchId, error = null)
    }

    fun resetFor(bootstrap: AppBootstrap): SessionBranchContext {
        val next = SessionBranchPrincipal.fromBootstrap(bootstrap)
        return if (next == principal) this else initial(bootstrap)
    }

    companion object {
        fun initial(bootstrap: AppBootstrap): SessionBranchContext = SessionBranchContext(
            principal = SessionBranchPrincipal.fromBootstrap(bootstrap),
        )
    }
}
