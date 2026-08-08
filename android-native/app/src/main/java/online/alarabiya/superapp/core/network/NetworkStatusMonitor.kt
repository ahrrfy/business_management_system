package online.alarabiya.superapp.core.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

object NetworkStatusMonitor {
    fun isCurrentlyAvailable(context: Context): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
        return isUsable(manager.getNetworkCapabilities(manager.activeNetwork))
    }

    fun observe(context: Context): Flow<Boolean> = callbackFlow {
        val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
        if (manager == null) {
            trySend(false)
            close()
            return@callbackFlow
        }

        fun publish() {
            trySend(isUsable(manager.getNetworkCapabilities(manager.activeNetwork)))
        }

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = publish()
            override fun onLost(network: Network) = publish()
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = publish()
        }

        publish()
        runCatching { manager.registerDefaultNetworkCallback(callback) }
            .onFailure {
                trySend(false)
                close(it)
            }
        awaitClose { runCatching { manager.unregisterNetworkCallback(callback) } }
    }.distinctUntilChanged()

    private fun isUsable(capabilities: NetworkCapabilities?): Boolean = isUsable(
        hasInternet = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
        validated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
    )

    internal fun isUsable(hasInternet: Boolean, validated: Boolean): Boolean = hasInternet && validated
}
