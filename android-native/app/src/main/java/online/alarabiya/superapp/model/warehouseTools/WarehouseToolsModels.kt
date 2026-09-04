package online.alarabiya.superapp.model.warehouseTools

import java.math.BigDecimal
import java.util.UUID
import online.alarabiya.superapp.core.scanner.nativeBarcodesEquivalent
import online.alarabiya.superapp.core.scanner.normalizeNativeBarcode
import online.alarabiya.superapp.model.AppBootstrap

enum class WarehouseSection { SCANNER, COUNTS, OFFLINE }
enum class WarehouseAccess { NONE, READ, FULL;
    val canRead get() = this != NONE
    companion object { fun wire(value: String?) = entries.firstOrNull { it.name == value } ?: NONE }
}

data class WarehouseCapabilities(
    val products: WarehouseAccess,
    val branchId: Long?,
    val userId: Long,
) {
    val canVerifySignedBarcode get() = true
    val canUseAssignedCounts get() = true
    val canSyncWarehouseSnapshot get() = products.canRead && branchId != null
    val sections get() = buildList {
        add(WarehouseSection.SCANNER)
        if (canUseAssignedCounts) add(WarehouseSection.COUNTS)
        if (canSyncWarehouseSnapshot) add(WarehouseSection.OFFLINE)
    }

    companion object {
        fun fromBootstrap(value: AppBootstrap) = WarehouseCapabilities(
            products = WarehouseAccess.wire(value.modules.firstOrNull { it.key == "products" }?.access),
            branchId = value.branchId,
            userId = value.user.id,
        )
    }
}

data class SignedBarcodeResult(
    val valid: Boolean,
    val documentType: String?,
    val number: String?,
    val date: String?,
    val amount: String?,
    val branchId: Long?,
)

data class WarehouseCatalogItem(
    val productUnitId: Long,
    val productId: Long,
    val productName: String,
    val variantId: Long,
    val variantName: String?,
    val sku: String,
    val unitName: String,
    val conversionFactor: String,
    val barcodes: List<String>,
    val isBaseUnit: Boolean,
    val stockBase: Int?,
) {
    val label get() = listOfNotNull(productName, variantName).joinToString(" · ")
    fun exactMatch(raw: String): Boolean {
        val value = normalizeNativeBarcode(raw) ?: return false
        return sku.equals(value, true) || barcodes.any { nativeBarcodesEquivalent(it, value) }
    }
}

data class WarehouseSnapshot(
    val userId: Long,
    val branchId: Long,
    val catalogVersion: String,
    val generatedAt: String,
    val syncedAt: String,
    val items: List<WarehouseCatalogItem>,
) {
    fun exactMatch(raw: String): WarehouseCatalogItem? = items.firstOrNull { it.exactMatch(raw) }
}

data class CountAssignment(
    val sessionCode: String,
    val sessionName: String,
    val branchId: Long,
    val assignmentId: Long,
    val status: String,
    val zone: String?,
    val lastActivityAt: String?,
)

data class CountUnit(val name: String, val factor: String, val barcode: String?, val aliases: List<String>) {
    val barcodes get() = listOfNotNull(barcode) + aliases
}
data class MyCount(val quantity: Int, val at: String?, val unitBreakdown: String?)
data class CountItem(
    val variantId: Long,
    val productName: String,
    val variantName: String?,
    val sku: String,
    val counted: Boolean,
    val myCount: MyCount?,
    val colleagueCounted: Boolean,
    val units: List<CountUnit>,
    val recountReason: String?,
) {
    val label get() = listOfNotNull(productName, variantName, sku.takeIf(String::isNotBlank)).joinToString(" · ")
    fun exactMatch(raw: String): Boolean {
        val value = normalizeNativeBarcode(raw) ?: return false
        return sku.equals(value, true) || barcodeMatch(value) != null
    }

    fun barcodeMatch(raw: String): String? {
        val value = normalizeNativeBarcode(raw) ?: return null
        return value.takeIf { units.any { unit -> unit.barcodes.any { nativeBarcodesEquivalent(it, value) } } }
    }
}

