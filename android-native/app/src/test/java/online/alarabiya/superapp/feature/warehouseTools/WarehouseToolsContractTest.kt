package online.alarabiya.superapp.feature.warehouseTools

import online.alarabiya.superapp.model.AppBootstrap
import online.alarabiya.superapp.model.ModuleAccess
import online.alarabiya.superapp.model.UserIdentity
import online.alarabiya.superapp.data.inputJson
import online.alarabiya.superapp.model.warehouseTools.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WarehouseToolsContractTest {
    @Test
    fun countJsonOmitsOptionalBarcodeButPreservesRealScanEvidence() {
        val manual = CountSubmission("CNT-1", 9, 2, "[]", "request", "SEARCH_PICK", null).inputJson()
        assertFalse(manual.has("scannedBarcode"))
        val camera = CountSubmission("CNT-1", 9, 2, "[]", "request", "SCAN_CAMERA", "036000291452").inputJson()
        assertEquals("036000291452", camera.getString("scannedBarcode"))
        val replay = PendingCount("CNT-1", 9, 2, "[]", "request", "now", entryMethod = "SEARCH_PICK").inputJson()
        assertFalse(replay.has("scannedBarcode"))
    }

    @Test
    fun mapsBlindCountStateWithoutLedgerQuantities() {
        val state = WarehouseToolsMappers.countSession(mapOf(
            "session" to mapOf("code" to "CNT-2026-8", "name" to "جرد المستودع", "branchName" to "الرئيسي", "status" to "COUNTING", "dupPolicy" to "VERIFY", "blind" to true, "countMethod" to "SCAN_REQUIRED"),
            "assignment" to mapOf("id" to 4, "name" to "عامل العد", "status" to "ACTIVE", "zone" to "A"),
            "progress" to mapOf("mine" to mapOf("counted" to 1, "total" to 2), "session" to mapOf("counted" to 1, "total" to 2)),
            "recountTasks" to listOf(mapOf("variantId" to 9, "reason" to "تحقق")),
            "items" to listOf(mapOf(
                "variantId" to 9, "productName" to "ورق", "variantName" to "A4", "sku" to "P-A4", "counted" to true,
                "colleagueCounted" to true, "myCount" to mapOf("qty" to 24, "at" to "2026-08-06T09:00:00Z"),
                "expectedQty" to 9999,
                "units" to listOf(mapOf("unitName" to "كرتون", "factor" to 12, "barcode" to "BOX-9", "aliases" to listOf("ALT-9"))),
            )),
        ), "etag-1")

        assertTrue(state.blind)
        assertEquals("SCAN_REQUIRED", state.countMethod)
        assertEquals(24, state.items.single().myCount?.quantity)
        assertTrue(state.items.single().colleagueCounted)
        assertEquals("تحقق", state.items.single().recountReason)
        assertEquals(state.items.single(), state.exactMatch("ALT-9"))
        assertEquals(state.items.single(), state.exactMatch("p-a4"))
    }

    @Test
    fun warehouseSnapshotKeepsOperationalFieldsAndBranchStock() {
        val snapshot = WarehouseToolsMappers.warehouseSnapshot(
            catalog = mapOf(
                "version" to "v2|x", "generatedAt" to "2026-08-06T10:00:00Z",
                "rows" to listOf(mapOf(
                    "productUnitId" to 11, "productId" to 2, "productName" to "حبر", "variantId" to 7, "variantName" to "أسود",
                    "sku" to "INK-B", "unitName" to "علبة", "conversionFactor" to "1", "allBarcodes" to listOf("100", "101"),
                    "isBaseUnit" to true, "priceRetail" to "50000.00",
                )),
            ),
            stock = listOf(mapOf("variantId" to 7, "qty" to 31)),
            userId = 5,
            branchId = 2,
            syncedAt = "2026-08-06T10:01:00Z",
        )
        assertEquals(31, snapshot.items.single().stockBase)
        assertEquals(snapshot.items.single(), snapshot.exactMatch("101"))
        assertEquals(2L, snapshot.branchId)
    }

    @Test
    fun countValidationProducesExactBaseQuantityAndStableIdempotencyKey() {
        val item = item()
        val session = session(item)
        val draft = CountDraft(
            sessionCode = session.code,
            variantId = item.variantId,
            entries = listOf(CountUnitEntry("كرتون", "12", "2"), CountUnitEntry("قطعة", "1", "3")),
            clientRequestId = "7f0fe832-b304-4e13-b37f-00cd88b334e0",
        )
        assertNull(WarehouseValidation.count(session, item, draft))
        val submission = WarehouseValidation.submission(draft)
        assertEquals(27, submission.quantityBase)
        assertEquals(draft.clientRequestId, submission.clientRequestId)
        assertTrue(submission.unitBreakdown.contains("كرتون"))

        assertEquals("معامل كرتون لا يطابق بيانات الجرد", WarehouseValidation.count(session, item, draft.copy(entries = listOf(CountUnitEntry("كرتون", "13", "2"), CountUnitEntry("قطعة", "1", "3")))))
        val half = item.copy(units = listOf(CountUnit("نصف", "0.5", null, emptyList())))
        assertEquals("تحويل الوحدات لا ينتج كمية أساس صحيحة", WarehouseValidation.count(session.copy(items = listOf(half)), half, draft.copy(entries = listOf(CountUnitEntry("نصف", "0.5", "1")))))
        assertEquals("جلسة العد أو التكليف غير نشط", WarehouseValidation.count(session.copy(assignmentStatus = "SUBMITTED"), item, draft))
        val blockedItem = item.copy(colleagueCounted = true)
        assertFalse(session.copy(duplicatePolicy = "BLOCK", items = listOf(blockedItem)).canCount(blockedItem))

        val eanItem = item.copy(units = listOf(CountUnit("قطعة", "1", "0036000291452", emptyList())))
        val required = session.copy(countMethod = "SCAN_REQUIRED", items = listOf(eanItem))
        assertEquals(
            "هذه الجلسة تتطلب مسح الباركود بالكاميرا أو القارئ",
            WarehouseValidation.count(required, eanItem, draft.copy(entries = listOf(CountUnitEntry("قطعة", "1", "3")))),
        )
        val scannedDraft = draft.copy(
            entries = listOf(CountUnitEntry("قطعة", "1", "3")),
            entryMethod = "SCAN_CAMERA",
            scannedBarcode = "036000291452",
        )
        assertNull(WarehouseValidation.count(required, eanItem, scannedDraft))
        assertEquals("SCAN_CAMERA", WarehouseValidation.submission(scannedDraft).entryMethod)
        assertEquals("036000291452", WarehouseValidation.submission(scannedDraft).scannedBarcode)
    }

    @Test
    fun retryAndCapabilityRulesFailClosed() {
        assertTrue(WarehouseRetryPolicy.canQueue(null))
        assertTrue(WarehouseRetryPolicy.canQueue(503))
        assertFalse(WarehouseRetryPolicy.canQueue(400))
        assertTrue(WarehouseRetryPolicy.authenticationRequired(401))
        val pending = PendingCount("CNT-1", 9, 2, "[]", "a", "now")
        assertTrue(WarehouseQueueRules.mustSerialize(listOf(pending), "CNT-1", 9))
        assertFalse(WarehouseQueueRules.mustSerialize(listOf(pending), "CNT-1", 10))

        val branchless = capabilities("READ", null)
        assertFalse(branchless.canSyncWarehouseSnapshot)
        assertTrue(branchless.canUseAssignedCounts)
        val scoped = capabilities("READ", 2)
        assertTrue(scoped.canSyncWarehouseSnapshot)
    }

    @Test
    fun signedBarcodeMappingDoesNotTreatInvalidPayloadAsDocument() {
        val invalid = WarehouseToolsMappers.signedBarcode(mapOf("valid" to false, "docType" to null, "branchId" to null))
        assertFalse(invalid.valid)
        assertNull(invalid.documentType)
        val valid = WarehouseToolsMappers.signedBarcode(mapOf("valid" to true, "docType" to "WO", "number" to "WO-9", "branchId" to 2))
        assertEquals("WO-9", valid.number)
        assertEquals(2L, valid.branchId)
    }

    @Test
    fun mutationGatesRequireFreshAssignmentsSessionAndQueue() {
        val item = item()
        val session = session(item)
        val base = WarehouseToolsUiState(
            assignments = listOf(CountAssignment(session.code, session.name, 2, 4, "ACTIVE", "A", null)),
            selectedCount = session,
            selectedItem = item,
            countDraft = draft(item, session),
            assignmentsFresh = true,
            countFresh = true,
            pendingFresh = true,
        )

        assertTrue(canOpenWarehouseAssignment(base))
        assertTrue(canBeginWarehouseCount(base, item))
        assertTrue(canSubmitWarehouseCount(base))
        assertFalse(canSubmitWarehouseCount(base.copy(countFresh = false)))
        assertFalse(canSubmitWarehouseCount(base.copy(assignmentsFresh = false)))

        val queued = PendingCount(session.code, item.variantId, 2, "[]", "queued-once", "now")
        assertFalse(canBeginWarehouseCount(base.copy(pending = listOf(queued)), item))
        assertTrue(canReplayWarehouseQueue(base.copy(pending = listOf(queued))))
        assertFalse(canReplayWarehouseQueue(base.copy(pending = listOf(queued), pendingFresh = false)))
        assertFalse(canReplayWarehouseQueue(base.copy(pending = listOf(queued), countFresh = false)))
    }

    @Test
    fun localCountCommitIsMonotonicBeforeRefreshAndQueueFallbackPreservesEntries() {
        val item = item()
        val session = session(item)
        val draft = draft(item, session)
        val committed = session.commitCount(item, draft)

        assertEquals(1, committed.mineCounted)
        assertEquals(1, committed.sessionCounted)
        assertEquals(27, committed.items.single().myCount?.quantity)
        assertTrue(committed.items.single().counted)

        val existing = PendingCount(session.code, 10, 1, "[]", "existing", "now")
        val newlyQueued = PendingCount(session.code, item.variantId, 27, "[]", draft.clientRequestId, "now")
        val preserved = preserveWarehouseQueue(listOf(existing), newlyQueued)
        assertEquals(setOf("existing", draft.clientRequestId), preserved.map { it.clientRequestId }.toSet())
        assertEquals(2, preserveWarehouseQueue(preserved, newlyQueued).size)
    }

    private fun capabilities(products: String, branchId: Long?) = WarehouseCapabilities.fromBootstrap(AppBootstrap(
        user = UserIdentity(5, "موظف", null, null, "warehouse"),
        modules = listOf(ModuleAccess("products", "المنتجات", products)),
        branchId = branchId,
        allBranches = branchId == null,
    ))

    private fun item() = CountItem(
        variantId = 9, productName = "ورق", variantName = "A4", sku = "P-A4", counted = false, myCount = null,
        colleagueCounted = false, units = listOf(CountUnit("كرتون", "12", "BOX", emptyList()), CountUnit("قطعة", "1", "ONE", emptyList())), recountReason = null,
    )

    private fun draft(item: CountItem, session: CountSession) = CountDraft(
        sessionCode = session.code,
        variantId = item.variantId,
        entries = listOf(CountUnitEntry("كرتون", "12", "2"), CountUnitEntry("قطعة", "1", "3")),
        clientRequestId = "7f0fe832-b304-4e13-b37f-00cd88b334e0",
    )

    private fun session(item: CountItem) = CountSession(
        version = "v", code = "CNT-2026-8", name = "جرد", branchName = "الرئيسي", sessionStatus = "COUNTING", duplicatePolicy = "VERIFY", blind = true,
        assignmentId = 4, assignmentName = "عامل", assignmentStatus = "ACTIVE", zone = "A", mineCounted = 0, mineTotal = 1, sessionCounted = 0, sessionTotal = 1,
        items = listOf(item),
    )
}
