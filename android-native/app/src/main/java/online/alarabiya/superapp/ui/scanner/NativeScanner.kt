package online.alarabiya.superapp.ui.scanner

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.DocumentScanner
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.OptionalModuleApi
import com.google.android.gms.common.moduleinstall.InstallStatusListener
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallClient
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.coroutineContext
import kotlin.math.max
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import online.alarabiya.superapp.core.scanner.NativeScanEngine
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.core.scanner.normalizeNativeScanResult
import online.alarabiya.superapp.core.scanner.scanEngineOrNull

internal const val MAX_OCR_IMAGE_EDGE = 2_048
private const val MODULE_INSTALL_TIMEOUT_MS = 120_000L
private const val STALE_CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1_000L

/**
 * Delegates barcode capture and ML inference to downloadable Google Play services modules. OCR uses
 * the platform camera activity and a private cache URI; image decoding is bounded and off-main.
 * No camera or ML native engine is embedded in the application bundle.
 */
@Composable
fun NativeScannerAction(
    field: NativeScanField,
    onScanned: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val engine = field.scanEngineOrNull() ?: return
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val latestOnScanned by rememberUpdatedState(onScanned)
    val hasCamera = remember(context) {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }
    if (!hasCamera) return

    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var ocrCandidate by remember { mutableStateOf<String?>(null) }
    var captureFilePath by rememberSaveable { mutableStateOf<String?>(null) }
    val active = remember { AtomicBoolean(true) }

    val barcodeScanner = remember(context, engine) {
        if (engine != NativeScanEngine.BARCODE) {
            null
        } else {
            val options = GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(
                    Barcode.FORMAT_CODE_128,
                    Barcode.FORMAT_CODE_39,
                    Barcode.FORMAT_CODE_93,
                    Barcode.FORMAT_CODABAR,
                    Barcode.FORMAT_EAN_13,
                    Barcode.FORMAT_EAN_8,
                    Barcode.FORMAT_ITF,
                    Barcode.FORMAT_UPC_A,
                    Barcode.FORMAT_UPC_E,
                    Barcode.FORMAT_QR_CODE,
                    Barcode.FORMAT_PDF417,
                    Barcode.FORMAT_DATA_MATRIX,
                )
                .enableAutoZoom()
                .build()
            GmsBarcodeScanning.getClient(context, options)
        }
    }
    val textRecognizer = remember(engine) {
        if (engine == NativeScanEngine.OCR) {
            TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        } else {
            null
        }
    }
    val optionalModuleApi: OptionalModuleApi? = barcodeScanner ?: textRecognizer
    var moduleReady by remember(optionalModuleApi) { mutableStateOf(false) }
    var modulePreparing by remember(optionalModuleApi) { mutableStateOf(false) }
    var moduleInstallAttempt by remember(optionalModuleApi) { mutableIntStateOf(0) }

    val cleanupCapture = {
        captureFilePath?.let(::File)?.delete()
        captureFilePath = null
    }
    val photoLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val file = captureFilePath?.let(::File)
        if (!captured || file == null) {
            busy = false
            cleanupCapture()
        } else {
            val recognizer = textRecognizer
            if (recognizer == null) {
                busy = false
                cleanupCapture()
                feedback = "تعذر تهيئة قارئ النص"
            } else {
                coroutineScope.launch {
                    var bitmap: Bitmap? = null
                    var handedToRecognizer = false
                    try {
                        val preparedBitmap = withContext(NonCancellable + Dispatchers.IO) {
                            decodeBoundedOcrBitmap(file)
                        }
                        bitmap = preparedBitmap
                        coroutineContext.ensureActive()
                        val task = recognizer.process(InputImage.fromBitmap(preparedBitmap, 0))
                        handedToRecognizer = true
                        task.addOnSuccessListener { result ->
                            if (active.get()) {
                                val normalized = normalizeNativeScanResult(field, result.text)
                                if (normalized == null) {
                                    feedback = "لم يُعثر على مرجع لاتيني صالح في الصورة"
                                } else {
                                    ocrCandidate = normalized
                                }
                            }
                        }.addOnFailureListener {
                            if (active.get()) {
                                moduleReady = false
                                feedback = "تعذر تحليل الصورة. أعد المحاولة بعد اكتمال تنزيل وحدة OCR"
                            }
                        }.addOnCompleteListener {
                            preparedBitmap.recycle()
                            file.delete()
                            if (active.get()) {
                                busy = false
                                captureFilePath = null
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        if (active.get()) feedback = "تعذر قراءة صورة المسح"
                    } finally {
                        if (!handedToRecognizer) {
                            bitmap?.recycle()
                            file.delete()
                            if (active.get()) {
                                busy = false
                                captureFilePath = null
                            }
                        }
                    }
                }
            }
        }
    }

    val launchOcrCapture = {
        busy = true
        runCatching {
            val directory = File(context.cacheDir, "scanner").apply {
                check(exists() || mkdirs()) { "Unable to create scanner cache directory" }
            }
            pruneStaleCaptures(directory)
            val file = File.createTempFile("ocr-", ".jpg", directory)
            captureFilePath = file.absolutePath
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )
            photoLauncher.launch(uri)
        }.onFailure {
            busy = false
            cleanupCapture()
            feedback = "تعذر تجهيز صورة المسح"
        }
    }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            launchOcrCapture()
        } else {
            feedback = "يلزم إذن الكاميرا لالتقاط النص"
        }
    }
    val latestCaptureFilePath by rememberUpdatedState(captureFilePath)

    val startReadyScan: () -> Unit = readyScan@{
        when (engine) {
            NativeScanEngine.BARCODE -> {
                val scanner = barcodeScanner ?: return@readyScan
                busy = true
                val task = runCatching { scanner.startScan() }.onFailure {
                    busy = false
                    moduleReady = false
                    feedback = "تعذر تشغيل ماسح الرموز"
                }.getOrNull() ?: return@readyScan
                task.addOnSuccessListener { barcode ->
                    if (active.get()) {
                        val normalized = barcode.rawValue?.let { normalizeNativeScanResult(field, it) }
                        if (normalized == null) feedback = "لم يُقرأ رمز صالح" else latestOnScanned(normalized)
                    }
                }.addOnFailureListener { error ->
                    val cancelled = error is ApiException && error.statusCode == CommonStatusCodes.CANCELED
                    if (active.get() && !cancelled) {
                        moduleReady = false
                        feedback = "تعذر تشغيل ماسح الرموز. أعد المحاولة بعد اكتمال تنزيل وحدة المسح"
                    }
                }.addOnCompleteListener {
                    if (active.get()) busy = false
                }
            }

            NativeScanEngine.OCR -> {
                if (
                    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    launchOcrCapture()
                } else {
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                }
            }
        }
    }

    LaunchedEffect(optionalModuleApi, moduleInstallAttempt) {
        if (moduleInstallAttempt == 0) return@LaunchedEffect
        val api = optionalModuleApi ?: return@LaunchedEffect
        modulePreparing = true
        try {
            ensureOptionalModuleInstalled(ModuleInstall.getClient(context), api)
            moduleReady = true
            startReadyScan()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            moduleReady = false
            feedback = "تعذر تجهيز وحدة المسح. تحقّق من اتصال الإنترنت وخدمات Google Play ثم أعد المحاولة"
        } finally {
            modulePreparing = false
        }
    }

    DisposableEffect(textRecognizer) {
        active.set(true)
        onDispose {
            active.set(false)
            textRecognizer?.close()
            latestCaptureFilePath?.let(::File)?.delete()
        }
    }

    IconButton(
        onClick = {
            if (!moduleReady) {
                modulePreparing = true
                moduleInstallAttempt += 1
                return@IconButton
            }
            startReadyScan()
        },
        enabled = enabled && !busy && !modulePreparing,
        modifier = modifier,
    ) {
        if (busy || modulePreparing) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        } else {
            Icon(
                if (engine == NativeScanEngine.BARCODE) Icons.Rounded.QrCodeScanner else Icons.Rounded.DocumentScanner,
                contentDescription = if (engine == NativeScanEngine.BARCODE) "مسح بالكاميرا" else "التقاط النص بالكاميرا",
            )
        }
    }

    ocrCandidate?.let { candidate ->
        AlertDialog(
            onDismissRequest = { ocrCandidate = null },
            title = { Text("النص الملتقط") },
            text = {
                Text(
                    candidate,
                    Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ocrCandidate = null
                    latestOnScanned(candidate)
                }) { Text("استخدام النص") }
            },
            dismissButton = {
                TextButton(onClick = { ocrCandidate = null }) { Text("إلغاء") }
            },
        )
    }

    feedback?.let { message ->
        AlertDialog(
            onDismissRequest = { feedback = null },
            title = { Text("تعذر المسح") },
            text = { Text(message) },
            confirmButton = {
                TextButton(onClick = { feedback = null }) { Text("حسناً") }
            },
        )
    }
}

