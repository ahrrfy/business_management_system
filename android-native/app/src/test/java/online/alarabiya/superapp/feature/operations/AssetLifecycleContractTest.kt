package online.alarabiya.superapp.feature.operations

import java.io.ByteArrayInputStream
import java.io.File
import online.alarabiya.superapp.model.operations.AssetCategory
import online.alarabiya.superapp.model.operations.AssetDetail
import online.alarabiya.superapp.model.operations.AssetDocumentEncoding
import online.alarabiya.superapp.model.operations.AssetStatus
import online.alarabiya.superapp.model.operations.AssetSummary
import online.alarabiya.superapp.model.operations.AssetUpsertInput
import online.alarabiya.superapp.model.operations.DepreciationMethod
import online.alarabiya.superapp.model.operations.OperationsCapabilities
import online.alarabiya.superapp.model.operations.OperationsMappers
import online.alarabiya.superapp.model.operations.OperationsPolicy
import online.alarabiya.superapp.model.operations.OperationsScope
import online.alarabiya.superapp.model.operations.OperationsValidation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetLifecycleContractTest {
    @Test
    fun `detail mapper retains lifecycle financial custody and document fields`() {
        val detail = OperationsMappers.assetDetail(
            assetRow() + mapOf(
                "brand" to "Dell",
                "serial" to "SN-900",
                "supplierId" to 12,
                "supplierName" to "المورد",
                "salvageValue" to "50000.00",
                "usefulLifeYears" to 4,
                "depreciationMethod" to "db",
                "accumulated" to "180000.00",
                "maintTotal" to "25000.00",
                "disposalDate" to "2026-08-10",
                "disposalReason" to "تجديد",
                "disposalValue" to "200000.00",
                "docs" to listOf(mapOf("id" to 8, "title" to "فاتورة الشراء", "dataUrl" to "data:image/jpeg;base64,AA==")),
                "maintenance" to listOf(mapOf("id" to 4, "type" to "كفالة", "cost" to "0")),
                "custody" to listOf(mapOf("id" to 5, "employeeName" to "أحمد", "fromDate" to "2026-01-01")),
            ),
        )

        assertEquals("Dell", detail.brand)
        assertEquals("SN-900", detail.serial)
        assertEquals(12L, detail.supplierId)
        assertEquals(DepreciationMethod.DecliningBalance, detail.depreciationMethod)
        assertEquals("180000.00", detail.accumulatedDepreciation)
        assertEquals("فاتورة الشراء", detail.documents.single().title)
        assertEquals(1, detail.maintenance.size)
        assertEquals(1, detail.custody.size)
    }

    @Test
    fun `form options mapper drops malformed choices and keeps employee branch`() {
        val options = OperationsMappers.assetFormOptions(
            mapOf(
                "employees" to listOf(
                    mapOf("id" to 4, "name" to "علي", "branchId" to 2, "position" to "محاسب"),
                    mapOf("id" to 0, "name" to "غير صالح"),
                ),
                "branches" to listOf(mapOf("id" to 2, "name" to "الرئيسي")),
                "suppliers" to listOf(mapOf("id" to 7, "name" to "المجهز")),
            ),
        )

        assertEquals(1, options.employees.size)
        assertEquals(2L, options.employees.single().branchId)
        assertEquals("محاسب", options.employees.single().subtitle)
        assertEquals("الرئيسي", options.branches.single().name)
        assertEquals("المجهز", options.suppliers.single().name)
    }

    @Test
    fun `asset validation enforces money dates branch and salvage invariants`() {
        val scope = OperationsScope("manager", 2)
        val valid = input(branchId = 2)

        assertEquals(null, OperationsValidation.asset(valid, scope))
        assertNotNull(OperationsValidation.asset(valid.copy(branchId = 3), scope))
        assertNotNull(OperationsValidation.asset(valid.copy(purchaseValue = "0"), scope))
        assertNotNull(OperationsValidation.asset(valid.copy(purchaseValue = "100", salvageValue = "101"), scope))
        assertNotNull(OperationsValidation.asset(valid.copy(purchaseDate = "10/08/2026"), scope))
        assertNotNull(OperationsValidation.asset(valid.copy(usefulLifeYears = 101), scope))
    }

    @Test
    fun `owner manager policy and freshness gate close lifecycle writes by default`() {
        val manager = OperationsCapabilities.from("manager", 2, "FULL", "NONE")
        val reader = OperationsCapabilities.from("auditor", 2, "READ", "NONE")
        val owner = OperationsCapabilities.from("employee", null, "FULL", "NONE", isOwner = true)
        val asset = summary()

        assertTrue(OperationsPolicy.canEditAsset(asset, manager))
        assertTrue(OperationsPolicy.canHandoverAsset(asset, manager))
        assertTrue(OperationsPolicy.canDisposeAsset(asset, owner))
        assertFalse(OperationsPolicy.canEditAsset(asset, reader))

        val initial = OperationsUiState(scope = OperationsScope("manager", 2), capabilities = manager)
        assertTrue(initial.assetMutationLocked)
        val fresh = initial.copy(assetsLoaded = true, assetsFresh = true)
        assertFalse(fresh.assetMutationLocked)
        val unknown = fresh.copy(
            outcomeUnknownAction = PendingOperationsAction.UpdateAsset(asset, input(id = asset.id, branchId = 2)),
        )
        assertTrue(unknown.assetMutationLocked)
    }

    @Test
    fun `document encoding enforces image MIME and raw size cap`() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val dataUrl = AssetDocumentEncoding.encode(bytes, "image/jpeg")

        assertTrue(dataUrl.startsWith("data:image/jpeg;base64,"))
        assertTrue(AssetDocumentEncoding.readLimited(ByteArrayInputStream(bytes)).contentEquals(bytes))
        assertTrue(runCatching { AssetDocumentEncoding.encode(bytes, "application/pdf") }.isFailure)
        assertTrue(
            runCatching {
                AssetDocumentEncoding.readLimited(
                    ByteArrayInputStream(ByteArray(AssetDocumentEncoding.MAX_RAW_BYTES + 1)),
                )
            }.isFailure,
        )
    }

    @Test
    fun `repository contract uses scoped native lifecycle procedures including custody return`() {
        val source = repositorySource()

        listOf(
            "assets.create",
            "assets.update",
            "assets.handover",
            "assets.returnCustody",
            "assets.dispose",
            "assets.addDocument",
            "assets.deleteDocument",
            "assets.postDepreciation",
        ).forEach { procedure -> assertTrue("Missing $procedure", source.contains("\"$procedure\"")) }
        assertFalse(source.contains("if (!scope.isAdmin) return OperationsMappers.scopedAssetDetail"))
        assertTrue(source.contains("scope.effectiveBranch(input.branchId)"))
        assertTrue(source.contains("scope.acceptsBranch(detail.summary.branchId)"))
    }

    private fun repositorySource(): String {
        val candidates = listOf(
            File("src/main/java/online/alarabiya/superapp/data/OperationsRepository.kt"),
            File("android-native/app/src/main/java/online/alarabiya/superapp/data/OperationsRepository.kt"),
        )
        return candidates.firstOrNull(File::isFile)?.readText()
            ?: error("OperationsRepository.kt was not found from ${File(".").absolutePath}")
    }

    private fun input(id: Long? = null, branchId: Long?) = AssetUpsertInput(
        id = id,
        name = "حاسوب الإدارة",
        category = AssetCategory.Computers,
        brand = "Dell",
        serial = "SN-1",
        branchId = branchId,
        location = "الإدارة",
        custodianId = null,
        supplierId = 7,
        purchaseDate = "2026-08-10",
        purchaseValue = "1000000",
        salvageValue = "100000",
        usefulLifeYears = 4,
        depreciationMethod = DepreciationMethod.StraightLine,
        condition = "ممتاز",
        warrantyEnd = "2027-08-10",
    )

    private fun assetRow(): Map<String, Any?> = mapOf(
        "id" to 1,
        "code" to "AST-1001",
        "name" to "حاسوب الإدارة",
        "category" to "computers",
        "status" to "active",
        "branchId" to 2,
        "branchName" to "الرئيسي",
        "purchaseDate" to "2026-01-01",
        "purchaseValue" to "1000000",
        "bookValue" to "800000",
        "depPct" to "20",
    )

    private fun summary() = AssetSummary(
        id = 1,
        code = "AST-1001",
        name = "حاسوب الإدارة",
        category = AssetCategory.Computers,
        status = AssetStatus.Active,
        branchId = 2,
        branchName = "الرئيسي",
        location = null,
        custodianId = 3,
        custodianName = "علي",
        purchaseDate = "2026-01-01",
        purchaseValue = "1000000",
        bookValue = "800000",
        depreciationPct = "20",
        condition = "ممتاز",
        warrantyEnd = null,
    )
}
