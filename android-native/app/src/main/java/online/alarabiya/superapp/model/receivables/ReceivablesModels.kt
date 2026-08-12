package online.alarabiya.superapp.model.receivables

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import online.alarabiya.superapp.model.AppBootstrap

@JvmInline
value class ReceivablesMoney private constructor(val value: String) {
    companion object {
        fun fromServer(raw: String?): ReceivablesMoney = runCatching {
            ReceivablesMoney(
                BigDecimal(raw?.trim().orEmpty().ifBlank { "0" })
                    .setScale(2, RoundingMode.HALF_UP)
                    .toPlainString(),
            )
        }.getOrElse { ReceivablesMoney("0.00") }

        fun validatedInput(raw: String): ReceivablesMoney? = runCatching {
            val decimal = BigDecimal(raw.trim())
            if (decimal.scale() > 2) return null
            ReceivablesMoney(decimal.setScale(2, RoundingMode.UNNECESSARY).toPlainString())
        }.getOrNull()
    }
}

enum class ReceivablesSection(val label: String) {
    INSTALLMENTS("الأقساط"),
    CUSTOMER_REMINDERS("تحصيل العملاء"),
    SUPPLIER_REMINDERS("استحقاقات الموردين"),
    CARD_ACCOUNT("حساب البطاقة"),
    ACCOUNTS("دليل الحسابات"),
}

enum class InstallmentStatus(val label: String) {
    ACTIVE("نشطة"), COMPLETED("مكتملة"), CANCELLED("ملغاة");

    companion object {
        fun fromServer(raw: String): InstallmentStatus? = entries.firstOrNull { it.name == raw.uppercase() }
    }
}

enum class InstallmentLineStatus(val label: String) {
    PENDING("بانتظار السداد"), PAID("مسدّد"), BOUNCED("مرتجع"), CANCELLED("ملغى");

    companion object {
        fun fromServer(raw: String): InstallmentLineStatus? = entries.firstOrNull { it.name == raw.uppercase() }
    }
}

enum class InstallmentKind { CASH, CHECK }

enum class InstallmentPaymentMethod(val label: String) {
    CASH("نقداً"), CARD("بطاقة"), TRANSFER("تحويل"), WALLET("محفظة");
}

data class InstallmentPlanSummary(
    val id: Long,
    val customerId: Long,
    val customerName: String,
    val customerPhone: String?,
    val invoiceId: Long?,
    val branchId: Long,
    val totalAmount: ReceivablesMoney,
    val downPayment: ReceivablesMoney,
    val status: InstallmentStatus,
    val notes: String?,
    val createdAt: String,
    val totalLines: Int,
    val paidLines: Int,
    val paidAmount: ReceivablesMoney,
    val nextDueDate: String?,
)

data class InstallmentLine(
    val id: Long,
    val planId: Long,
    val sequence: Int,
    val dueDate: String,
    val amount: ReceivablesMoney,
    val kind: InstallmentKind,
    val checkNumber: String?,
    val bankName: String?,
    val status: InstallmentLineStatus,
    val receiptId: Long?,
    val paidAt: String?,
    val note: String?,
)

data class InstallmentPlanDetail(
    val summary: InstallmentPlanSummary,
    val lines: List<InstallmentLine>,
)

data class DueInstallment(
    val lineId: Long,
    val planId: Long,
    val branchId: Long,
    val customerId: Long,
    val customerName: String,
    val customerPhone: String?,
    val sequence: Int,
    val dueDate: String,
    val amount: ReceivablesMoney,
    val kind: InstallmentKind,
    val checkNumber: String?,
    val bankName: String?,
    val daysOverdue: Int,
)

data class InstallmentPage(val rows: List<InstallmentPlanSummary>, val hasMore: Boolean)

