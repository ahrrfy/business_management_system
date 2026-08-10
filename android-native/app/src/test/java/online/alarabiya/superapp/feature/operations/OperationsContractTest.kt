package online.alarabiya.superapp.feature.operations

import online.alarabiya.superapp.model.operations.AssetCategory
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.ConsignmentNoteType
import online.alarabiya.superapp.model.operations.OperationsCapabilities
import online.alarabiya.superapp.model.operations.OperationsMappers
import online.alarabiya.superapp.model.operations.OperationsPolicy
import online.alarabiya.superapp.model.operations.OperationsScope
import online.alarabiya.superapp.model.operations.OperationsSection
import online.alarabiya.superapp.model.operations.OperationsValidation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OperationsContractTest {
    @Test
    fun `branch scope fails closed outside assigned branch`() {
        val manager = OperationsScope(role = "manager", branchId = 4)
        val warehouse = OperationsScope(role = "warehouse", branchId = 7)
        val admin = OperationsScope(role = "admin", branchId = null)
        val selectedAdmin = OperationsScope(role = "admin", branchId = 9)
        val owner = OperationsScope(role = "employee", branchId = null, isOwner = true)

        assertEquals(4L, manager.effectiveBranch(99))
        assertTrue(manager.acceptsBranch(4))
        assertFalse(manager.acceptsBranch(5))
        assertFalse(warehouse.acceptsBranch(null))
        assertEquals(12L, admin.effectiveBranch(12))
        assertTrue(admin.acceptsBranch(900))
        assertEquals(9L, selectedAdmin.effectiveBranch(12))
        assertTrue(selectedAdmin.acceptsBranch(9))
        assertFalse(selectedAdmin.acceptsBranch(12))
        assertTrue(owner.isAdmin)
    }

    @Test
    fun `capabilities keep financial and operational duties separated`() {
        val warehouse = OperationsCapabilities.from("warehouse", 2, "NONE", "FULL")
        val manager = OperationsCapabilities.from("manager", 2, "FULL", "FULL")
        val accountant = OperationsCapabilities.from("accountant", 2, "READ", "FULL", "READ")
        val admin = OperationsCapabilities.from("admin", null, "FULL", "FULL")

        assertTrue(warehouse.canCreateConsignmentNotes)
        assertFalse(warehouse.canManageAssetState)
        assertFalse(warehouse.canReadConsignmentLineDetails)
        assertTrue(manager.canManageAssetState)
        assertTrue(manager.canPostDepreciation)
        assertFalse(manager.canReadConsignmentLineDetails)
        assertFalse(accountant.canManageAssetState)
        assertTrue(admin.canReadConsignmentLineDetails)
        assertTrue(accountant.canReadMyCommission)
    }

    @Test
    fun `asset mapper drops malformed rows and fails unknown state closed`() {
        val assets = OperationsMappers.assets(
            listOf(
                assetRow(),
                assetRow() + mapOf("id" to 0),
                assetRow() + mapOf("id" to 2, "status" to "FUTURE_STATE"),
            ),
        )

        assertEquals(2, assets.size)
        assertEquals(AssetStatus.Active, assets.first().status)
        assertEquals("315000", assets.first().bookValue)
        assertEquals(AssetStatus.Unknown, assets.last().status)
        assertFalse(OperationsPolicy.canStartMaintenance(assets.last(), fullManager()))
    }

    @Test
    fun `asset policy permits only manager lifecycle state transitions`() {
        val active = summary(status = AssetStatus.Active)
        val maintenance = summary(status = AssetStatus.Maintenance)
        val reader = OperationsCapabilities.from("auditor", 1, "READ", "READ")

        assertTrue(OperationsPolicy.canStartMaintenance(active, fullManager()))
        assertFalse(OperationsPolicy.canReturnFromMaintenance(active, fullManager()))
        assertTrue(OperationsPolicy.canReturnFromMaintenance(maintenance, fullManager()))
        assertFalse(OperationsPolicy.canStartMaintenance(active, reader))
    }

    @Test
    fun `commission mapper contains only the authenticated employee contract`() {
        val mine = OperationsMappers.myCommission(
            mapOf(
                "period" to "2026-08",
                "employeeName" to "موظف الاختبار",
                "planName" to "خطة المبيعات",
                "sales" to "900000",
                "returns" to "100000",
                "consignDeduction" to "50000",
                "carryIn" to "0",
                "effectiveBase" to "750000",
                "target" to "1000000",
                "achievementPct" to "75",
                "projectedCommission" to "25000",
                "settled" to mapOf("commissionAmount" to "24000", "status" to "approved"),
                "history" to listOf(
                    mapOf("period" to "2026-07", "effectiveBase" to "700000", "commissionAmount" to "20000", "status" to "approved"),
                    mapOf("period" to "bad", "commissionAmount" to "999999"),
                ),
            ),
        )

        assertEquals("موظف الاختبار", mine.employeeName)
        assertEquals("25000", mine.projectedCommission)
        assertEquals("24000", mine.settledAmount)
        assertTrue(mine.settledApproved)
        assertEquals(listOf("2026-07"), mine.history.map { it.period })
    }

    @Test
    fun `consignment mapper never exposes unit share snapshots`() {
        val detail = OperationsMappers.consignmentDetail(
            noteRow() + mapOf(
                "consignorPhone" to "07701234567",
                "attachmentUrl" to "data:image/jpeg;base64,opaque",
                "lines" to listOf(
                    mapOf(
                        "id" to 31,
                        "lineDirection" to "OUT",
                        "variantId" to 9,
                        "productName" to "دفتر",
                        "sku" to "N-9",
                        "quantity" to "2",
                        "baseQuantity" to "2",
                        "unitShareSnapshot" to "SECRET_COST",
                    ),
                ),
            ),
        )

        assertEquals(ConsignmentNoteType.Withdraw, detail.summary.type)
        assertTrue(detail.hasAttachment)
        assertFalse(detail.lines.single().directionIn)
        assertNull(detail.lines.single().unitShare)
    }

    @Test
    fun `consignment paging and local filters preserve server totals`() {
        val page = OperationsMappers.consignmentPage(
            mapOf("rows" to listOf(noteRow()), "total" to 72),
            offset = 0,
            limit = 50,
        )
        val state = OperationsUiState(
            section = OperationsSection.Consignment,
            scope = OperationsScope("warehouse", 3),
            capabilities = OperationsCapabilities.from("warehouse", 3, null, "FULL"),
            notes = page.rows,
            notesTotal = page.total,
            query = "الأمانة",
        )

        assertTrue(page.hasMore)
        assertEquals(72, page.total)
        assertEquals(1, OperationsStateFilter.notes(state).size)
        assertTrue(OperationsStateFilter.notes(state.copy(query = "غير موجود")).isEmpty())
    }

    @Test
    fun `documented gaps record closed scope and remaining idempotency blockers`() {
        val text = OperationsApiGaps.current.joinToString(" ")
        assertTrue(text.contains("عزل assets.list/get/formOptions"))
        assertTrue(text.contains("assets.returnCustody"))
        assertTrue(text.contains("clientRequestId"))
        assertTrue(text.contains("unitShareSnapshot"))
        assertTrue(text.contains("maker-checker"))
    }

    @Test
    fun `quick note quantity matches the positive three decimal server contract`() {
        assertTrue(OperationsValidation.isPositiveQuantity("1"))
        assertTrue(OperationsValidation.isPositiveQuantity("0.125"))
        assertFalse(OperationsValidation.isPositiveQuantity("0"))
        assertFalse(OperationsValidation.isPositiveQuantity("1.0000"))
        assertFalse(OperationsValidation.isPositiveQuantity("-1"))
    }

    private fun assetRow(): Map<String, Any?> = mapOf(
        "id" to 1,
        "code" to "AST-1001",
        "name" to "حاسوب الاستقبال",
        "category" to "computers",
        "status" to "active",
        "branchId" to 1,
        "branchName" to "الرئيسي",
        "location" to "الاستقبال",
        "custodianId" to 8,
        "custodianName" to "أحمد علي",
        "purchaseDate" to "2025-01-01",
        "purchaseValue" to "500000",
        "bookValue" to 315000,
        "depPct" to 37,
    )

    private fun noteRow(): Map<String, Any?> = mapOf(
        "id" to 11,
        "noteNumber" to "CNS-2026-11",
        "noteType" to "WITHDRAW",
        "consignorId" to 4,
        "consignorName" to "مورد الأمانة",
        "branchId" to 3,
        "hasAttachment" to 1,
        "createdAt" to "2026-08-06T09:00:00.000Z",
    )

    private fun summary(status: AssetStatus) = AssetSummary(
        id = 1,
        code = "AST-1",
        name = "أصل",
        category = AssetCategory.Computers,
        status = status,
        branchId = 1,
        branchName = "فرع",
        location = null,
        custodianId = null,
        custodianName = null,
        purchaseDate = null,
        purchaseValue = "1",
        bookValue = "1",
        depreciationPct = "0",
        condition = null,
        warrantyEnd = null,
    )

    private fun fullManager() = OperationsCapabilities.from("manager", 1, "FULL", "FULL")
}
