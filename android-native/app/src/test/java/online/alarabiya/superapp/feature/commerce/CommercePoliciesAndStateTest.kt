package online.alarabiya.superapp.feature.commerce

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.commerce.CommerceCapabilities
import online.alarabiya.superapp.model.commerce.DigitalCard
import online.alarabiya.superapp.model.commerce.DigitalCardApproval
import online.alarabiya.superapp.model.commerce.DigitalCardApprovalKind
import online.alarabiya.superapp.model.commerce.DigitalCardAvailability
import online.alarabiya.superapp.model.commerce.GiftDetail
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
        assertTrue(moved.digitalCards.isEmpty())
        assertTrue(moved.loadedSections.isEmpty())
        assertTrue(moved.staleSections.isEmpty())
        assertNull(moved.error)

        val loading = CommerceStateReducer.loading(moved)
        assertTrue(loading.loading)
        val failed = CommerceStateReducer.loadFailed(loading, CommerceSection.DigitalCards, "تعذر")
        assertFalse(failed.loading)
        assertEquals("تعذر", failed.error)
        assertEquals(CommerceSection.DigitalCards, failed.section)
        assertTrue(CommerceSection.DigitalCards in failed.staleSections)
    }

    @Test
    fun `successful mutation closes detail and locks stale section until retry succeeds`() {
        val fresh = CommerceUiState(
            section = CommerceSection.Gifts,
            gifts = online.alarabiya.superapp.model.commerce.GiftPage(emptyList(), 0, false, null),
            giftDetail = giftDetail(),
            loadedSections = setOf(CommerceSection.Gifts),
            busyKey = "gift:approve:1",
        )

        val committed = CommerceStateReducer.mutationCommitted(fresh, CommerceSection.Gifts, "تم الاعتماد")
        assertNull(committed.giftDetail)
        assertFalse(committed.canAct(CommerceSection.Gifts))
        assertTrue(CommerceSection.Gifts in committed.staleSections)

        val refreshFailed = CommerceStateReducer.loadFailed(
            committed.copy(loading = true),
            CommerceSection.Gifts,
            "انقطع الاتصال",
            afterMutation = true,
        )
        assertEquals(CommerceStateReducer.MUTATION_REFRESH_NOTICE, refreshFailed.notice)
        assertNull(refreshFailed.error)
        assertFalse(refreshFailed.canAct(CommerceSection.Gifts))

        val retried = CommerceStateReducer.loaded(refreshFailed, CommerceSection.Gifts)
        assertTrue(retried.canAct(CommerceSection.Gifts))
        assertNull(retried.notice)
    }

    @Test
    fun `reservation and approval mutation commits invalidate every old action target`() {
        val reservationState = CommerceUiState(
            section = CommerceSection.Reservations,
            reservationDetail = reservation(ReservationStatus.ACTIVE),
            loadedSections = setOf(CommerceSection.Reservations),
            busyKey = "reservation:convert:1",
        )
        val reservationCommitted = CommerceStateReducer.mutationCommitted(
            reservationState,
            CommerceSection.Reservations,
            "تم التحويل",
        )
        assertNull(reservationCommitted.reservationDetail)
        assertNull(reservationCommitted.lastConversion)
        assertFalse(reservationCommitted.canAct(CommerceSection.Reservations))

        val approval = approval()
        val approvalState = CommerceUiState(
            section = CommerceSection.Approvals,
            approvals = listOf(approval),
            loadedSections = setOf(CommerceSection.Approvals),
            busyKey = "digital-card-approval:approve:${approval.kind}:${approval.id}",
        )
        val approvalCommitted = CommerceStateReducer
            .mutationCommitted(approvalState, CommerceSection.Approvals, "تم الاعتماد")
            .copy(approvals = approvalState.approvals - approval)
        assertTrue(approvalCommitted.approvals.isEmpty())
        assertFalse(approvalCommitted.canAct(CommerceSection.Approvals))
    }

    @Test
    fun `digital card confirmation requires the current fresh catalog row`() {
        val ready = card(DigitalCardAvailability.READY)
        val fresh = CommerceUiState(
            section = CommerceSection.DigitalCards,
            branchId = 1,
            digitalCards = listOf(ready),
            loadedSections = setOf(CommerceSection.DigitalCards),
        )
        assertEquals(ready, fresh.freshDigitalCard(ready.offeringId))
        assertNull(fresh.copy(staleSections = setOf(CommerceSection.DigitalCards)).freshDigitalCard(ready.offeringId))
        assertNull(fresh.copy(digitalCards = listOf(card(DigitalCardAvailability.STALE_PRICE))).freshDigitalCard(ready.offeringId))
        assertNull(CommerceStateReducer.branchChanged(fresh, 2).freshDigitalCard(ready.offeringId))
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

    private fun giftDetail() = GiftDetail(
        id = 1,
        number = "G-1",
        direction = GiftDirection.OUT,
        branchId = 1,
        status = GiftStatus.PENDING_APPROVAL,
        type = null,
        reason = null,
        sellable = true,
        partyName = "عميل",
        partyPhone = null,
        createdAt = null,
        lines = emptyList(),
    )

    private fun approval() = DigitalCardApproval(
        id = 7,
        kind = DigitalCardApprovalKind.WRITEOFF,
        branchId = 1,
        branchName = "الفرع",
        title = "شطب",
        description = null,
        amount = "10",
        requesterId = 2,
        requesterName = "مستخدم",
        createdAt = null,
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
