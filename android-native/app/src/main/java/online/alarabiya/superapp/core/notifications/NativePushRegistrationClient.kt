package online.alarabiya.superapp.core.notifications

import online.alarabiya.superapp.BuildConfig
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.core.security.DeviceProofKey
import org.json.JSONObject

class NativePushRegistrationClient(private val client: TrpcClient) {
    suspend fun register(installationId: String, deviceKeyThumbprint: String) {
        client.mutate(
            "nativePush.register",
            JSONObject()
                .put("installationId", installationId)
                .put("devicePublicKeyHash", deviceKeyThumbprint)
                .put("environment", BuildConfig.ENVIRONMENT)
                .put("appVersion", BuildConfig.VERSION_NAME),
        )
    }

    suspend fun revokeDevice(deviceKeyThumbprint: String = DeviceProofKey().publicKeyThumbprint()) {
        client.mutate(
            "nativePush.revokeDevice",
            JSONObject().put("devicePublicKeyHash", deviceKeyThumbprint),
        )
    }
}
