package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import org.json.JSONObject

data class TwoFactorAccountStatus(
    val enabled: Boolean,
    val pending: Boolean,
    val recoveryCodesRemaining: Int,
    val cryptoReady: Boolean,
)

data class TwoFactorEnrollment(
    val secretBase32: String,
    val otpauthUri: String,
)

interface TwoFactorDataSource {
    suspend fun status(): TwoFactorAccountStatus
    suspend fun startEnrollment(password: String): TwoFactorEnrollment
    suspend fun confirmEnrollment(code: String): List<String>
    suspend fun regenerateRecoveryCodes(password: String, code: String): List<String>
    suspend fun disable(password: String, verification: TwoFactorVerification)
}

sealed interface TwoFactorVerification {
    data class AuthenticatorCode(val value: String) : TwoFactorVerification
    data class RecoveryCode(val value: String) : TwoFactorVerification
}

class TwoFactorRepository(private val api: TrpcClient) : TwoFactorDataSource {
    override suspend fun status(): TwoFactorAccountStatus =
        TwoFactorJson.status(api.query("auth.twoFactorStatus"))

    override suspend fun startEnrollment(password: String): TwoFactorEnrollment =
        TwoFactorJson.enrollment(
            api.mutate("auth.twoFactorSetupStart", JSONObject().put("password", password)),
        )

    override suspend fun confirmEnrollment(code: String): List<String> =
        TwoFactorJson.recoveryCodes(
            api.mutate(
                "auth.twoFactorSetupConfirm",
                JSONObject().put("code", code.trim()),
            ),
        )

    override suspend fun regenerateRecoveryCodes(password: String, code: String): List<String> =
        TwoFactorJson.recoveryCodes(
            api.mutate(
                "auth.twoFactorRegenerateCodes",
                JSONObject().put("password", password).put("code", code.trim()),
            ),
        )

    override suspend fun disable(password: String, verification: TwoFactorVerification) {
        val input = JSONObject().put("password", password)
        when (verification) {
            is TwoFactorVerification.AuthenticatorCode -> input.put("code", verification.value.trim())
            is TwoFactorVerification.RecoveryCode -> input.put("recoveryCode", verification.value.trim())
        }
        api.mutate("auth.twoFactorDisable", input)
    }
}

internal object TwoFactorJson {
    fun status(item: JSONObject) = TwoFactorAccountStatus(
        enabled = item.optBoolean("enabled"),
        pending = item.optBoolean("pending"),
        recoveryCodesRemaining = item.optInt("recoveryCodesRemaining").coerceAtLeast(0),
        cryptoReady = item.optBoolean("cryptoReady"),
    )

    fun enrollment(item: JSONObject) = TwoFactorEnrollment(
        secretBase32 = item.getString("secretB32"),
        otpauthUri = item.getString("otpauthUri"),
    )

    fun recoveryCodes(item: JSONObject): List<String> {
        val values = item.optJSONArray("recoveryCodes") ?: return emptyList()
        return buildList {
            repeat(values.length()) { index ->
                values.optString(index).trim().takeIf(String::isNotEmpty)?.let(::add)
            }
        }
    }
}
