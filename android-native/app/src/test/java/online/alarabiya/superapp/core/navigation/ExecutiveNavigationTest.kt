package online.alarabiya.superapp.core.navigation

import online.alarabiya.superapp.model.ExecutiveDestinationKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ExecutiveNavigationTest {
    @Test
    fun `operational decisions retain arguments and open exact native workspaces`() {
        val cases = listOf(
            Triple(
                ExecutiveDestinationKey.PRODUCTS to mapOf("stockState" to "low"),
                NativeDestination.Module(NativeModule.INVENTORY),
                "stockState" to "low",
            ),
            Triple(
                ExecutiveDestinationKey.RECEIVABLES to mapOf("bucket" to "ar-60"),
                NativeDestination.Receivables,
                "bucket" to "ar-60",
            ),
            Triple(
                ExecutiveDestinationKey.WORK_ORDERS to mapOf("overdue" to "true"),
                NativeDestination.WorkOrders,
                "overdue" to "true",
            ),
            Triple(
                ExecutiveDestinationKey.PURCHASING to mapOf("view" to "payables"),
                NativeDestination.Module(NativeModule.PURCHASES),
                "view" to "payables",
            ),
        )

        cases.forEach { (input, destination, retained) ->
            val request = ExecutiveNavigation.request(input.first, input.second)
            assertEquals(destination, request.destination)
            assertEquals(retained.second, request.arguments[retained.first])
        }
    }

    @Test
    fun `dead stock remains on insights because no native last sale filter exists`() {
        val request = ExecutiveNavigation.request(
            ExecutiveDestinationKey.PRODUCTS,
            mapOf("stockState" to "dead"),
        )

        assertEquals(NativeDestination.Insights, request.destination)
        assertEquals("dead-stock", request.arguments["focus"])
        assertEquals("managementAlerts", request.arguments["section"])
    }

    @Test
    fun `shift variance opens the native shift ledger and never degrades to pos sales`() {
        val request = ExecutiveNavigation.request(
            ExecutiveDestinationKey.SHIFTS,
            mapOf("variance" to "true"),
        )

        assertEquals(NativeDestination.Shifts, request.destination)
        assertEquals("true", request.arguments["variance"])
        assertFalse(request.destination == NativeDestination.Module(NativeModule.POS))
    }

    @Test
    fun `task overdue filter stays attached to the native task destination`() {
        val request = ExecutiveNavigation.request(
            ExecutiveDestinationKey.TASKS,
            mapOf("overdue" to "true", "untrusted" to "ignored"),
        )

        assertEquals(NativeDestination.Tasks, request.destination)
        assertEquals(mapOf("overdue" to "true"), request.arguments)
    }

    @Test
    fun `unfiltered module decisions keep their native module destinations`() {
        assertEquals(
            NativeDestination.Module(NativeModule.PRODUCTS),
            ExecutiveNavigation.request(ExecutiveDestinationKey.PRODUCTS, emptyMap()).destination,
        )
        assertEquals(
            NativeDestination.Receivables,
            ExecutiveNavigation.request(ExecutiveDestinationKey.RECEIVABLES, emptyMap()).destination,
        )
        assertEquals(
            NativeDestination.WorkOrders,
            ExecutiveNavigation.request(ExecutiveDestinationKey.WORK_ORDERS, emptyMap()).destination,
        )
    }

    @Test
    fun `server supplied arguments are allowlisted and bounded`() {
        val request = ExecutiveNavigation.request(
            ExecutiveDestinationKey.INSIGHTS,
            mapOf(
                "section" to " anomalies ",
                "focus" to "x".repeat(100),
                "redirect" to "https://example.invalid",
            ),
        )

        assertEquals("anomalies", request.arguments["section"])
        assertEquals(64, request.arguments.getValue("focus").length)
        assertFalse("redirect" in request.arguments)
    }
}
