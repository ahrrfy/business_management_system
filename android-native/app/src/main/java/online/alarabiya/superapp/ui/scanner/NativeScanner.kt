package online.alarabiya.superapp.ui.scanner

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DocumentScanner
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.Closeable
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import online.alarabiya.superapp.core.scanner.NativeScanEngine
import online.alarabiya.superapp.core.scanner.NativeScanField
import online.alarabiya.superapp.core.scanner.normalizeNativeScanResult
import online.alarabiya.superapp.core.scanner.scanEngineOrNull

@Composable
fun NativeScannerAction(
    field: NativeScanField,
    onScanned: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val engine = field.scanEngineOrNull() ?: return
    val context = LocalContext.current
    val hasCamera = remember(context) {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }
    if (!hasCamera) return

    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }, enabled = enabled, modifier = modifier) {
        Icon(
            if (engine == NativeScanEngine.BARCODE) Icons.Rounded.QrCodeScanner else Icons.Rounded.DocumentScanner,
            contentDescription = if (engine == NativeScanEngine.BARCODE) "مسح بالكاميرا" else "التقاط النص بالكاميرا",
        )
    }
    if (open) {
        NativeScannerDialog(
            field = field,
            onDismiss = { open = false },
            onResult = { value ->
                open = false
                onScanned(value)
            },
        )
    }
}

@Composable
private fun NativeScannerDialog(
    field: NativeScanField,
    onDismiss: () -> Unit,
    onResult: (String) -> Unit,
) {
    val context = LocalContext.current
    val engine = requireNotNull(field.scanEngineOrNull())
    var permissionGranted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var requested by remember { mutableStateOf(false) }
    var candidate by remember { mutableStateOf("") }
    var cameraError by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionGranted = granted
    }

    LaunchedEffect(Unit) {
        if (!permissionGranted && !requested) {
            requested = true
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = Color(0xFF090C11)) {
            Column(
                Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        if (engine == NativeScanEngine.BARCODE) Icons.Rounded.QrCodeScanner else Icons.Rounded.DocumentScanner,
                        contentDescription = null,
                        tint = Color.White,
                    )
                    Spacer(Modifier.size(10.dp))
                    Text(
                        if (engine == NativeScanEngine.BARCODE) "مسح الرمز" else "التقاط النص",
                        modifier = Modifier.weight(1f),
                        color = Color.White,
                        style = MaterialTheme.typography.titleLarge,
                    )
                    IconButton(onClick = onDismiss) { Icon(Icons.Rounded.Close, "إغلاق", tint = Color.White) }
                }

                when {
                    !permissionGranted -> CameraPermissionPane(
                        onRequest = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                        onDismiss = onDismiss,
                    )
                    cameraError -> CameraUnavailablePane(onDismiss)
                    else -> {
                        CameraAnalysisPreview(
                            field = field,
                            onCandidate = { candidate = it },
                            onDetected = onResult,
                            onError = { cameraError = true },
                            modifier = Modifier.weight(1f),
                        )
                        if (engine == NativeScanEngine.OCR) {
                            OcrCandidatePane(
                                candidate = candidate,
                                onUse = { normalizeNativeScanResult(field, candidate)?.let(onResult) },
                            )
                        } else {
                            Text(
                                "وجّه الكاميرا نحو الرمز",
                                Modifier.fillMaxWidth(),
                                color = Color.White.copy(alpha = .78f),
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CameraPermissionPane(onRequest: () -> Unit, onDismiss: () -> Unit) {
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.CameraAlt, null, Modifier.size(56.dp), tint = Color.White)
        Spacer(Modifier.height(14.dp))
        Text("يلزم إذن الكاميرا للمسح", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onRequest) { Text("السماح بالكاميرا") }
        OutlinedButton(onClick = onDismiss, border = BorderStroke(1.dp, Color.White.copy(alpha = .5f))) {
            Text("إلغاء", color = Color.White)
        }
    }
}

@Composable
private fun CameraUnavailablePane(onDismiss: () -> Unit) {
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Rounded.CameraAlt, null, Modifier.size(56.dp), tint = Color.White)
        Spacer(Modifier.height(14.dp))
        Text("تعذر تشغيل الكاميرا", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onDismiss) { Text("إغلاق") }
    }
}

@Composable
private fun CameraAnalysisPreview(
    field: NativeScanField,
    onCandidate: (String) -> Unit,
    onDetected: (String) -> Unit,
    onError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember(context) {
        PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    }
    val cameraProviderFuture = remember(context) { ProcessCameraProvider.getInstance(context) }
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }

    DisposableEffect(field, lifecycleOwner) {
        val analysisExecutor = Executors.newSingleThreadExecutor()
        val analyzer = NativeMlKitAnalyzer(field, mainExecutor, onCandidate, onDetected)
        var provider: ProcessCameraProvider? = null
        var disposed = false
        cameraProviderFuture.addListener({
            if (disposed) return@addListener
            runCatching {
                provider = cameraProviderFuture.get()
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { it.setAnalyzer(analysisExecutor, analyzer) }
                val selector = when {
                    provider?.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) == true -> CameraSelector.DEFAULT_BACK_CAMERA
                    provider?.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) == true -> CameraSelector.DEFAULT_FRONT_CAMERA
                    else -> error("No camera available")
                }
                provider?.unbindAll()
                provider?.bindToLifecycle(lifecycleOwner, selector, preview, analysis)
            }.onFailure { onError() }
        }, mainExecutor)
        onDispose {
            disposed = true
            provider?.unbindAll()
            analyzer.close()
            analysisExecutor.shutdown()
        }
    }

    Box(modifier.fillMaxWidth().border(2.dp, Color.White.copy(alpha = .7f), RoundedCornerShape(28.dp))) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
        Box(
            Modifier.align(Alignment.Center).fillMaxWidth(.82f).height(190.dp)
                .border(3.dp, Color(0xFF54DFC1), RoundedCornerShape(24.dp))
                .background(Color.Transparent),
        )
    }
}

