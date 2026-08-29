package online.alarabiya.superapp.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * ArabicDatePicker (Wave 3، ٢٩/٨) — حقل تاريخٍ موحَّد لكلّ الشاشات.
 *
 * سياق القرار:
 *  - Codex P2 (٢٨/٨، #857) رصد أنّ لوحة KeyboardType.Number لا توفّر مفتاح «-» بينما
 *    canSubmit في كثيرٍ من الشاشات يشترط YYYY-MM-DD ⇒ المستخدم يعجز عن إعادة بناء
 *    التاريخ بعد المسح، فيبقى زرّ الحفظ معطَّلاً. الحلّ الجذريّ: منتقي تقويم بدل حقل نصّ.
 *  - قرار المالك (ذاكرة `feedback-latin-digits-always.md`، ٢٥/٨): كلّ رقمٍ يعرضه النظامُ
 *    لاتينيّ. نُنسّق التاريخ بـ ISO (`YYYY-MM-DD`) بأرقامٍ لاتينية دائماً.
 *  - Baghdad TZ (Asia/Baghdad = UTC+3، بلا DST): نحوّل epochMillis إلى تقويمٍ محلّيّ
 *    (Zone Baghdad) قبل عرض `LocalDate`، وإلا فاختيار «١ كانون الثاني» بتوقيت الجهاز
 *    قد يُخزَّن ٣١ كانون الأوّل على الخادم.
 *
 * مسموحٌ التمرير على الشاشات الحاليّة على مراحل: كل استدعاء يُبدل OutlinedTextField
 * بحقلٍ للقراءة + زرّ يفتح Dialog. القيمة تُخزَّن نصّاً YYYY-MM-DD كما تتوقّعها الخدمات.
 *
 * @param value    قيمة `YYYY-MM-DD` أو فارغة.
 * @param onValue  callback يستقبل `YYYY-MM-DD` بعد اختيار المستخدم (أو "" للمسح).
 * @param label    نصّ الحقل (عربيّ افتراضاً — أدخله بلا "YYYY-MM-DD").
 * @param allowClear إن `true` يظهر زرّ «مسح» داخل Dialog.
 * @param enabled  عطّل الحقل + الزرّ بلا إخفائهما.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArabicDatePicker(
  value: String,
  onValue: (String) -> Unit,
  label: String,
  modifier: Modifier = Modifier.fillMaxWidth(),
  allowClear: Boolean = true,
  enabled: Boolean = true,
) {
  var dialogOpen by remember { mutableStateOf(false) }
  val parsedInitial = remember(value) { parseIsoDate(value) }
  val zone = remember { ZoneId.of("Asia/Baghdad") }

  OutlinedTextField(
    value = value,
    onValueChange = {},
    modifier = modifier,
    label = { Text(label) },
    singleLine = true,
    readOnly = true,
    enabled = enabled,
    trailingIcon = {
      OutlinedButton(
        onClick = { if (enabled) dialogOpen = true },
        enabled = enabled,
      ) { Text("اختيار") }
    },
  )

  if (dialogOpen) {
    val state = androidx.compose.material3.rememberDatePickerState(
      initialSelectedDateMillis = parsedInitial?.atStartOfDay(zone)?.toInstant()?.toEpochMilli(),
    )
    DatePickerDialog(
      onDismissRequest = { dialogOpen = false },
      confirmButton = {
        Button(onClick = {
          val millis = state.selectedDateMillis
          if (millis != null) {
            val picked = Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
            onValue(picked.format(ISO_FORMATTER))
          }
          dialogOpen = false
        }) { Text("موافق") }
      },
      dismissButton = {
        if (allowClear && value.isNotBlank()) {
          OutlinedButton(onClick = {
            onValue("")
            dialogOpen = false
          }) { Text("مسح") }
        } else {
          OutlinedButton(onClick = { dialogOpen = false }) { Text("رجوع") }
        }
      },
    ) {
      DatePicker(state = state)
    }
  }
}

/** Locale-neutral ISO formatter — أرقام لاتينية دائماً (قرار المالك ٢٥/٨). */
private val ISO_FORMATTER: DateTimeFormatter =
  DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US)

/**
 * Parse `YYYY-MM-DD`. أي شكلٍ آخر (نص، أرقام هندية، ISO 8601 بوقت) ⇒ `null`
 * فيفتح Dialog بلا تاريخٍ مُنتقى مسبقاً بدل السقوط.
 */
private fun parseIsoDate(raw: String): LocalDate? {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) return null
  return try {
    LocalDate.parse(trimmed, ISO_FORMATTER)
  } catch (_: Exception) {
    null
  }
}

/**
 * Placeholder — for legacy fields whose values you can't parse but you want the
 * picker to open blank. Not exported yet; keep in case a screen needs it later.
 */
@Suppress("unused")
private fun todayInBaghdadIso(): String =
  LocalDate.now(ZoneId.of("Asia/Baghdad")).format(ISO_FORMATTER)
