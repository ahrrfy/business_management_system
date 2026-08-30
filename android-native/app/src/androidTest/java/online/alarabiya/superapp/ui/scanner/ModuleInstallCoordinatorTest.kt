package online.alarabiya.superapp.ui.scanner

import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.common.Feature
import com.google.android.gms.common.api.OptionalModuleApi
import com.google.android.gms.common.moduleinstall.ModuleAvailabilityResponse
import com.google.android.gms.common.testing.FakeModuleInstallClient
import com.google.android.gms.common.testing.FakeModuleInstallUtil
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModuleInstallCoordinatorTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val api = object : OptionalModuleApi {
        override fun getOptionalFeatures(): Array<Feature> = arrayOf(Feature("scanner-test-module", 1L))
    }

    @Test
    fun alreadyInstalledModuleSkipsInstallRequest() = runBlocking {
        val client = FakeModuleInstallClient(context).apply { setInstalledModules(api) }

        ensureOptionalModuleInstalled(client, api, timeoutMs = 1_000)

        assertEquals(0, client.installModulesRequestCount.await())
    }

    @Test
    fun missingModuleRequestsImmediateInstall() = runBlocking {
        val client = FakeModuleInstallClient(context).apply {
            setInstallModulesTask(Tasks.forResult(FakeModuleInstallUtil.ALREADY_INSTALLED_RESPONSE))
        }

        ensureOptionalModuleInstalled(client, api, timeoutMs = 1_000)

        assertEquals(1, client.installModulesRequestCount.await())
    }

    @Test
    fun stalledAvailabilityCheckTimesOut() = runBlocking {
        val neverCompletes = TaskCompletionSource<ModuleAvailabilityResponse>()
        val client = FakeModuleInstallClient(context).apply {
            setModulesAvailabilityTask(neverCompletes.task)
        }

        val failure = runCatching {
            ensureOptionalModuleInstalled(client, api, timeoutMs = 25)
        }.exceptionOrNull()

        assertTrue(failure is TimeoutCancellationException)
    }

    @Test
    fun installFailureIsPropagatedForRetryUi() = runBlocking {
        val client = FakeModuleInstallClient(context).apply {
            setInstallModulesTask(Tasks.forException(IllegalStateException("install failed")))
        }

        val failure = runCatching {
            ensureOptionalModuleInstalled(client, api, timeoutMs = 1_000)
        }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
    }
}
