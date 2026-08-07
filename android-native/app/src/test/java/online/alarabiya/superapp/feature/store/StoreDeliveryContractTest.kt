package online.alarabiya.superapp.feature.store

import online.alarabiya.superapp.model.store.CourierWorkspace
import online.alarabiya.superapp.model.store.PhoneSanitizer
import online.alarabiya.superapp.model.store.StoreCapabilities
import online.alarabiya.superapp.model.store.StoreMappers
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderFilter
import online.alarabiya.superapp.model.store.StoreOrderPolicy
import online.alarabiya.superapp.model.store.StoreOrderStatus
import online.alarabiya.superapp.model.store.StoreOrderSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreDeliveryContractTest {
    @Test
    fun `maps order list and detail without depending on JSONObject`() {
        val row = orderRow()

        val summary = StoreMappers.orders(listOf(row)).single()
        val detail = StoreMappers.orderDetail(
            row + mapOf(
                "branchId" to 7,
                "addressText" to "شارع فلسطين",
                "subtotal" to "46000.00",
                "deliveryPartyName" to "مندوب الكرخ",
                "items" to listOf(
                    mapOf(
                        "productName" to "حقيبة",
                        "variantLabel" to "أسود — كبير",
                        "unitName" to "قطعة",
                        "quantity" to "2",
                        "unitPrice" to "23000.00",
                        "total" to "46000.00",
                    ),
                ),
            ),
        )

        assertEquals(82L, summary.id)
        assertEquals(StoreOrderStatus.Confirmed, summary.status)
        assertEquals("أحمد", summary.customerName)
        assertEquals(7L, detail.branchId)
        assertEquals("مندوب الكرخ", detail.deliveryPartyName)
        assertEquals("حقيبة", detail.items.single().productName)
        assertEquals("2", detail.items.single().quantity)
        assertTrue(StoreMappers.orders(listOf(emptyMap<String, Any?>(), mapOf("id" to 0))).isEmpty())
    }

    @Test
    fun `maps courier workspace and keeps COD values`() {
        val workspace = StoreMappers.courierWorkspace(
            mapOf(
                "linked" to true,
                "partyName" to "مندوب الرصافة",
                "custodyBalance" to "120000.00",
                "toDeliver" to listOf(
                    mapOf(
                        "id" to 91,
                        "orderNumber" to "WEB-91",
                        "status" to "SHIPPED",
                        "customerName" to "سارة",
                        "customerPhone" to "07701234567",
                        "governorate" to "بغداد",
                        "address" to "المنصور",
                        "orderTotal" to "54000.00",
                        "codDue" to "50000.00",
                    ),
                ),
                "delivered" to emptyList<Any>(),
            ),
        )

        assertTrue(workspace.linked)
        assertEquals("120000.00", workspace.custodyBalance)
        assertEquals(StoreOrderStatus.Shipped, workspace.toDeliver.single().status)
        assertEquals("50000.00", workspace.toDeliver.single().codDue)
    }

    @Test
    fun `search filters only the currently loaded rows`() {
        val orders = listOf(
            summary(1, "WEB-100", "أحمد", "07701111111", "بغداد"),
            summary(2, "WEB-200", "ليلى", "07802222222", "البصرة"),
        )
        val base = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Orders,
            capabilities = StoreCapabilities.from("cashier", "READ", null),
            loading = false,
            orders = orders,
        )

        assertEquals(listOf(2L), StoreDeliveryStateFilter.orders(base.copy(filter = StoreOrderFilter(query = "البصرة"))).map { it.id })
        assertEquals(listOf(1L), StoreDeliveryStateFilter.orders(base.copy(filter = StoreOrderFilter(query = "1111"))).map { it.id })
        assertEquals(listOf(2L), StoreDeliveryStateFilter.orders(base.copy(filter = StoreOrderFilter(query = "web-200"))).map { it.id })
    }

    @Test
    fun `courier search is isolated to active or delivered tab`() {
        val active = courierWorkspace(delivered = false)
        val delivered = active.toDeliver.single().copy(id = 9, orderNumber = "WEB-DONE", status = StoreOrderStatus.Delivered)
        val workspace = active.copy(delivered = listOf(delivered))
        val base = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Courier,
            capabilities = StoreCapabilities.from("courier", null, "FULL"),
            loading = false,
            courier = workspace,
            filter = StoreOrderFilter(query = "WEB"),
        )

        assertEquals(listOf(4L), StoreDeliveryStateFilter.courierDeliveries(base).map { it.id })
        assertEquals(listOf(9L), StoreDeliveryStateFilter.courierDeliveries(base.copy(courierShowDelivered = true)).map { it.id })
    }

    @Test
    fun `permissions separate read fulfill dispatch and courier self service`() {
        val reader = StoreCapabilities.from("cashier", "READ", null)
        val fulfiller = StoreCapabilities.from("cashier", "FULL", null)
        val manager = StoreCapabilities.from("manager", "FULL", null)
        val courier = StoreCapabilities.from("courier", null, "FULL")

        assertTrue(reader.canReadOrders)
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Pending, reader).isEmpty())
        assertEquals(
            setOf(StoreOrderAction.StartProcessing, StoreOrderAction.Cancel),
            StoreOrderPolicy.allowedActions(StoreOrderStatus.Confirmed, fulfiller),
        )
        assertTrue(StoreOrderAction.Dispatch in StoreOrderPolicy.allowedActions(StoreOrderStatus.Confirmed, manager))
        assertFalse(StoreOrderAction.Dispatch in StoreOrderPolicy.allowedActions(StoreOrderStatus.Confirmed, fulfiller))
        assertEquals(
            setOf(StoreOrderAction.CourierDelivered, StoreOrderAction.CourierFailed),
            StoreOrderPolicy.allowedActions(StoreOrderStatus.Shipped, courier),
        )
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Delivered, courier).isEmpty())
    }

    @Test
    fun `phone sanitizer produces explicit safe call and whatsapp URIs`() {
        assertEquals("+9647701234567", PhoneSanitizer.normalizeIraqi("0770 123 4567"))
        assertEquals("+9647701234567", PhoneSanitizer.normalizeIraqi("٠٧٧٠-١٢٣-٤٥٦٧"))
        assertEquals("+9647701234567", PhoneSanitizer.normalizeIraqi("009647701234567"))
        assertEquals("tel:+9647701234567", StoreContactActions.callUri("07701234567"))
        assertEquals("https://wa.me/9647701234567", StoreContactActions.whatsappUri("+964 770 123 4567"))

        listOf(
            null,
            "",
            "12345",
            "0770;1234567",
            "0770,1234567",
            "0770#1234567",
            "0770abc4567",
            "+964770123456789012",
        ).forEach { unsafe ->
            assertNull(PhoneSanitizer.normalizeIraqi(unsafe))
            assertNull(StoreContactActions.callUri(unsafe))
            assertNull(StoreContactActions.whatsappUri(unsafe))
        }
    }

    @Test
    fun `terminal and financially sensitive transitions stay closed`() {
        val manager = StoreCapabilities.from("admin", "FULL", null)

        assertEquals(setOf(StoreOrderAction.MarkDelivered), StoreOrderPolicy.allowedActions(StoreOrderStatus.Shipped, manager))
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Delivered, manager).isEmpty())
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Cancelled, manager).isEmpty())
        assertEquals(StoreOrderStatus.Unknown, StoreOrderStatus.fromWire("FUTURE_SERVER_STATUS"))
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Unknown, manager).isEmpty())
    }

    private fun orderRow(): Map<String, Any?> = mapOf(
        "id" to 82,
        "orderNumber" to "WEB-82",
        "status" to "CONFIRMED",
        "customerName" to "أحمد",
        "customerPhone" to "07701234567",
        "governorate" to "بغداد",
        "total" to "50000.00",
        "deliveryFee" to "4000.00",
        "deliveryPartyId" to null,
        "cancelReason" to null,
        "itemCount" to 1,
        "createdAt" to "2026-08-06T10:00:00.000Z",
    )

    private fun summary(
        id: Long,
        number: String,
        name: String,
        phone: String,
        governorate: String,
    ) = StoreOrderSummary(
        id = id,
        orderNumber = number,
        status = StoreOrderStatus.Pending,
        customerName = name,
        customerPhone = phone,
        governorate = governorate,
        total = "0",
        deliveryFee = "0",
        deliveryPartyId = null,
        cancelReason = null,
        itemCount = 0,
        createdAt = null,
    )

    private fun courierWorkspace(delivered: Boolean): CourierWorkspace {
        val row = online.alarabiya.superapp.model.store.CourierDelivery(
            id = 4,
            orderNumber = "WEB-ACTIVE",
            status = if (delivered) StoreOrderStatus.Delivered else StoreOrderStatus.Shipped,
            customerName = "مريم",
            customerPhone = "07701234567",
            governorate = "بغداد",
            address = "الكرادة",
            orderTotal = "50000",
            codDue = "50000",
            createdAt = null,
        )
        return CourierWorkspace(true, "مندوب", "0", listOf(row), emptyList())
    }
}