data class InstallmentFilters(
    val query: String = "",
    val status: InstallmentStatus? = InstallmentStatus.ACTIVE,
    val customerId: String = "",
    val branchId: String = "",
    val from: String = "",
    val to: String = "",
    val dueDays: Int = 7,
) {
    fun validationError(): String? {
        if (query.length > 120) return "عبارة البحث طويلة جداً"
        if (customerId.isNotBlank() && customerId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف العميل غير صالح"
        if (branchId.isNotBlank() && branchId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف الفرع غير صالح"
        if (from.isNotBlank() && !from.isYmd()) return "تاريخ البداية غير صالح"
        if (to.isNotBlank() && !to.isYmd()) return "تاريخ النهاية غير صالح"
        if (from.isNotBlank() && to.isNotBlank() && to < from) return "تاريخ النهاية أقدم من البداية"
        if (dueDays !in 0..90) return "نافذة الاستحقاق غير صالحة"
        return null
    }
}

data class NewInstallmentLine(val dueDate: String = "", val amount: String = "") {
    fun validationError(index: Int): String? {
        if (!dueDate.isYmd()) return "تاريخ القسط ${index + 1} غير صالح"
        val money = ReceivablesMoney.validatedInput(amount) ?: return "مبلغ القسط ${index + 1} غير صالح"
        if (BigDecimal(money.value) <= BigDecimal.ZERO) return "مبلغ القسط ${index + 1} يجب أن يكون موجباً"
        return null
    }
}

data class NewInstallmentPlan(
    val customerId: String = "",
    val invoiceId: String = "",
    val branchId: String = "",
    val totalAmount: String = "",
    val downPayment: String = "0",
    val notes: String = "",
    val lines: List<NewInstallmentLine> = listOf(NewInstallmentLine()),
) {
    /** Structural validation only. The server remains the sole authority for all financial sums. */
    fun validationError(): String? {
        if (customerId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف العميل مطلوب"
        if (invoiceId.isNotBlank() && invoiceId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف الفاتورة غير صالح"
        if (branchId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف الفرع مطلوب"
        val total = ReceivablesMoney.validatedInput(totalAmount) ?: return "إجمالي الخطة غير صالح"
        if (BigDecimal(total.value) <= BigDecimal.ZERO) return "إجمالي الخطة يجب أن يكون موجباً"
        // قرار المالك (١٢/٨) — «لا دينار بلا سند»: الدفعة الأولى تُسجَّل سندَ قبضٍ فعليّاً أولاً ثم تُنشأ
        // الخطة على المتبقّي؛ فالخادم يرفض أيّ دفعةٍ أولى (enforceFinancialIntegrity). نحرسها هنا أيضاً
        // (الحقل أُزيل من الشاشة فتبقى "0"، وهذا حارسٌ دفاعيّ لأيّ مسارٍ يضبطها).
        val down = ReceivablesMoney.validatedInput(downPayment.ifBlank { "0" }) ?: return "الدفعة الأولى غير صالحة"
        if (BigDecimal(down.value).signum() != 0) return "الدفعة الأولى تُسجَّل سندَ قبضٍ نقديٍّ أولاً — أنشئ الخطة على المتبقّي (لا دينار بلا سند)"
        if (notes.length > 1000) return "الملاحظات أطول من الحد المسموح"
        if (lines.isEmpty() || lines.size > 60) return "عدد الأقساط يجب أن يكون بين 1 و60"
        lines.forEachIndexed { index, line -> line.validationError(index)?.let { return it } }
        if (lines.zipWithNext().any { (first, second) -> second.dueDate < first.dueDate }) return "تواريخ الأقساط يجب أن تكون متصاعدة"
        return null
    }
}

data class InstallmentPaymentResult(
    val status: String,
    val receiptId: Long,
    val voucherNumber: String,
    val planCompleted: Boolean,
)

enum class ReminderLedger(val label: String) { RECEIVABLE("عميل"), PAYABLE("مورد") }
enum class ReminderStatus { SENT, SKIPPED }

data class ReminderSubject(
    val ledger: ReminderLedger,
    val id: Long,
    val name: String,
    val phone: String?,
)

data class ReminderQueueItem(
    val subject: ReminderSubject,
    val totalUnpaid: ReceivablesMoney,
    val oldestDocumentDate: String,
    val daysOverdue: Int,
    val lastReminderAt: String?,
    val lastReminderStatus: ReminderStatus?,
    val promisedDate: String?,
    val isPromiseDue: Boolean,
    val isOpeningBalance: Boolean,
)

data class ReminderHistoryItem(
    val id: Long,
    val subject: ReminderSubject,
    val totalUnpaid: ReceivablesMoney,
    val daysOverdue: Int,
    val status: ReminderStatus,
    val skipReason: String?,
    val promisedDate: String?,
    val createdBy: Long,
    val createdAt: String,
)

data class ReminderSendResult(val sent: Boolean, val reminderId: Long?, val reason: String?)

data class ReminderFilter(
    val branchId: String = "",
    val aggregate: Boolean = false,
) {
    fun branchIdOrNull(): Long? = branchId.toLongOrNull()?.takeIf { it > 0 }
    fun validationError(branchRequired: Boolean): String? = when {
        branchId.isNotBlank() && branchIdOrNull() == null -> "معرّف الفرع غير صالح"
        branchRequired && branchIdOrNull() == null -> "حدّد الفرع أولاً"
        else -> null
    }
}

data class ReminderActionDraft(
    val item: ReminderQueueItem,
    val kind: Kind,
    val reason: String = "",
    val promisedDate: String = "",
) {
    enum class Kind { SEND_API, SKIP }

    fun validationError(today: LocalDate = LocalDate.now()): String? {
        if (kind == Kind.SKIP && reason.trim().isEmpty()) return "سبب التأجيل أو التخطّي مطلوب"
        if (reason.length > 255) return "السبب أطول من الحد المسموح"
        if (promisedDate.isNotBlank() && !promisedDate.isYmd()) return "تاريخ الوعد غير صالح"
        if (promisedDate.isNotBlank() && promisedDate < today.toString()) return "تاريخ الوعد لا يمكن أن يكون في الماضي"
        return null
    }
}

data class CardSummary(
    val branchId: Long?,
    val balance: ReceivablesMoney,
    val totalIn: ReceivablesMoney,
    val totalOut: ReceivablesMoney,
    val todayIn: ReceivablesMoney,
    val todayOut: ReceivablesMoney,
    val movementCount: Int,
    val lastReconciliation: CardReconciliation?,
)

enum class CardDirection { IN, OUT }
enum class CardSource { VOUCHER, INVOICE_PAYMENT, WORK_ORDER, OTHER }

data class CardMovement(
    val receiptId: Long,
    val branchId: Long?,
    val branchName: String?,
    val createdAt: String?,
    val direction: CardDirection,
    val amount: ReceivablesMoney,
    val runningBalance: ReceivablesMoney?,
    val lastFour: String?,
    val reference: String?,
    val voucherNumber: String?,
    val invoiceId: Long?,
    val source: CardSource,
    val partyName: String?,
    val description: String?,
    val createdByName: String?,
    val reversed: Boolean,
)

data class CardMovementPage(
    val rows: List<CardMovement>,
    val count: Int,
    val totalIn: ReceivablesMoney,
    val totalOut: ReceivablesMoney,
    val net: ReceivablesMoney,
    val hasMore: Boolean,
    val branchId: Long?,
)

data class CardReconciliation(
    val id: Long,
    val branchId: Long,
    val branchName: String?,
    val asOfDate: String,
    val systemBalance: ReceivablesMoney,
    val statementBalance: ReceivablesMoney,
    val difference: ReceivablesMoney,
    val statementLabel: String?,
    val note: String?,
    val createdByName: String?,
    val createdAt: String?,
)

data class CardFilters(
    val branchId: String = "",
    val from: String = "",
    val to: String = "",
    val query: String = "",
    val direction: CardDirection? = null,
    val source: CardSource? = null,
) {
    fun validationError(): String? {
        if (branchId.isNotBlank() && branchId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف الفرع غير صالح"
        if (from.isNotBlank() && !from.isYmd()) return "تاريخ البداية غير صالح"
        if (to.isNotBlank() && !to.isYmd()) return "تاريخ النهاية غير صالح"
        if (from.isNotBlank() && to.isNotBlank() && to < from) return "تاريخ النهاية أقدم من البداية"
        if (query.length > 200) return "عبارة البحث طويلة جداً"
        return null
    }
}

data class ReconciliationDraft(
    val branchId: String = "",
    val asOfDate: String = LocalDate.now().toString(),
    val statementBalance: String = "",
    val statementLabel: String = "",
    val note: String = "",
) {
    fun validationError(): String? {
        if (branchId.toLongOrNull()?.takeIf { it > 0 } == null) return "معرّف الفرع مطلوب"
        if (!asOfDate.isYmd()) return "تاريخ المطابقة غير صالح"
        if (ReceivablesMoney.validatedInput(statementBalance) == null) return "رصيد كشف البنك غير صالح"
        if (statementLabel.length > 120) return "اسم الكشف أطول من الحد المسموح"
        if (note.length > 1000) return "الملاحظات أطول من الحد المسموح"
        return null
    }
}

enum class AccountType(val label: String) {
    ASSET("الأصول"), LIABILITY("الالتزامات"), EQUITY("حقوق الملكية"), REVENUE("الإيرادات"), EXPENSE("المصروفات");

    companion object {
        fun fromServer(raw: String): AccountType? = entries.firstOrNull { it.name == raw.uppercase() }
    }
}

data class LedgerAccount(
    val id: Long,
    val code: String,
    val name: String,
    val type: AccountType,
    val parentId: Long?,
    val systemRole: String?,
    val active: Boolean,
    val sortOrder: Int,
)

data class AccountGroup(val type: AccountType, val label: String, val rows: List<LedgerAccount>)

data class ReceivablesAccessPolicy(
    val readableSections: Set<ReceivablesSection>,
    val writableSections: Set<ReceivablesSection>,
    val assignedBranchId: Long?,
    val canFilterBranch: Boolean,
    val canCreateReconciliation: Boolean,
    val canReadOpeningReceivables: Boolean,
    val canReadAllPayables: Boolean,
) {
    fun canRead(section: ReceivablesSection) = section in readableSections
    fun canWrite(section: ReceivablesSection) = section in writableSections

    companion object {
        /**
         * Bootstrap exposes effective levels but not explicit-grant provenance. To avoid widening sensitive
         * financial access, native uses only the server's standard role sets; custom explicit grants remain
         * unavailable until bootstrap carries provenance.
         */
        fun fromBootstrap(
            bootstrap: AppBootstrap,
            effectiveBranchId: Long? = bootstrap.branchId,
        ): ReceivablesAccessPolicy {
            val levels = bootstrap.modules.associate { it.key to it.access.uppercase() }
            fun reads(module: String) = levels[module] in setOf("READ", "FULL")
            fun writes(module: String) = levels[module] == "FULL"
            val role = bootstrap.user.role.lowercase()
            val admin = role == "admin"
            val reportRole = role in setOf("admin", "manager", "accountant", "auditor")
            val installmentRole = role in setOf("admin", "manager", "accountant")
            val arRole = role in setOf("admin", "manager", "accountant")
            val apRole = role in setOf("admin", "manager", "warehouse", "purchasing")
            val ownBranchReady = admin || role == "manager" || effectiveBranchId != null
            val reminderBranchReady = admin || effectiveBranchId != null
            val writeBranchReady = admin || effectiveBranchId != null

            val readable = buildSet {
                if (installmentRole && reads("treasury") && ownBranchReady) add(ReceivablesSection.INSTALLMENTS)
                if (arRole && writes("collections") && reminderBranchReady) add(ReceivablesSection.CUSTOMER_REMINDERS)
                if (apRole && writes("suppliers") && reminderBranchReady) add(ReceivablesSection.SUPPLIER_REMINDERS)
                if (reportRole && reads("reports")) {
                    add(ReceivablesSection.CARD_ACCOUNT)
                    add(ReceivablesSection.ACCOUNTS)
                }
            }
            val writable = buildSet {
                if (installmentRole && writes("treasury") && writeBranchReady) add(ReceivablesSection.INSTALLMENTS)
                if (arRole && writes("collections") && writeBranchReady) add(ReceivablesSection.CUSTOMER_REMINDERS)
                if (apRole && writes("suppliers") && writeBranchReady) add(ReceivablesSection.SUPPLIER_REMINDERS)
            }
            return ReceivablesAccessPolicy(
                readableSections = readable,
                writableSections = writable,
                assignedBranchId = effectiveBranchId,
                canFilterBranch = admin,
                canCreateReconciliation = reportRole && reads("reports") &&
                    role in setOf("admin", "manager", "accountant") && writeBranchReady,
                canReadOpeningReceivables = admin && ReceivablesSection.CUSTOMER_REMINDERS in readable,
                canReadAllPayables = admin && ReceivablesSection.SUPPLIER_REMINDERS in readable,
            )
        }
    }
}

private fun String.isYmd(): Boolean = runCatching { LocalDate.parse(this) }.isSuccess
