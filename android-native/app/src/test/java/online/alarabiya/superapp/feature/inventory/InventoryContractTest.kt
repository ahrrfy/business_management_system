package online.alarabiya.superapp.feature.inventory

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.model.inventory.AdjustmentDraft
import online.alarabiya.superapp.model.inventory.InventoryCapabilities
import online.alarabiya.superapp.model.inventory.InventoryMappers
import online.alarabiya.superapp.model.inventory.InventorySection
import online.alarabiya.superapp.model.inventory.InventoryValidation
import online.alarabiya.superapp.model.inventory.ReceiveDraft
import online.alarabiya.superapp.model.inventory.ReceiveLineDraft
import online.alarabiya.superapp.model.inventory.StocktakeDraft
import online.alarabiya.superapp.model.inventory.TransferDetail
import online.alarabiya.superapp.model.inventory.TransferDraft
import online.alarabiya.superapp.model.inventory.TransferLine
import online.alarabiya.superapp.model.inventory.TransferStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InventoryContractTest {
    @Test
    fun mapsBalancesAndTransferPaginationFromDocumentedWireFields() {
        val balances = InventoryMappers.balances(
            listOf(
                mapOf(
                    "variantId" to 9,
                    "branchId" to 2,
                    "productName" to "ورق طباعة",
                    "variantName" to "A4",
                    "sku" to "P-A4",
                    "quantity" to 6,
                    "minStock" to 10,
                    "reorderPoint" to 12,
                    "isLow" to true,
                    "lastCountedAt" to "2026-08-06T08:30:00.000Z",
                ),
            ),
        )
        assertEquals("ورق طباعة · A4", balances.single().label)
        assertEquals(6, balances.single().quantity)
        assertTrue(balances.single().isLow)

        val page = InventoryMappers.transfers(
            mapOf(
                "rows" to listOf(
                    mapOf(
                        "id" to 18,
                        "transferNumber" to "TR-2026-18",
                        "fromBranchId" to 2,
                        "fromBranchName" to "بغداد",
                        "toBranchId" to 3,
                        "toBranchName" to "البصرة",
                        "status" to "IN_TRANSIT",
                        "totalSentBase" to 24,
                        "totalReceivedBase" to null,
                        "linesCount" to 2,
                    ),
                ),
                "nextCursor" to 17,
            ),
        )
        assertEquals(17L, page.nextCursor)
        assertEquals(TransferStatus.IN_TRANSIT, page.rows.single().status)
        assertEquals("البصرة", page.rows.single().toBranchName)
    }

    @Test
    fun mapsBlindCountStateWithoutExpectedStockOrColleagueQuantity() {
        val count = InventoryMappers.countSession(
            mapOf(
                "changed" to true,
                "state" to mapOf(
                    "session" to mapOf("code" to "ST-26-4", "name" to "جرد أغسطس", "branchName" to "بغداد"),
                    "assignment" to mapOf("name" to "الممر الأول", "zone" to "A"),
                    "progress" to mapOf("mine" to mapOf("counted" to 1, "total" to 2)),
                    "recountTasks" to listOf(mapOf("variantId" to 9, "reason" to "تحقق من العبوة")),
                    "items" to listOf(
                        mapOf(
                            "variantId" to 9,
                            "productName" to "ورق",
                            "variantName" to "A4",
                            "sku" to "P-A4",
                            "counted" to true,
                            "myCount" to mapOf("qty" to 12),
                            "colleagueCounted" to true,
                        ),
                    ),
                ),
            ),
        )

        assertEquals(1, count.counted)
        assertEquals(2, count.total)
        assertEquals(12, count.items.single().myQuantity)
        assertTrue(count.items.single().colleagueCounted)
        assertEquals("تحقق من العبوة", count.items.single().recountReason)
    }

    @Test
    fun readAndFullAccessStayDistinctAndBranchScopeFailsClosed() {
        val read = capabilities(access = "READ", role = "warehouse", branchId = 2)
        assertTrue(read.canRead)
        assertFalse(read.canWrite)
        assertTrue(InventorySection.STOCKTAKES in read.visibleSections)

        val full = capabilities(access = "FULL", role = "manager", branchId = 2)
        assertTrue(full.canWrite)
        assertTrue(full.canManage)
        assertTrue(full.canCreateStocktake)

        val missingBranch = capabilities(access = "FULL", role = "admin", branchId = null)
        assertFalse(missingBranch.canWrite)
        assertFalse(missingBranch.canManage)
        assertFalse(missingBranch.canCancelStocktake)
        assertEquals(listOf(InventorySection.MY_COUNTS), missingBranch.visibleSections)
    }

    @Test
    fun transferActionsRequireSessionBranchAndServerState() {
        val source = capabilities(access = "FULL", role = "warehouse", branchId = 2)
        val destination = capabilities(access = "FULL", role = "warehouse", branchId = 3)
        val transfer = transfer()

        assertTrue(source.canCancel(transfer))
        assertFalse(source.canReceive(transfer))
        assertTrue(destination.canReceive(transfer))
        assertFalse(destination.canCancel(transfer))
        assertFalse(destination.canReceive(transfer.copy(status = TransferStatus.RECEIVED)))
    }

    @Test
    fun validationRejectsUnsafeOrIncompleteOperationalInput() {
        assertEquals("اختر الفرع المستلم", InventoryValidation.transfer(TransferDraft(variantId = 2), 1))
        assertEquals(
            "لا يمكن التحويل إلى الفرع نفسه",
            InventoryValidation.transfer(TransferDraft(2, "صنف", 1, "2", clientRequestId = "req"), 1),
        )
        assertNull(InventoryValidation.transfer(TransferDraft(2, "صنف", 3, "2", clientRequestId = "req"), 1))
        assertEquals(
            "سبب التحويل غير صالح",
            InventoryValidation.transfer(TransferDraft(2, "صنف", 3, "2", reason = "FREE_TEXT", clientRequestId = "req"), 1),
        )

        val detail = transfer()
        assertEquals(
            "اشرح سبب الفرق في سطر الاستلام",
            InventoryValidation.receive(detail, ReceiveDraft(detail.id, listOf(ReceiveLineDraft(7, "3")), clientRequestId = "req")),
        )
        assertNull(
            InventoryValidation.receive(detail, ReceiveDraft(detail.id, listOf(ReceiveLineDraft(7, "3", "تالف")), clientRequestId = "req")),
        )
        assertEquals("الرصيد المستهدف عدد صحيح غير سالب", InventoryValidation.adjustment(AdjustmentDraft(2, "صنف", "-1"), 1))
        assertEquals("أيام الحركة بين 1 و365", InventoryValidation.stocktake(StocktakeDraft("جرد", "MOVING", "0"), 1))
    }

    @Test
    fun screenStateStartsWithoutLeakingOperationalDetail() {
        val state = InventoryUiState(section = InventorySection.BALANCES)
        assertEquals(InventorySection.BALANCES, state.section)
        assertTrue(state.balances.isEmpty())
        assertNull(state.selectedTransfer)
        assertNull(state.selectedStocktake)
        assertNull(state.selectedCount)
        assertFalse(state.initializing)
    }

    private fun capabilities(access: String, role: String, branchId: Long?): InventoryCapabilities =
        InventoryCapabilities.fromBootstrap(
            AppBootstrap(
                user = UserIdentity(5, "مستخدم المخزون", null, null, role),
                modules = listOf(ModuleAccess("inventory", "المخزون", access)),
                branchId = branchId,
                allBranches = role == "admin",
            ),
        )

    private fun transfer() = TransferDetail(
        id = 12,
        number = "TR-12",
        fromBranchId = 2,
        fromBranchName = "بغداد",
        toBranchId = 3,
        toBranchName = "البصرة",
        status = TransferStatus.IN_TRANSIT,
        reason = null,
        notes = null,
        receiveNotes = null,
        createdAt = null,
        createdByName = "مدير المخزون",
        lines = listOf(TransferLine(7, 9, "ورق", "A4", "P-A4", 5, null, null)),
    )
}
