package online.alarabiya.securetransport

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class AlrueyaSecureTransportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AlrueyaSecureTransport")

    AsyncFunction("getOrCreateDeviceKey") {
      descriptor(keyStore().getOrCreate())
    }

    AsyncFunction("getDeviceKeyStatus") {
      mapOf(
        "keyExists" to keyStore().exists(),
        "keyAliasVersion" to KEY_ALIAS_VERSION,
        "algorithm" to ALGORITHM,
        "storage" to "android-keystore",
      )
    }

    AsyncFunction("createRegistrationProof") { ticket: String ->
      val store = keyStore()
      val key = store.signRegistration(ticket)
      descriptor(key) + mapOf(
        "signatureDerBase64Url" to Base64Url.encode(store.signatureForRegistration(key, ticket)),
      )
    }

    AsyncFunction("deleteDeviceKey") {
      mapOf(
        "deleted" to keyStore().delete(),
        "keyAliasVersion" to KEY_ALIAS_VERSION,
      )
    }

    AsyncFunction("getSecureTransportStatus") {
      transport().status()
    }

    /** A native CSPRNG UUID used only as an idempotency key for named commands. */
    AsyncFunction("createMobileRequestId") {
      UUID.randomUUID().toString()
    }

    AsyncFunction("login") { identifier: String, password: String, remember: Boolean, companyCode: String? ->
      transport().login(identifier, password, remember, companyCode)
    }

    AsyncFunction("verifyTwoFactor") { ticket: String, code: String?, recoveryCode: String? ->
      transport().verifyTwoFactor(ticket, code, recoveryCode)
    }

    AsyncFunction("getMobileToday") {
      transport().mobileToday()
    }

    AsyncFunction("getMobileAttendanceHistory") {
      transport().mobileAttendanceHistory()
    }

    AsyncFunction("revealMobilePayslip") { code: String?, recoveryCode: String? ->
      transport().mobilePayslipReveal(code, recoveryCode)
    }

    AsyncFunction("requestMobileLeave") { leaveType: String, fromDate: String, toDate: String, reason: String?, clientRequestId: String ->
      transport().mobileRequestLeave(leaveType, fromDate, toDate, reason, clientRequestId)
    }

    AsyncFunction("withdrawLatestMobileLeave") { clientRequestId: String ->
      transport().mobileWithdrawLatestLeave(clientRequestId)
    }

    AsyncFunction("startFocusedMobileTask") { clientRequestId: String ->
      transport().mobileStartFocusedTask(clientRequestId)
    }

    AsyncFunction("resolveFocusedMobileTask") { resolutionNote: String?, clientRequestId: String ->
      transport().mobileResolveFocusedTask(resolutionNote, clientRequestId)
    }

    AsyncFunction("getMobileCommandCenter") {
      transport().mobileCommandCenter()
    }

    AsyncFunction("getMobileExpoPushStatus") {
      transport().mobileExpoPushStatus()
    }

    AsyncFunction("registerMobileExpoPush") { expoPushToken: String, platform: String, environment: String, appVersion: String ->
      transport().mobileRegisterExpoPush(expoPushToken, platform, environment, appVersion)
    }

    AsyncFunction("revokeMobileExpoPush") {
      transport().mobileRevokeExpoPush()
    }

    AsyncFunction("logout") {
      transport().logout()
      mapOf("cleared" to true)
    }
  }

  private fun keyStore(): AndroidDeviceProofKeyStore = AndroidDeviceProofKeyStore(context)

  private fun transport(): NativeTrpcTransport = NativeTrpcTransport(context)

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun descriptor(key: AndroidDeviceProofKey): Map<String, String> {
    val keyThumbprint = DeviceProofEncoding.sha256Base64Url(key.publicKeySpki)
    return mapOf(
      "keyId" to keyThumbprint,
      "keyThumbprint" to keyThumbprint,
      "publicKeySpkiBase64Url" to Base64Url.encode(key.publicKeySpki),
      "algorithm" to ALGORITHM,
      "clientId" to DeviceProofEncoding.CLIENT_ID,
      "clientVersion" to DeviceProofEncoding.CLIENT_VERSION,
      "proofVersion" to DeviceProofEncoding.PROOF_VERSION,
    )
  }

  private companion object {
    const val KEY_ALIAS_VERSION = "device-proof-v1"
    const val ALGORITHM = "ES256"
  }
}