@Composable
private fun OcrCandidatePane(candidate: String, onUse: () -> Unit) {
    Surface(color = Color.White.copy(alpha = .09f), shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                candidate.ifBlank { "وجّه الكاميرا نحو المرجع أو النص" },
                Modifier.fillMaxWidth().height(76.dp).verticalScroll(rememberScrollState()),
                color = Color.White,
                style = MaterialTheme.typography.bodyLarge,
            )
            Button(onClick = onUse, enabled = candidate.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                Text("استخدام النص")
            }
        }
    }
}

private class NativeMlKitAnalyzer(
    private val field: NativeScanField,
    private val mainExecutor: Executor,
    private val onCandidate: (String) -> Unit,
    private val onDetected: (String) -> Unit,
) : ImageAnalysis.Analyzer, Closeable {
    private val processing = AtomicBoolean(false)
    private val accepted = AtomicBoolean(false)
    private val barcodeScanner: BarcodeScanner? = if (field.scanEngineOrNull() == NativeScanEngine.BARCODE) {
        val options = BarcodeScannerOptions.Builder()
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
            .build()
        BarcodeScanning.getClient(options)
    } else null
    private val textRecognizer: TextRecognizer? = if (field.scanEngineOrNull() == NativeScanEngine.OCR) {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    } else null

    @ExperimentalGetImage
    override fun analyze(imageProxy: ImageProxy) {
        if (!processing.compareAndSet(false, true)) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            processing.set(false)
            imageProxy.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        val barcode = barcodeScanner
        if (barcode != null) {
            barcode.process(input)
                .addOnSuccessListener { results ->
                    if (!accepted.get()) {
                        results.asSequence().mapNotNull { it.rawValue }
                            .mapNotNull { normalizeNativeScanResult(field, it) }
                            .firstOrNull()
                            ?.let { value ->
                                if (accepted.compareAndSet(false, true)) mainExecutor.execute { onDetected(value) }
                            }
                    }
                }
                .addOnCompleteListener { finishFrame(imageProxy) }
            return
        }
        val recognizer = textRecognizer
        if (recognizer != null) {
            recognizer.process(input)
                .addOnSuccessListener { result ->
                    if (!accepted.get()) {
                        normalizeNativeScanResult(field, result.text)?.let { value ->
                            mainExecutor.execute {
                                if (!accepted.get()) onCandidate(value)
                            }
                        }
                    }
                }
                .addOnCompleteListener { finishFrame(imageProxy) }
            return
        }
        finishFrame(imageProxy)
    }

    private fun finishFrame(imageProxy: ImageProxy) {
        processing.set(false)
        imageProxy.close()
    }

    override fun close() {
        accepted.set(true)
        barcodeScanner?.close()
        textRecognizer?.close()
    }
}