data class CountSession(
    val version: String,
    val code: String,
    val name: String,
    val branchName: String,
    val sessionStatus: String,
    val duplicatePolicy: String,
    val blind: Boolean,
    val assignmentId: Long,
    val assignmentName: String,
    val assignmentStatus: String,
    val zone: String?,
    val mineCounted: Int,
    val mineTotal: Int,
    val sessionCounted: Int,
    val sessionTotal: Int,
    val items: List<CountItem>,
    val countMethod: String = "FREE",
) {
    val active get() = sessionStatus == "COUNTING" && assignmentStatus == "ACTIVE"
    fun exactMatch(raw: String): CountItem? = items.firstOrNull { it.exactMatch(raw) }
    fun barcodeMatch(raw: String): Pair<CountItem, String>? = items.firstNotNullOfOrNull { item ->
        item.barcodeMatch(raw)?.let { item to it }
    }
    fun canCount(item: CountItem): Boolean = active && (item.myCount != null || item.recountReason != null || duplicatePolicy != "BLOCK" || !item.colleagueCounted)
}

data class CountUnitEntry(val unitName: String, val factor: String, val quantity: String = "")
data class CountDraft(
    val sessionCode: String,
    val variantId: Long,
    val entries: List<CountUnitEntry>,
    val clientRequestId: String,
    val entryMethod: String = "SEARCH_PICK",
    val scannedBarcode: String? = null,
)
data class CountSubmission(
    val sessionCode: String,
    val variantId: Long,
    val quantityBase: Int,
    val unitBreakdown: String,
    val clientRequestId: String,
    val entryMethod: String = "SEARCH_PICK",
    val scannedBarcode: String? = null,
)
data class CountReceipt(val kind: String, val verifyMatch: Boolean?, val idempotent: Boolean)
sealed interface CountSubmitOutcome {
    data class Submitted(val receipt: CountReceipt) : CountSubmitOutcome
    data class Queued(val pending: PendingCount) : CountSubmitOutcome
}

enum class PendingCountStatus { QUEUED, REJECTED }
data class PendingCount(
    val sessionCode: String,
    val variantId: Long,
    val quantityBase: Int,
    val unitBreakdown: String,
    val clientRequestId: String,
    val createdAt: String,
    val status: PendingCountStatus = PendingCountStatus.QUEUED,
    val lastError: String? = null,
    val entryMethod: String = "SEARCH_PICK",
    val scannedBarcode: String? = null,
)
data class QueueReplayResult(val sent: Int, val rejected: Int, val remaining: Int)
data class FinishCountResult(val movedToReview: Boolean)

object WarehouseValidation {
    fun count(session: CountSession, item: CountItem, draft: CountDraft): String? {
        if (!session.active) return "جلسة العد أو التكليف غير نشط"
        if (!session.canCount(item)) return "سياسة الجلسة تمنع تكرار عد هذا الصنف"
        if (draft.sessionCode != session.code || draft.variantId != item.variantId) return "بيانات العد لا تطابق الجلسة"
        if (item.variantId <= 0) return "معرّف الصنف غير صالح"
        if (runCatching { UUID.fromString(draft.clientRequestId).toString().equals(draft.clientRequestId, true) }.getOrDefault(false).not()) return "مفتاح الطلب غير صالح"
        if (draft.entries.isEmpty()) return "أدخل كمية واحدة على الأقل"
        if (session.countMethod == "SCAN_REQUIRED") {
            if (draft.entryMethod != "SCAN_CAMERA" && draft.entryMethod != "SCAN_HID") return "هذه الجلسة تتطلب مسح الباركود بالكاميرا أو القارئ"
            val scanned = draft.scannedBarcode ?: return "امسح باركود الصنف قبل تسجيل العد"
            if (item.barcodeMatch(scanned) == null) return "الباركود الممسوح لا يخص هذا الصنف"
        }
        val allowed = item.units.ifEmpty { listOf(CountUnit("الوحدة الأساس", "1", null, emptyList())) }
        if (draft.entries.size != allowed.size || draft.entries.map { it.unitName }.toSet().size != draft.entries.size) return "وحدات الإدخال لا تطابق الصنف"
        draft.entries.forEach { entry ->
            val unit = allowed.firstOrNull { it.name == entry.unitName } ?: return "وحدة ${entry.unitName} غير صالحة"
            val expected = unit.factor.toBigDecimalOrNull() ?: return "معامل ${entry.unitName} غير صالح"
            val received = entry.factor.toBigDecimalOrNull() ?: return "معامل ${entry.unitName} غير صالح"
            if (expected.compareTo(received) != 0) return "معامل ${entry.unitName} لا يطابق بيانات الجرد"
        }
        var total = BigDecimal.ZERO
        var entered = false
        for (entry in draft.entries) {
            if (entry.quantity.isBlank()) continue
            entered = true
            val quantity = entry.quantity.toBigDecimalOrNull() ?: return "كمية ${entry.unitName} غير صالحة"
            val factor = entry.factor.toBigDecimalOrNull() ?: return "معامل ${entry.unitName} غير صالح"
            if (quantity.signum() < 0 || quantity.stripTrailingZeros().scale() > 0) return "كمية ${entry.unitName} يجب أن تكون عدداً صحيحاً غير سالب"
            if (factor.signum() <= 0) return "معامل ${entry.unitName} غير صالح"
            total = total.add(quantity.multiply(factor))
        }
        if (!entered) return "أدخل كمية واحدة على الأقل"
        if (total.stripTrailingZeros().scale() > 0) return "تحويل الوحدات لا ينتج كمية أساس صحيحة"
        if (total > BigDecimal("99999999")) return "الكمية أكبر من الحد المسموح"
        if (breakdown(draft.entries.filter { it.quantity.isNotBlank() }).length > 500) return "تفصيل الوحدات أطول من المسموح"
        return null
    }

