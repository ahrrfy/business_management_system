package online.alarabiya.superapp.feature.commerce

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.commerce.CommerceCapabilities
import online.alarabiya.superapp.model.commerce.DigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCardAvailability
import online.alarabiya.superapp.model.commerce.GiftDirection
import online.alarabiya.superapp.model.commerce.GiftStatus
import online.alarabiya.superapp.model.commerce.GiftSummary
import online.alarabiya.superapp.model.commerce.NativeCommerceBlockers
import online.alarabiya.superapp.model.commerce.ReservationDetail
import online.alarabiya.superapp.model.commerce.ReservationStatus
import online.alarabiya.superapp.model.commerce.ReservationSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommercePoliciesAndStateTest {
    @Test
    fun capabilitiesMirrorModuleAndRoleGatesConservatively() {
        val manager = capabilities(role = "manager")
        val cashier = capabilities(role = "cashier")
        val warehouse = capabilities(role = "warehouse")

        assertTrue(manager.canApproveGifts)
        assertTrue(manager.canExtendReservations)
        assertTrue(manager.canBrowseDigitalCards)
        assertTrue(manager.canReadDigitalSubscriptions)

        assertFalse(cashier.canApproveGifts)
        assertFalse(cashier.canExtendReservations)
        assertTrue(cashier.canConvertReservations)
        assertTrue(cashier.canBrowseDigitalCards)
        assertFalse(cashier.canReadDigitalSubscriptions)

        assertFalse(warehouse.canApproveGifts)
        assertFalse(warehouse.canBrowseDigitalCards)
        assertTrue(NativeCommerceBlockers.CUSTOM_RETAIL_STATION.contains("AppBootstrap"))
    }

    @Test
    fun giftApprovalRequiresOutboundPendingAndManager() {
        val manager = capabilities("manager")
        val cashier = capabilities("cashier")

        assertTrue(gift(GiftDirection.OUT, GiftStatus.PENDING_APPROVAL).canApprove(manager))
        assertFalse(gift(GiftDirection.IN, GiftStatus.PENDING_APPROVAL).canApprove(manager))
        assertFalse(gift(GiftDirection.OUT, GiftStatus.APPROVED).canApprove(manager))
        assertFalse(gift(GiftDirection.OUT, GiftStatus.PENDING_APPROVAL).canApprove(cashier))
        assertTrue(NativeCommerceBlockers.GIFT_CREATE_CATALOG.contains("product/unit picker"))
    }

    @Test
    fun reservationActionsRespectOpenStateRoleAndWriteAccess() {
        val manager = capabilities("manager")
        val cashier = capabilities("cashier")
        val readOnly = capabilities("cashier", reservations = "READ")
        val open = reservation(ReservationStatus.ACTIVE)
        val closed = reservation(ReservationStatus.FULFILLED)

        assertTrue(open.canCancel(cashier))
        assertTrue(open.canConvert(cashier))
        assertFalse(open.canExtend(cashier))
        assertTrue(open.canExtend(manager))
        assertFalse(open.canCancel(readOnly))
        assertFalse(closed.canCancel(manager))
        assertFalse(closed.canConvert(manager))
        assertTrue(NativeCommerceBlockers.RESERVATION_CREATE.contains("clientRequestId"))
    }

    @Test
    fun onlyReadyDigitalCardCanBeConfirmed() {
        assertTrue(card(DigitalCardAvailability.READY).canConfirm)
        assertFalse(card(DigitalCardAvailability.STALE_PRICE).canConfirm)
        assertFalse(card(DigitalCardAvailability.NO_PRICE).canConfirm)
        assertTrue(NativeCommerceBlockers.DIGITAL_CARD_SALE.contains("markExecution"))
    }

    @Test
    fun stateReducerInvalidatesBranchScopedCardsAndClearsTransientErrors() {
        val initial = CommerceUiState(
            section = CommerceSection.DigitalCards,
            branchId = 1,
            query = "بطاقة",
            confirmedCard = card(DigitalCardAvailability.READY),
            error = "قديم",
            loadedSections = setOf(CommerceSection.DigitalCards, CommerceSection.Gifts),
        )

        val moved = CommerceStateReducer.branchChanged(initial, 2)
        assertEquals(2L, moved.branchId)
        assertNull(moved.confirmedCard)
        assertFalse(CommerceSection.DigitalCards in moved.loadedSections)
        assertTrue(CommerceSection.Gifts in moved.loadedSections)
        assertNull(moved.error)

        val loading = CommerceStateReducer.loading(moved)
        assertTrue(loading.loading)
        val failed = CommerceStateReducer.failed(loading, "تعذر")
        assertFalse(failed.loading)
        assertEquals("تعذر", failed.error)
        assertEquals(CommerceSection.DigitalCards, failed.section)
    }

    @Test
    fun initializationSelectsFirstReadableSectionAndTabsExcludeUnauthorizedSections() {
        val reservationsOnly = capabilitiesWithModules("cashier", ModuleAccess("reservations", "الحجوزات", "READ"))
        val cardsOnly = capabilitiesWithModules(
            "cashier",
            ModuleAccess("digital_cards", "البطاقات", "READ"),
            ModuleAccess("sales", "المبيعات", "FULL"),
        )

        assertEquals(listOf(CommerceSection.Reservations), reservationsOnly.readableSections())
        assertEquals(CommerceSection.Reservations, CommerceStateReducer.initialized(CommerceUiState(), 1, reservationsOnly.readableSections()).section)
        assertEquals(listOf(CommerceSection.DigitalCards), cardsOnly.readableSections())
        assertEquals(CommerceSection.DigitalCards, CommerceStateReducer.initialized(CommerceUiState(), 1, cardsOnly.readableSections()).section)
    }

    private fun capabilities(role: String, reservations: String = "FULL"): CommerceCapabilities =
        CommerceCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(id = 1, name = "مستخدم", username = "user", email = null, role = role),
                modules = listOf(
                    ModuleAccess("gifts", "الهدايا", "FULL"),
                    ModuleAccess("reservations", "الحجوزات", reservations),
                    ModuleAccess("digital_cards", "البطاقات", "READ"),
                    ModuleAccess("sales", "المبيعات", "FULL"),
                ),
                branchId = 1,
                allBranches = role == "manager",
            ),
        )

    private fun capabilitiesWithModules(role: String, vararg modules: ModuleAccess): CommerceCapabilities =
        CommerceCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(id = 1, name = "مستخدم", username = "user", email = null, role = role),
                modules = modules.toList(),
                branchId = 1,
                allBranches = false,
            ),
        )

    private fun gift(direction: GiftDirection, status: GiftStatus) = GiftSummary(
        id = 1,
        number = "G-1",
        direction = direction,
        branchId = 1,
        status = status,
        type = null,
        reason = null,
        sellable = true,
        supplierName = "مورّد",
        customerName = "عميل",
        estimatedValue = null,
        totalCost = null,
        createdAt = null,
    )

    private fun reservation(status: ReservationStatus) = ReservationDetail(
        summary = ReservationSummary(
            id = 1,
            number = "RSV-1",
            branchId = 1,
            customerId = null,
            contactName = "عميل",
            contactPhone = "07700000000",
            channel = "PHONE",
            status = status,
            expiresAt = null,
            notes = null,
            createdAt = null,
        ),
        total = "0",
        hasUnpriced = false,
        lines = emptyList(),
    )

    private fun card(availability: DigitalCardAvailability) = DigitalCard(
        offeringId = 1,
        name = "بطاقة",
        providerId = 1,
        providerName = "مزوّد",
        offeringType = "TELECOM_CARD",
        requiresStudentData = false,
        faceValue = "10",
        sellPrice = "12000",
        priceVersionId = 1,
        imageUrl = null,
        colorToken = null,
        favorite = false,
        availability = availability,
    )
}
