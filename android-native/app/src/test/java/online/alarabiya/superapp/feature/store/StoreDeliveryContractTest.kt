package online.alarabiya.superapp.feature.store

import online.alarabiya.superapp.model.store.CourierWorkspace
import online.alarabiya.superapp.model.store.DeliveryMoney
import online.alarabiya.superapp.model.store.DeliveryPartyAccount
import online.alarabiya.superapp.model.store.DeliveryPartyDraft
import online.alarabiya.superapp.model.store.DeliveryPartyType
import online.alarabiya.superapp.model.store.DeliveryWriteOffDraft
import online.alarabiya.superapp.model.store.PhoneSanitizer
import online.alarabiya.superapp.model.store.StoreCapabilities
import online.alarabiya.superapp.model.store.StoreMappers
import online.alarabiya.superapp.model.store.StoreOrderAction
import online.alarabiya.superapp.model.store.StoreOrderFilter
import online.alarabiya.superapp.model.store.StoreOrderDetail
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
    fun `maps delivery party debt and courier accounts without floating point conversion`() {
        val party = StoreMappers.managedParties(
            listOf(
                mapOf(
                    "id" to 12,
                    "partyType" to "COMPANY",
                    "name" to "النخبة للتوصيل",
                    "phone" to "07701234567",
                    "branchId" to 3,
                    "defaultFee" to "3500.25",
                    "currentBalance" to "9007199254740993.99",
                    "floatLimit" to "10000000000000000.00",
                    "isActive" to true,
                    "openConsignments" to 4,
                ),
            ),
        ).single()
        val account = StoreMappers.courierAccounts(
            listOf(mapOf("id" to 8, "name" to "مندوب الكرخ", "username" to "courier8", "linkedPartyId" to 12)),
        ).single()

        assertEquals(DeliveryPartyType.Company, party.partyType)
        assertEquals("9007199254740993.99", party.currentBalance)
        assertEquals(4, party.openConsignments)
        assertEquals(12L, account.linkedPartyId)
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
        assertFalse(reader.canManageDeliveryParties)
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Pending, reader).isEmpty())
        assertEquals(
            setOf(StoreOrderAction.StartProcessing, StoreOrderAction.Cancel),
            StoreOrderPolicy.allowedActions(StoreOrderStatus.Confirmed, fulfiller),
        )
        assertTrue(StoreOrderAction.Dispatch in StoreOrderPolicy.allowedActions(StoreOrderStatus.Confirmed, manager))
        assertTrue(manager.canManageDeliveryParties)
        assertTrue(manager.canWriteOffDeliveryDebt)
        assertFalse(StoreOrderAction.Dispatch in StoreOrderPolicy.allowedActions(StoreOrderStatus.Confirmed, fulfiller))
        assertEquals(
            setOf(StoreOrderAction.CourierDelivered, StoreOrderAction.CourierFailed),
            StoreOrderPolicy.allowedActions(StoreOrderStatus.Shipped, courier),
        )
        assertTrue(StoreOrderPolicy.allowedActions(StoreOrderStatus.Delivered, courier).isEmpty())
        assertFalse(courier.canManageDeliveryParties)
    }

    @Test
    fun `party writes stay closed until a successful manager load`() {
        val capabilities = StoreCapabilities.from("manager", "FULL", null)
        val initial = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Parties,
            capabilities = capabilities,
            loading = false,
        )
        assertFalse(canMutateDeliveryParties(initial))
        val fresh = initial.copy(partyCatalogReady = true, freshModes = setOf(StoreDeliveryMode.Parties))
        assertFalse(canMutateDeliveryParties(initial.copy(partyCatalogReady = true)))
        assertTrue(canMutateDeliveryParties(fresh))
        assertFalse(canMutateDeliveryParties(fresh.copy(loading = true)))
        assertFalse(canMutateDeliveryParties(fresh.copy(busyPartyAction = "party:update")))
        assertFalse(
            canMutateDeliveryParties(
                fresh.copy(capabilities = StoreCapabilities.from("cashier", "FULL", null)),
            ),
        )
    }

    @Test
    fun `order actions require a fresh matching detail and commit terminal state before refresh`() {
        val capabilities = StoreCapabilities.from("manager", "FULL", null)
        val order = summary(7, "WEB-7", "أحمد", "07701111111", "بغداد").copy(status = StoreOrderStatus.Confirmed)
        val detail = StoreOrderDetail(order, 1, "الكرادة", "0.00", null, emptyList())
        val state = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Orders,
            capabilities = capabilities,
            loading = false,
            orders = listOf(order),
            counts = mapOf(StoreOrderStatus.Confirmed to 1, StoreOrderStatus.Processing to 0),
            selectedOrderId = order.id,
            detail = StoreDetailState.Content(detail),
            freshModes = setOf(StoreDeliveryMode.Orders),
        )
        val pending = PendingStoreAction(StoreOrderAction.StartProcessing, order.id)

        assertTrue(canRequestStoreAction(state, pending))
        assertFalse(canRequestStoreAction(state.copy(freshModes = emptySet()), pending))
        assertFalse(
            canRequestStoreAction(
                state.copy(detail = StoreDetailState.Content(detail.copy(summary = order.copy(status = StoreOrderStatus.Pending)))),
                pending,
            ),
        )

        val committed = state.commitStoreAction(pending, null)
        assertEquals(StoreOrderStatus.Processing, committed.orders.single().status)
        assertEquals(StoreOrderStatus.Processing, (committed.detail as StoreDetailState.Content).order.summary.status)
        assertEquals(0, committed.counts[StoreOrderStatus.Confirmed])
        assertEquals(1, committed.counts[StoreOrderStatus.Processing])
        assertFalse(isStoreModeFresh(committed))
        assertFalse(canRequestStoreAction(committed, pending))
    }

    @Test
    fun `courier completion is monotonic and cannot be repeated on a stale workspace`() {
        val workspace = courierWorkspace(delivered = false)
        val delivery = workspace.toDeliver.single()
        val state = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Courier,
            capabilities = StoreCapabilities.from("courier", null, "FULL"),
            loading = false,
            courier = workspace,
            selectedOrderId = delivery.id,
            freshModes = setOf(StoreDeliveryMode.Courier),
        )
        val pending = PendingStoreAction(StoreOrderAction.CourierDelivered, delivery.id)

        assertTrue(canRequestStoreAction(state, pending))
        val committed = state.commitStoreAction(pending, null)
        assertTrue(committed.courier!!.toDeliver.isEmpty())
        assertEquals(StoreOrderStatus.Delivered, committed.courier.delivered.single().status)
        assertFalse(canRequestStoreAction(committed, pending))
    }

    @Test
    fun `late list and detail responses cannot overwrite a newer filter or generation`() {
        val filter = StoreOrderFilter(status = StoreOrderStatus.Confirmed)
        val order = summary(3, "WEB-3", "ليلى", "07802222222", "البصرة").copy(status = StoreOrderStatus.Confirmed)
        val state = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Orders,
            capabilities = StoreCapabilities.from("manager", "FULL", null),
            loading = false,
            filter = filter,
            orders = listOf(order),
            selectedOrderId = order.id,
            freshModes = setOf(StoreDeliveryMode.Orders),
        )

        assertTrue(acceptsOrderResponse(state, 9, 9, filter))
        assertTrue(acceptsOrderResponse(state.copy(filter = filter.copy(query = "أحمد")), 9, 9, filter))
        assertFalse(acceptsOrderResponse(state, 8, 9, filter))
        assertFalse(acceptsOrderResponse(state, 9, 9, filter.copy(status = StoreOrderStatus.Pending)))
        assertTrue(acceptsOrderDetail(state, order.id, order.status, 5, 5, 9, 9))
        assertFalse(acceptsOrderDetail(state, order.id, order.status, 4, 5, 9, 9))
        assertTrue(isCurrentOrderDetailRequest(state, order.id, 5, 5, 9, 9))
        assertFalse(acceptsOrderDetail(state, order.id, StoreOrderStatus.Pending, 5, 5, 9, 9))
    }

    @Test
    fun `party mutations preserve a monotonic local result then close writes until retry`() {
        val existing = party(4, "مندوب الكرخ", "07701111111").copy(currentBalance = "1000.00")
        val state = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Parties,
            capabilities = StoreCapabilities.from("manager", "FULL", null),
            loading = false,
            partyCatalogReady = true,
            managedParties = listOf(existing),
            freshModes = setOf(StoreDeliveryMode.Parties),
        )
        val updated = state.commitPartyActive(existing.id, false)
        assertFalse(updated.managedParties.single().isActive)
        assertFalse(canMutateDeliveryParties(updated))

        val writtenOff = state.commitPartyWriteOff(existing.id, "250.25")
        assertEquals("749.75", writtenOff.managedParties.single().currentBalance)
        assertFalse(canMutateDeliveryParties(writtenOff))
    }

    @Test
    fun `money and write off contracts use exact decimal strings and strong bounds`() {
        assertEquals("9007199254740993.99", DeliveryMoney.normalized("9007199254740993.99"))
        assertEquals("12.30", DeliveryMoney.normalized("12.3"))
        assertNull(DeliveryMoney.normalized("1e3"))
        assertNull(DeliveryMoney.normalized("12.345"))
        assertTrue(DeliveryMoney.isLessThanOrEqual("999.99", "1000.00"))
        assertFalse(DeliveryMoney.isLessThanOrEqual("1000.01", "1000.00"))

        assertNull(DeliveryPartyDraft(name = "مندوب", defaultFee = "3500.25", floatLimit = "100000").validate())
        assertTrue(DeliveryPartyDraft(name = "مندوب", defaultFee = "3.141").validate()!!.contains("غير صالحة"))

        val valid = DeliveryWriteOffDraft(4, 2, "500.25", "1000.00", "دين غير قابل للتحصيل", "writeoff-4-once")
        assertNull(valid.validate())
        assertTrue(valid.copy(amount = "1000.01").validate()!!.contains("يتجاوز"))
        assertTrue(valid.copy(reason = "لا").validate()!!.contains("3 و500"))
        assertTrue(valid.copy(clientRequestId = "").validate()!!.contains("الطلب"))
    }

    @Test
    fun `delivery party search remains inside the loaded branch scoped catalog`() {
        val capabilities = StoreCapabilities.from("manager", "FULL", null)
        val state = StoreDeliveryUiState(
            mode = StoreDeliveryMode.Parties,
            capabilities = capabilities,
            loading = false,
            partyCatalogReady = true,
            partyQuery = "الكرخ",
            managedParties = listOf(
                party(1, "مندوب الكرخ", "07701111111"),
                party(2, "شركة البصرة", "07802222222"),
            ),
        )
        assertEquals(listOf(1L), StoreDeliveryStateFilter.managedParties(state).map { it.id })
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

    private fun party(id: Long, name: String, phone: String) = DeliveryPartyAccount(
        id = id,
        partyType = DeliveryPartyType.Individual,
        name = name,
        phone = phone,
        userId = null,
        branchId = 1,
        defaultFee = "0",
        currentBalance = "0",
        floatLimit = null,
        isActive = true,
        openConsignments = 0,
        oldestOutstanding = null,
    )
}
