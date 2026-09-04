package online.alarabiya.superapp.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import java.security.MessageDigest
import java.time.Instant
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import online.alarabiya.superapp.core.network.ApiException
import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.core.security.EncryptedBlobCodec
import online.alarabiya.superapp.model.warehouseTools.*
import org.json.JSONArray
import org.json.JSONObject

interface WarehouseToolsDataSource {
    suspend fun verifySignedBarcode(payload: String): SignedBarcodeResult
    suspend fun assignments(): List<CountAssignment>
    suspend fun countSession(sessionCode: String): CountSession
    fun cachedCount(sessionCode: String): CountSession?
    suspend fun submitCount(session: CountSession, item: CountItem, draft: CountDraft): CountSubmitOutcome
    suspend fun finishCount(sessionCode: String): FinishCountResult
    fun pendingCounts(sessionCode: String? = null): List<PendingCount>
    suspend fun replayPendingCounts(): QueueReplayResult
    fun discardPendingCount(clientRequestId: String)
    suspend fun syncWarehouseSnapshot(): WarehouseSnapshot
    fun cachedWarehouseSnapshot(): WarehouseSnapshot?
}

class WarehouseToolsRepository(
    private val api: TrpcClient,
    private val capabilities: WarehouseCapabilities,
    private val store: EncryptedWarehouseStore,
    private val now: () -> String = { Instant.now().toString() },
) : WarehouseToolsDataSource {
    private fun allow(condition: Boolean) = check(condition) { "لا تملك صلاحية تنفيذ هذه العملية" }

    override suspend fun verifySignedBarcode(payload: String): SignedBarcodeResult {
        allow(capabilities.canVerifySignedBarcode)
        val normalized = payload.trim()
        require(normalized.isNotEmpty() && normalized.length <= 1_000) { "محتوى الرمز غير صالح" }
        return WarehouseToolsMappers.signedBarcode(api.query("barcode.verify", JSONObject().put("payload", normalized)))
    }

    override suspend fun assignments(): List<CountAssignment> {
        allow(capabilities.canUseAssignedCounts)
        return try {
            WarehouseToolsMappers.assignments(api.queryArray("count.mine")).also(store::saveAssignments)
        } catch (error: ApiException) {
            if (!WarehouseRetryPolicy.canQueue(error.status)) throw error
            store.loadAssignments()
        }
    }

    override suspend fun countSession(sessionCode: String): CountSession {
        allow(capabilities.canUseAssignedCounts)
        val code = normalizedSessionCode(sessionCode)
        val cached = store.loadCount(code)
        var root = try {
            api.query("count.state", JSONObject().put("sessionCode", code).apply { cached?.version?.let { put("knownVersion", it) } })
        } catch (error: ApiException) {
            if (WarehouseRetryPolicy.canQueue(error.status) && cached != null) return cached
            throw error
        }
        val version = root.optString("v")
        if (!root.optBoolean("changed")) {
            if (cached != null) return cached.copy(version = version)
            root = api.query("count.state", JSONObject().put("sessionCode", code))
        }
        val state = root.optJSONObject("state") ?: error("لم يعد الخادم حالة الجرد")
        return WarehouseToolsMappers.countSession(state, root.optString("v")).also(store::saveCount)
    }

    override fun cachedCount(sessionCode: String): CountSession? = store.loadCount(normalizedSessionCode(sessionCode))

    override suspend fun submitCount(session: CountSession, item: CountItem, draft: CountDraft): CountSubmitOutcome {
        allow(capabilities.canUseAssignedCounts)
        WarehouseValidation.count(session, item, draft)?.let { throw IllegalArgumentException(it) }
        val submission = WarehouseValidation.submission(draft)
        if (WarehouseQueueRules.mustSerialize(store.pending(), submission.sessionCode, submission.variantId)) {
            val pending = submission.pending(now())
            store.enqueue(pending)
            return CountSubmitOutcome.Queued(pending)
        }
        val input = submission.inputJson()
        return try {
            CountSubmitOutcome.Submitted(WarehouseToolsMappers.countReceipt(api.mutate("count.submit", input)))
        } catch (error: ApiException) {
            if (!WarehouseRetryPolicy.canQueue(error.status)) throw error
            val pending = submission.pending(now())
            store.enqueue(pending)
            CountSubmitOutcome.Queued(pending)
        }
    }

    override suspend fun finishCount(sessionCode: String): FinishCountResult {
        allow(capabilities.canUseAssignedCounts)
        val code = normalizedSessionCode(sessionCode)
        check(store.pending(code).isEmpty()) { "عالج جميع العدّات المحلية قبل تسليم الجرد" }
        return WarehouseToolsMappers.finish(api.mutate("count.finish", JSONObject().put("sessionCode", code)))
    }

    override fun pendingCounts(sessionCode: String?): List<PendingCount> = store.pending(sessionCode?.let(::normalizedSessionCode))

    override suspend fun replayPendingCounts(): QueueReplayResult {
        allow(capabilities.canUseAssignedCounts)
        var sent = 0
        var rejected = 0
        for (pending in store.pending().filter { it.status == PendingCountStatus.QUEUED }) {
            try {
                api.mutate("count.submit", pending.inputJson())
                store.removePending(pending.clientRequestId)
                sent++
            } catch (error: ApiException) {
                when {
                    WarehouseRetryPolicy.canQueue(error.status) || WarehouseRetryPolicy.authenticationRequired(error.status) -> break
                    else -> {
                        store.rejectPending(pending.clientRequestId, error.message ?: "رفض الخادم العدّة")
                        rejected++
                    }
                }
            }
        }
        return QueueReplayResult(sent, rejected, store.pending().size)
    }

    override fun discardPendingCount(clientRequestId: String) {
        require(clientRequestId.isNotBlank())
        store.removePending(clientRequestId)
    }

    override suspend fun syncWarehouseSnapshot(): WarehouseSnapshot {
        allow(capabilities.canSyncWarehouseSnapshot)
        val branchId = requireNotNull(capabilities.branchId) { "لا يوجد فرع مرتبط بالجلسة" }
        val versions = api.query("offline.versions")
        val catalogVersion = versions.optString("catalogVersion")
        val cached = store.loadSnapshot()?.takeIf { it.branchId == branchId && it.userId == capabilities.userId }
        val stock = api.queryArray("offline.stockSnapshot", JSONObject().put("branchId", branchId))
        val syncedAt = now()
        val snapshot = if (cached != null && cached.catalogVersion == catalogVersion) {
            WarehouseToolsMappers.withStock(cached, stock, syncedAt)
        } else {
            WarehouseToolsMappers.warehouseSnapshot(api.query("offline.catalogSnapshot"), stock, capabilities.userId, branchId, syncedAt)
        }
        require(snapshot.branchId == branchId && snapshot.userId == capabilities.userId) { "نطاق اللقطة المحلية غير صالح" }
        store.saveSnapshot(snapshot)
        return snapshot
    }

    override fun cachedWarehouseSnapshot(): WarehouseSnapshot? = store.loadSnapshot()
        ?.takeIf { it.userId == capabilities.userId && it.branchId == capabilities.branchId }

    private fun normalizedSessionCode(value: String): String {
        val code = value.trim().uppercase()
        require(code.length in 4..40 && code.matches(Regex("^[A-Z0-9-]+$"))) { "رمز الجلسة غير صالح" }
        return code
    }
}