    fun submission(draft: CountDraft): CountSubmission {
        val populated = draft.entries.filter { it.quantity.isNotBlank() }
        val total = populated.fold(BigDecimal.ZERO) { sum, entry ->
            sum.add(requireNotNull(entry.quantity.toBigDecimalOrNull()).multiply(requireNotNull(entry.factor.toBigDecimalOrNull())))
        }.intValueExact()
        val breakdown = breakdown(populated)
        require(breakdown.length <= 500) { "تفصيل الوحدات أطول من المسموح" }
        return CountSubmission(
            draft.sessionCode,
            draft.variantId,
            total,
            breakdown,
            draft.clientRequestId,
            draft.entryMethod,
            draft.scannedBarcode,
        )
    }

    private fun breakdown(entries: List<CountUnitEntry>) = entries.joinToString(prefix = "[", postfix = "]") { entry ->
        "{\"unit\":\"${entry.unitName.jsonEscape()}\",\"qty\":${entry.quantity},\"factor\":\"${entry.factor.jsonEscape()}\"}"
    }

    private fun String.jsonEscape() = buildString {
        for (char in this@jsonEscape) when (char) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(char)
        }
    }
}

object WarehouseRetryPolicy {
    fun canQueue(status: Int?): Boolean = status?.let { it == 408 || it == 425 || it in 500..599 } ?: true
    fun authenticationRequired(status: Int?): Boolean = status == 401 || status == 403
}

object WarehouseQueueRules {
    fun mustSerialize(existing: List<PendingCount>, sessionCode: String, variantId: Long): Boolean =
        existing.any { it.status == PendingCountStatus.QUEUED && it.sessionCode == sessionCode && it.variantId == variantId }
}

object NativeWarehouseContractGaps {
    const val PIN_COOKIE = "وضع PIN لبوابة العد غير معروض في التطبيق الأصلي: عميل الشبكة الحالي يخزن كوكي جلسة واحدة وقد يستبدل جلسة النظام بـ count_token. تكليفات USER تعمل مباشرة بحساب المستخدم."
    const val FINISH_OFFLINE = "count.finish لا يقبل clientRequestId صريحاً؛ الإنهاء متاح أونلاين فقط ولا يدخل طابور المزامنة."
    const val OFFLINE_SALES = "offline.replaySale خارج أدوات المخزن: يحتاج وردية POS وأسعاراً مقبوضة واعتماد مدير، ولا يُنشأ بيع أوفلاين من هذه الوحدة."
    const val SIGNED_QR_OFFLINE = "barcode.verify يحتاج سر HMAC الخادمي؛ لا يدّعي التطبيق التحقق من QR الموقّع دون اتصال."
    const val COUNT_KEY_HISTORY = "count.submit يخزن clientRequestId على صف العد القابل للتحديث لا في سجل مفاتيح مستقل؛ لذلك يسلسل التطبيق العدّات المعلقة للصنف نفسه ويحظر تجاوز الأقدم قبل الأحدث."
    const val BACKGROUND_SYNC = "المزامنة في هذه الدفعة يدوية ومرئية؛ لم تُضف مهمة خلفية أو ادعاء مزامنة تلقائية من دون WorkManager وسياسة شبكة/بطارية يراجعها التطبيق ككل."
}
