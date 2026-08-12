package online.alarabiya.superapp.feature.inventory

import online.alarabiya.superapp.model.inventory.AdjustmentRequest
import online.alarabiya.superapp.model.inventory.AdjustmentStatus
import online.alarabiya.superapp.model.inventory.CountItem
import online.alarabiya.superapp.model.inventory.CountSession
import online.alarabiya.superapp.model.inventory.InventorySection
import online.alarabiya.superapp.model.inventory.ReceiveDraft
import online.alarabiya.superapp.model.inventory.StocktakeDetail
import online.alarabiya.superapp.model.inventory.StocktakeStatus
import online.alarabiya.superapp.model.inventory.StocktakeSummary
import online.alarabiya.superapp.model.inventory.TransferDetail
import online.alarabiya.superapp.model.inventory.TransferLine
import online.alarabiya.superapp.model.inventory.TransferPage
import online.alarabiya.superapp.model.inventory.TransferStatus
import online.alarabiya.superapp.model.inventory.TransferSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InventorySafetyStateTest {
    @Test
    fun `initial and failed sections stay unavailable until a successful read`() {
        val initial = InventoryUiState(section = InventorySection.TRANSFERS)
        assertFalse(initial.isLoaded(InventorySection.TRANSFERS))
        assertFalse(initial.canInteract(InventorySection.TRANSFERS))

        val loaded = initial.markFresh(InventorySection.TRANSFERS)
        assertTrue(loaded.isLoaded(InventorySection.TRANSFERS))
        assertTrue(loaded.canInteract(InventorySection.TRANSFERS))

        val failedRefresh = loaded.markStale(InventorySection.TRANSFERS)
        assertTrue(failedRefresh.isLoaded(InventorySection.TRANSFERS))
        assertFalse(failedRefresh.canInteract(InventorySection.TRANSFERS))
    }

    @Test
    fun `ambiguous non idempotent outcome remains locked even after a read refresh`() {
        val state = InventoryUiState(section = InventorySection.STOCKTAKES)
            .markFresh(InventorySection.STOCKTAKES)
            .markOutcomeUnknown(InventorySection.STOCKTAKES)
            .markFresh(InventorySection.STOCKTAKES)

        assertTrue(state.isLoaded(InventorySection.STOCKTAKES))
        assertFalse(state.isFresh(InventorySection.STOCKTAKES))
        assertFalse(state.canInteract(InventorySection.STOCKTAKES))
    }

    @Test
    fun `acknowledged transfer transition closes receive draft and commits terminal status`() {
        val detail = transferDetail()
        val summary = transferSummary()
        val state = InventoryUiState(
            section = InventorySection.TRANSFERS,
            transfers = TransferPage(listOf(summary), null),
            selectedTransfer = detail,
            receiveDraft = ReceiveDraft(detail.id, emptyList(), clientRequestId = "fixed-request"),
        ).acknowledgeTransferStatus(detail.id, TransferStatus.RECEIVED)

        assertEquals(TransferStatus.RECEIVED, state.selectedTransfer?.status)
        assertEquals(TransferStatus.RECEIVED, state.transfers.rows.single().status)
        assertNull(state.receiveDraft)
    }

    @Test
    fun `acknowledged approval leaves no repeatable pending action`() {
        val request = AdjustmentRequest(
            id = 9,
            variantId = 3,
            branchId = 2,
            productName = "ورق",
            variantName = "A4",
            sku = "P-A4",
            expectedQuantity = 5,
            currentQuantity = 5,
            targetQuantity = 8,
            status = AdjustmentStatus.PENDING_APPROVAL,
            notes = null,
            createdBy = 4,
            createdByName = "مستخدم",
            createdAt = null,
            rejectionReason = null,
        )
        val state = InventoryUiState(
            section = InventorySection.ADJUSTMENTS,
            adjustmentStatus = AdjustmentStatus.PENDING_APPROVAL,
            adjustments = listOf(request),
        ).acknowledgeAdjustment(request.id, AdjustmentStatus.APPROVED)

        assertTrue(state.adjustments.isEmpty())
        assertNull(state.rejectingAdjustmentId)
    }

    @Test
    fun `acknowledged stocktake transition is monotonic in list and detail`() {
        val summary = stocktakeSummary()
        val detail = StocktakeDetail(summary, true, null, emptyList(), 10, 10, emptyList())
        val state = InventoryUiState(
            section = InventorySection.STOCKTAKES,
            stocktakes = listOf(summary),
            selectedStocktake = detail,
        ).acknowledgeStocktakeStatus(summary.id, StocktakeStatus.APPROVED)

        assertEquals(StocktakeStatus.APPROVED, state.stocktakes.single().status)
        assertEquals(StocktakeStatus.APPROVED, state.selectedStocktake?.summary?.status)
    }

    @Test
    fun `count acknowledgement updates locally once and preserves stable request id`() {
        var generated = 0
        val ids = CountRequestIdRegistry { "request-${++generated}" }
        val first = ids.idFor("ST-1", 7, 12)
        val repeated = ids.idFor("ST-1", 7, 12)
        val changedQuantity = ids.idFor("ST-1", 7, 13)
        assertEquals(first, repeated)
        assertFalse(first == changedQuantity)

        val item = CountItem(7, "ورق", "A4", "P-A4", false, null, false, "أعد العد")
        val session = CountSession("ST-1", "جرد", "بغداد", "ممر", null, 0, 1, listOf(item))
        val acknowledged = InventoryUiState(
            section = InventorySection.MY_COUNTS,
            selectedCount = session,
        ).acknowledgeCount(session.code, item.variantId, 12)
            .acknowledgeCount(session.code, item.variantId, 12)

        assertEquals(1, acknowledged.selectedCount?.counted)
        assertEquals(12, acknowledged.selectedCount?.items?.single()?.myQuantity)
        assertNull(acknowledged.selectedCount?.items?.single()?.recountReason)
    }

    private fun transferSummary() = TransferSummary(
        id = 11,
        number = "TR-11",
        fromBranchId = 2,
        fromBranchName = "بغداد",
        toBranchId = 3,
        toBranchName = "البصرة",
        status = TransferStatus.IN_TRANSIT,
        reason = null,
        sent = 5,
        received = null,
        linesCount = 1,
        createdAt = null,
    )

    private fun transferDetail() = TransferDetail(
        id = 11,
        number = "TR-11",
        fromBranchId = 2,
        fromBranchName = "بغداد",
        toBranchId = 3,
        toBranchName = "البصرة",
        status = TransferStatus.IN_TRANSIT,
        reason = null,
        notes = null,
        receiveNotes = null,
        createdAt = null,
        createdByName = "مستخدم",
        lines = listOf(TransferLine(1, 7, "ورق", "A4", "P-A4", 5, null, null)),
    )

    private fun stocktakeSummary() = StocktakeSummary(
        id = 15,
        code = "ST-15",
        name = "جرد",
        branchId = 2,
        branchName = "بغداد",
        scopeLabel = "شامل",
        status = StocktakeStatus.REVIEW,
        itemCount = 10,
        countedCount = 10,
        createdAt = null,
        createdByName = "مستخدم",
    )
}