class EncryptedWarehouseStore(context: Context, private val userId: Long) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val namespace = MessageDigest.getInstance("SHA-256").digest("user:$userId".toByteArray())
        .take(12).joinToString("") { "%02x".format(it) }

    @Synchronized fun saveSnapshot(value: WarehouseSnapshot) = write(snapshotKey, WarehouseToolsMappers.snapshotJson(value).toString())
    @Synchronized fun loadSnapshot(): WarehouseSnapshot? = read(snapshotKey)?.let { runCatching { WarehouseToolsMappers.cachedSnapshot(JSONObject(it)) }.getOrNull() }
    @Synchronized fun saveAssignments(values: List<CountAssignment>) = write(assignmentsKey, WarehouseToolsMappers.assignmentsJson(values).toString())
    @Synchronized fun loadAssignments(): List<CountAssignment> = read(assignmentsKey)?.let { runCatching { WarehouseToolsMappers.cachedAssignments(JSONArray(it)) }.getOrNull() }.orEmpty()
    @Synchronized fun saveCount(value: CountSession) = write(countKey(value.code), WarehouseToolsMappers.countJson(value).toString())
    @Synchronized fun loadCount(code: String): CountSession? = read(countKey(code))?.let { runCatching { WarehouseToolsMappers.cachedCount(JSONObject(it)) }.getOrNull() }

    @Synchronized fun enqueue(value: PendingCount) {
        val current = pending().filterNot { it.clientRequestId == value.clientRequestId }
        require(current.size < MAX_PENDING_COUNTS) { "طابور العد المحلي ممتلئ؛ زامنه قبل إضافة عدّات جديدة" }
        val values = current + value
        write(pendingKey, WarehouseToolsMappers.pendingJson(values).toString())
    }

    @Synchronized fun pending(sessionCode: String? = null): List<PendingCount> {
        val persisted = preferences.contains(pendingKey)
        val raw = read(pendingKey)
        check(!persisted || raw != null) { "تعذر فك تشفير طابور العد المحلي؛ لا تتابع قبل معالجة بيانات الجهاز" }
        val values = raw?.let {
            runCatching { WarehouseToolsMappers.pending(JSONArray(it)) }
                .getOrElse { error -> throw SecurityException("طابور العد المحلي تالف؛ أُوقف التسليم حمايةً للعدّات", error) }
        }.orEmpty()
        return if (sessionCode == null) values else values.filter { it.sessionCode == sessionCode }
    }

    @Synchronized fun removePending(clientRequestId: String) {
        write(pendingKey, WarehouseToolsMappers.pendingJson(pending().filterNot { it.clientRequestId == clientRequestId }).toString())
    }

    @Synchronized fun rejectPending(clientRequestId: String, error: String) {
        val values = pending().map { if (it.clientRequestId == clientRequestId) it.copy(status = PendingCountStatus.REJECTED, lastError = error.take(240)) else it }
        write(pendingKey, WarehouseToolsMappers.pendingJson(values).toString())
    }

    @Synchronized fun clear() {
        preferences.edit {
            preferences.all.keys.filter { it.startsWith("$namespace:") }.forEach { key -> remove(key) }
        }
    }

    private val snapshotKey get() = "$namespace:snapshot"
    private val assignmentsKey get() = "$namespace:assignments"
    private val pendingKey get() = "$namespace:pending"
    private fun countKey(code: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(code.toByteArray()).take(12).joinToString("") { "%02x".format(it) }
        return "$namespace:count:$digest"
    }

    private fun write(key: String, plaintext: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        cipher.updateAAD("$userId:$key".toByteArray(Charsets.UTF_8))
        val encoded = Base64.encodeToString(EncryptedBlobCodec.pack(cipher.iv, cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))), Base64.NO_WRAP)
        preferences.edit { putString(key, encoded) }
    }

    private fun read(key: String): String? {
        val encoded = preferences.getString(key, null) ?: return null
        return runCatching {
            val blob = EncryptedBlobCodec.unpack(Base64.decode(encoded, Base64.NO_WRAP))
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, blob.iv))
            cipher.updateAAD("$userId:$key".toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(blob.ciphertext), Charsets.UTF_8)
        }.getOrElse {
            preferences.edit { remove(key) }
            null
        }
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
            generateKey()
        }
    }

    private companion object {
        const val PREFERENCES = "alrueya_warehouse_secure_v1"
        const val KEY_ALIAS = "alrueya_warehouse_offline_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val MAX_PENDING_COUNTS = 2_000
    }
}

internal fun CountSubmission.inputJson() = JSONObject().put("sessionCode", sessionCode).put("variantId", variantId)
    .put("qty", quantityBase).put("unitBreakdown", unitBreakdown).put("clientRequestId", clientRequestId)
    .put("entryMethod", entryMethod).apply { scannedBarcode?.let { put("scannedBarcode", it) } }
private fun CountSubmission.pending(createdAt: String) = PendingCount(
    sessionCode = sessionCode,
    variantId = variantId,
    quantityBase = quantityBase,
    unitBreakdown = unitBreakdown,
    clientRequestId = clientRequestId,
    createdAt = createdAt,
    entryMethod = entryMethod,
    scannedBarcode = scannedBarcode,
)
internal fun PendingCount.inputJson() = JSONObject().put("sessionCode", sessionCode).put("variantId", variantId)
    .put("qty", quantityBase).put("unitBreakdown", unitBreakdown).put("clientRequestId", clientRequestId)
    .put("entryMethod", entryMethod).apply { scannedBarcode?.let { put("scannedBarcode", it) } }