internal fun calculateOcrSampleSize(width: Int, height: Int, maxEdge: Int = MAX_OCR_IMAGE_EDGE): Int {
    require(width > 0 && height > 0 && maxEdge > 0)
    var sampleSize = 1
    val largestEdge = max(width, height)
    while (largestEdge / sampleSize > maxEdge && sampleSize <= Int.MAX_VALUE / 2) {
        sampleSize *= 2
    }
    return sampleSize
}

private fun decodeBoundedOcrBitmap(file: File): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    check(bounds.outWidth > 0 && bounds.outHeight > 0) { "Unreadable OCR image" }

    val decoded = BitmapFactory.decodeFile(
        file.absolutePath,
        BitmapFactory.Options().apply {
            inSampleSize = calculateOcrSampleSize(bounds.outWidth, bounds.outHeight)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        },
    ) ?: error("Unable to decode OCR image")

    try {
        val orientation = ExifInterface(file.absolutePath).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
        )
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> {
                    setRotate(90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> {
                    setRotate(-90f)
                    postScale(-1f, 1f)
                }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        if (matrix.isIdentity) return decoded
        return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also {
            if (it !== decoded) decoded.recycle()
        }
    } catch (error: Throwable) {
        decoded.recycle()
        throw error
    }
}

private fun pruneStaleCaptures(directory: File, now: Long = System.currentTimeMillis()) {
    directory.listFiles()?.forEach { file ->
        if (file.isFile && file.name.startsWith("ocr-") && now - file.lastModified() > STALE_CAPTURE_MAX_AGE_MS) {
            file.delete()
        }
    }
}

internal suspend fun ensureOptionalModuleInstalled(
    client: ModuleInstallClient,
    api: OptionalModuleApi,
    timeoutMs: Long = MODULE_INSTALL_TIMEOUT_MS,
) = withTimeout(timeoutMs) {
    if (client.areModulesAvailable(api).await().areModulesAvailable()) return@withTimeout

    val completion = CompletableDeferred<Unit>()
    val listener = InstallStatusListener { update ->
        when (update.installState) {
            ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED -> completion.complete(Unit)
            ModuleInstallStatusUpdate.InstallState.STATE_CANCELED,
            ModuleInstallStatusUpdate.InstallState.STATE_FAILED,
            -> completion.completeExceptionally(
                IllegalStateException("Module install failed: ${update.errorCode}"),
            )
        }
    }
    val request = ModuleInstallRequest.newBuilder().addApi(api).setListener(listener).build()
    try {
        val response = client.installModules(request).await()
        if (response.areModulesAlreadyInstalled()) completion.complete(Unit)
        completion.await()
    } finally {
        runCatching { client.unregisterListener(listener).await() }
    }
}
