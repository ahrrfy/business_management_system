// حوار الاستيراد الموحّد (Products/Customers/Suppliers): ملف → اختيار أعمدة ذكي → معاينة/تحقّق → تنفيذ ذرّي → ملخّص.
// التحقّق على مستوى الواجهة بوّابة أولى؛ افتراضياً لا يُرسَل شيء ما لم تَخلُ كل الصفوف من الأخطاء،
// والخادم يعيد التحقّق ويكتب داخل معاملة واحدة (دفاع متعدّد الطبقات).
// الملفات الكبيرة تُقسَّم دفعات ≤١٠٠٠ صف (دون فصم منتج عبر دفعتين) — ضمانة «كل-أو-لا-شيء» لكل دفعة على حدة،
// وتكاملُها على مستوى الملف مسؤولية جولة dryRun التمهيدية + فحوص الملف الكامل (تكرار داخلي/تعارض sku) هنا في العميل.
import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { exportRows } from "@/lib/export";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import {
  autoMapColumns,
  buildRows,
  findBarcodeConflicts,
  findFileDuplicates,
  findSkuConflicts,
  mergeSummaries,
  normHeader,
  parseSheet,
  splitIntoBatches,
  type CellError,
  type ColumnMapping,
  type ImportField,
  type ImportHandler,
  type ImportMeta,
  type ImportParseResult,
  type ImportRow,
  type ImportRowResult,
  type ImportRunOptions,
  type ImportSummary,
  type ParsedRow,
} from "@/lib/import";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const PREVIEW_LIMIT = 100;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** حجم الدفعة في العميل — حدود الخادم أعلى عمداً (منتجات 5000، عملاء/موردون 2000) كهامش. */
const BATCH_SIZE = 1000;

export type ImportDialogProps<TRow> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entityName: string;
  fields: ImportField<TRow>[];
  onImport: ImportHandler<TRow>;
  onDone?: (summary: ImportSummary) => void;
  maxBytes?: number;
  /** وصف سلوكي (من importFields بجوار FIELDS): مفاتيح الرصيد/العملة/التجميع + دعم خيارات الخادم.
   *  غيابه مع وجود مفتاح productName في fields ⇒ fallback منتجات (تجميع وتقسيم عميل صرف، بلا خيارات خادمية). */
  meta?: ImportMeta;
};

type Step = "file" | "map" | "running" | "done";

export function ImportDialog<TRow>({
  open,
  onOpenChange,
  title,
  entityName,
  fields,
  onImport,
  onDone,
  maxBytes = DEFAULT_MAX_BYTES,
  meta,
}: ImportDialogProps<TRow>) {
  const [step, setStep] = React.useState<Step>("file");
  const [reading, setReading] = React.useState(false);
  const [fileName, setFileName] = React.useState("");
  const [parse, setParse] = React.useState<ImportParseResult | null>(null);
  const [mapping, setMapping] = React.useState<ColumnMapping<TRow>>({});
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  // خيارات التشغيل (تظهر في خطوة «map» حسب الـmeta والربط الفعلي)
  const [usdRate, setUsdRate] = React.useState("");
  // افتراضياً مفعَّل (قرار المالك ١١/٦): الصفوف الفاشلة تُتجاوَز ويكتمل الصحيح مع تنبيه + سجلّ أخطاء —
  // إطفاؤه يعيد سلوك «الكل أو لا شيء».
  const [skipFailed, setSkipFailed] = React.useState(true);
  const [balanceSign, setBalanceSign] = React.useState<"asIs" | "invert">("asIs");
  const [phase, setPhase] = React.useState<"dry" | "write" | null>(null);
  const [batchNote, setBatchNote] = React.useState<string | null>(null);
  // ما كُتب فعلاً في القاعدة: عدّادات الدفعات الملتزمة فقط — دفعة «الكل أو لا شيء» الفاشلة يعيد
  // الخادم صفوفها بحالة «مُنشأ» (تصنيف ما قبل rollback) فعدّادات الملخّص وحدها لا تكفي.
  const [writtenCount, setWrittenCount] = React.useState(0);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // fallback للمنتجات دون لمس Products.tsx: غياب الـprop + وجود مفتاح productName ⇒ تجميع وتقسيم
  // (سلوك عميلٍ صرف)، مع إخفاء خيارات الخادم لأنها لن تصل الخادم أصلاً.
  const effectiveMeta: ImportMeta | undefined = React.useMemo(() => {
    if (meta) return meta;
    if (fields.some((f) => f.key === "productName")) {
      return {
        batchGroupByKey: "productName",
        supportsServerOptions: false,
        skuConflictKeys: { sku: "sku", fallback: "barcode", owner: "productName", barcode: "barcode", unit: "unitName" },
      };
    }
    return undefined;
  }, [meta, fields]);
  const supportsOptions = effectiveMeta?.supportsServerOptions === true;

  function reset() {
    setStep("file");
    setFileName("");
    setParse(null);
    setMapping({});
    setSummary(null);
    setProgress(null);
    setBusy(false);
    setReading(false);
    setUsdRate("");
    setSkipFailed(false);
    setBalanceSign(effectiveMeta?.balanceSignDefault ?? "asIs");
    setPhase(null);
    setBatchNote(null);
    setWrittenCount(0);
  }

  function close() {
    if (busy) return; // لا تُغلق أثناء التنفيذ
    onOpenChange(false);
    // تأخير إعادة الضبط حتى ينتهي انتقال الإغلاق
    setTimeout(reset, 200);
  }

  function downloadTemplate() {
    const example = {} as TRow;
    exportRows([example], {
      filename: `قالب-${entityName}`,
      columns: fields.map((f) => ({
        key: f.key,
        header: f.required ? `${f.label}*` : f.label,
        map: () => f.example ?? "",
      })),
    });
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      notify.err(new Error("الصيغة غير مدعومة — استخدم ملف .xlsx أو .csv"));
      return;
    }
    if (file.size > maxBytes) {
      notify.err(new Error(`الملف كبير جداً (الحدّ ${Math.round(maxBytes / 1024 / 1024)}MB).`));
      return;
    }
    setReading(true);
    await new Promise((r) => setTimeout(r, 0)); // أتِح للواجهة رسم «جارٍ القراءة» قبل التحليل المتزامن (تحميل exceljs يحجب الخيط)
    try {
      const result = await parseSheet(file);
      if (result.totalRows === 0) {
        notify.err(new Error("لا صفوف بيانات في الملف."));
        return;
      }
      setFileName(file.name);
      setParse(result);
      setMapping(autoMapColumns(result.headers, fields));
      setBalanceSign(effectiveMeta?.balanceSignDefault ?? "asIs");
      setStep("map");
    } catch {
      notify.err(new Error("تعذّرت قراءة الملف — تأكّد أنه Excel/CSV سليم."));
    } finally {
      setReading(false);
    }
  }

  const built: ParsedRow<TRow>[] = React.useMemo(
    () => (parse ? buildRows(parse, mapping, fields) : []),
    [parse, mapping, fields],
  );

  // فحوص الملف الكامل في العميل (قبل التقسيم): تكرار داخلي + تعارض ملكية sku —
  // كشف الخادم يعمل داخل النداء الواحد فقط ويضيع عبر الدفعات.
  const fileIssues = React.useMemo(() => {
    const issues = new Map<number, CellError[]>();
    if (!effectiveMeta) return issues;
    const add = (found: Map<number, string>, field: string) => {
      found.forEach((message, rowNumber) => {
        const list = issues.get(rowNumber) ?? [];
        list.push({ field, message });
        issues.set(rowNumber, list);
      });
    };
    if (effectiveMeta.duplicateKeys) add(findFileDuplicates(built, effectiveMeta.duplicateKeys), "_duplicate");
    if (effectiveMeta.skuConflictKeys) {
      add(findSkuConflicts(built, effectiveMeta.skuConflictKeys), "_skuConflict");
      // تكرار الباركود عبر متغيّرات مختلفة: كشف الخادم له يعمل داخل النداء الواحد فقط ويضيع عبر
      // الدفعات (دفعات أولى تلتزم ثم تفشل لاحقة) — يُكشف هنا على الملف كاملاً قبل الإرسال.
      add(findBarcodeConflicts(built, effectiveMeta.skuConflictKeys), "_barcodeConflict");
    }
    return issues;
  }, [built, effectiveMeta]);

  const checked: ParsedRow<TRow>[] = React.useMemo(
    () =>
      built.map((r) => {
        const extra = fileIssues.get(r.rowNumber);
        return extra ? { ...r, errors: [...r.errors, ...extra] } : r;
      }),
    [built, fileIssues],
  );

  const invalidCount = checked.filter((r) => r.errors.length > 0).length;
  const validRows = checked.filter((r) => r.errors.length === 0);
  const warningCount = checked.filter((r) => r.errors.length === 0 && r.warnings.length > 0).length;

  const mappedFieldKeys = new Set(Object.values(mapping).filter(Boolean) as string[]);
  const unmappedRequired = fields.filter((f) => f.required && !mappedFieldKeys.has(f.key));

  const balanceKey = effectiveMeta?.balanceKey;
  const balanceMapped = balanceKey != null && mappedFieldKeys.has(balanceKey);
  const currencyField = effectiveMeta?.currencyKey
    ? fields.find((f) => f.key === effectiveMeta.currencyKey)
    : undefined;
  const currencyMapped = currencyField != null && mappedFieldKeys.has(currencyField.key);

  // هل يحوي الملف صفوف USD؟ (يُظهر حقل سعر الصرف ويجعله إلزامياً)
  const hasUsd = React.useMemo(() => {
    if (!currencyField || !currencyMapped) return false;
    return checked.some((r) => (r.values as Record<string, unknown>)[currencyField.key] === "USD");
  }, [checked, currencyField, currencyMapped]);
  const usdRateRequired = hasUsd && supportsOptions;
  // Number للمقارنة فقط — التخزين والتمرير نصّاً (قاعدة الأموال).
  const usdRateValid = /^\d+(\.\d{1,2})?$/.test(usdRate.trim()) && Number(usdRate) > 0;

  // حارس فكّ الربط: رُبط الرصيد ووُجد عمودٌ تُطبَّع ترويسته إلى «العملة» وهو غير مربوط
  // ⇒ منع التنفيذ — وإلا خُزّنت أرصدة USD كأنها IQD حرفياً بلا أي إنذار.
  const currencyGuard = React.useMemo(() => {
    if (!parse || !currencyField || !balanceMapped || currencyMapped) return false;
    const names = new Set([
      normHeader(currencyField.label),
      normHeader(currencyField.key),
      ...(currencyField.aliases ?? []).map(normHeader),
    ]);
    return parse.headers.some((h) => mapping[h] == null && names.has(normHeader(h)));
  }, [parse, currencyField, balanceMapped, currencyMapped, mapping]);

  // معاينة اتجاه الرصيد المحسوبة الحيّة: ٢-٣ صفوف حقيقية ذات رصيد غير صفري مفسَّرةً بأرقامها —
  // قلب الإشارة يقلب ذمم الملف كله دفعةً واحدة، فيجب أن يُرى أثره قبل التنفيذ لا بعده.
  const balancePreview = React.useMemo(() => {
    if (!balanceKey || !balanceMapped) return [];
    const header = Object.entries(mapping).find(([, fk]) => fk === balanceKey)?.[0];
    const hints = effectiveMeta?.balanceHints;
    const out: { rowNumber: number; rawText: string; text: string }[] = [];
    for (const r of checked) {
      const v = (r.values as Record<string, unknown>)[balanceKey];
      if (typeof v !== "string" || D(v).isZero()) continue;
      const stored = balanceSign === "invert" ? D(v).neg() : D(v);
      const hint = stored.isNegative() ? (hints?.negative ?? "بالسالب") : (hints?.positive ?? "بالموجب");
      const curr =
        currencyField && (r.values as Record<string, unknown>)[currencyField.key] === "USD" ? "$" : "د.ع";
      const rawText = header != null ? String(r.raw[header] ?? "") : v;
      out.push({
        rowNumber: r.rowNumber,
        rawText,
        text: `${hint} ${stored.abs().toNumber().toLocaleString("ar-IQ-u-nu-latn")} ${curr}`,
      });
      if (out.length >= 3) break;
    }
    return out;
  }, [checked, balanceKey, balanceMapped, balanceSign, mapping, effectiveMeta, currencyField]);

  // عدد الدفعات المخطّط (للنصّ التوضيحي) — التجميع بمفتاح الـmeta يمنع فصم منتج عبر دفعتين.
  const plannedBatchCount = React.useMemo(() => {
    const groupKey = effectiveMeta?.batchGroupByKey;
    const keyOf = groupKey
      ? (r: ParsedRow<TRow>) => String((r.values as Record<string, unknown>)[groupKey] ?? "")
      : undefined;
    return splitIntoBatches(validRows, BATCH_SIZE, keyOf).length;
  }, [validRows, effectiveMeta]);

  const canRun =
    validRows.length > 0 &&
    unmappedRequired.length === 0 &&
    !currencyGuard &&
    // أخطاء العميل لا تُرسَل للخادم أصلاً (validRows فقط) ⇒ التجاوز يعمل لكل الكيانات
    // حتى بلا خيارات خادمية (كان مشروطاً بـsupportsOptions فحُبس استيراد المنتجات على أي خطأ).
    (invalidCount === 0 || skipFailed) &&
    (!usdRateRequired || usdRateValid);

  async function runImport() {
    if (!canRun) return;
    setBusy(true);
    setStep("running");
    setBatchNote(null);
    const payload: ImportRow<TRow>[] = validRows.map((r) => ({ ...(r.values as TRow), rowNumber: r.rowNumber }));
    // صفوف أفشلها فحص العميل (قسر/تكرار داخلي/تعارض sku أو باركود): مع «تجاوز الفاشلة» لا تُرسَل
    // للخادم أصلاً — فتُدمَج في الملخّص النهائي كي لا تعرض خانة «فاشل» صفراً مضلِّلاً
    // (§٥.٤: الفاشلة تبقى فاشلة في الملخّص — لا إسقاط صامت من شاشة النتيجة).
    const clientFailed: ImportRowResult[] = checked
      .filter((r) => r.errors.length > 0)
      .map((r) => ({
        rowNumber: r.rowNumber,
        status: "failed" as const,
        message: r.errors.map((e) => e.message).join(" • "),
      }));
    const withClientFailures = (s: ImportSummary): ImportSummary =>
      clientFailed.length === 0
        ? s
        : {
            ...s,
            total: s.total + clientFailed.length,
            failed: s.failed + clientFailed.length,
            rows: [...s.rows, ...clientFailed].sort((a, b) => a.rowNumber - b.rowNumber),
          };
    const groupKey = effectiveMeta?.batchGroupByKey;
    const keyOf = groupKey
      ? (row: ImportRow<TRow>) => String((row as Record<string, unknown>)[groupKey] ?? "")
      : undefined;
    const batches = splitIntoBatches(payload, BATCH_SIZE, keyOf);
    const baseOptions: ImportRunOptions | undefined = supportsOptions
      ? {
          ...(skipFailed ? { skipFailed: true } : {}),
          ...(hasUsd && usdRate.trim() ? { usdRate: usdRate.trim() } : {}),
          ...(balanceMapped ? { balanceSign } : {}),
        }
      : undefined;
    const total = payload.length;
    setProgress({ done: 0, total });
    try {
      // جولة dryRun كاملة لكل الدفعات أولاً (عند تعدّدها بلا skipFailed): لا تبدأ الكتابة إلا إذا صفرت
      // الأخطاء — وإلا فشلُ الدفعة ٧ يُبقي ١-٦ ملتزمة (استيراد جزئي صامت).
      if (batches.length > 1 && supportsOptions && !skipFailed) {
        setPhase("dry");
        const dryParts: ImportSummary[] = [];
        let done = 0;
        for (const batch of batches) {
          const part = await onImport(batch, { options: { ...(baseOptions ?? {}), dryRun: true } });
          dryParts.push(part);
          done += batch.length;
          setProgress({ done, total });
        }
        const dry = mergeSummaries(dryParts);
        if (dry.failed > 0) {
          setWrittenCount(0);
          setSummary({ ...dry, committed: false });
          setBatchNote(
            `جولة الفحص التمهيدية (بلا كتابة) وجدت ${dry.failed.toLocaleString("ar-IQ-u-nu-latn")} صفّاً فاشلاً — لم يُكتب أي شيء. صحّح الأخطاء ثم أعد المحاولة.`,
          );
          setStep("done");
          notify.err(new Error("الفحص التمهيدي وجد أخطاء — لم يُكتب شيء."));
          onDone?.({ ...dry, committed: false });
          return;
        }
      }

      // التنفيذ الفعلي — دفعات متتابعة، كلٌّ منها ذرّية على حدة.
      setPhase("write");
      setProgress({ done: 0, total });
      const parts: ImportSummary[] = [];
      let done = 0;
      let stoppedAt: number | null = null;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const base = done;
        const part = await onImport(batch, {
          options: baseOptions,
          onProgress: (d) => setProgress({ done: base + d, total }),
        });
        parts.push(part);
        done += batch.length;
        setProgress({ done, total });
        // التوقّف عند «فشل» فعلي فقط (صفوف فاشلة بلا التزام = rollback): دفعة كل صفوفها «متجاوَز»
        // يعيدها الخادم committed=false (لا شيء يُكتب) وهي ليست فشلاً — التوقّف عندها كان يجعل
        // إعادة تشغيل ملفٍ توقّف في منتصفه مستحيلة (الدفعة ١ كلها متجاوَزة ⇒ توقّف فوري).
        if (part.failed > 0 && !part.committed && !skipFailed) {
          stoppedAt = i;
          break;
        }
      }
      const merged = withClientFailures(mergeSummaries(parts));
      if (stoppedAt != null && batches.length > 1) {
        const writtenRows = batches.slice(0, stoppedAt).reduce((a, b) => a + b.length, 0);
        const unsent = total - writtenRows - batches[stoppedAt].length;
        setBatchNote(
          `توقّف التنفيذ عند الدفعة ${(stoppedAt + 1).toLocaleString("ar-IQ-u-nu-latn")} من ${batches.length.toLocaleString("ar-IQ-u-nu-latn")}: ` +
            `كُتبت ${writtenRows.toLocaleString("ar-IQ-u-nu-latn")} صفّاً في الدفعات السابقة، وفشلت هذه الدفعة (لم يُكتب منها شيء)` +
            (unsent > 0 ? `، و${unsent.toLocaleString("ar-IQ-u-nu-latn")} صفّاً لم تُرسَل.` : ".") +
            " إعادة التشغيل آمنة — الموجود يُتخطّى ولا تتكرّر الأرصدة.",
        );
      }
      setSummary(merged);
      setStep("done");
      // الرسائل بدلالة ما كُتب وما فشل فعلاً (لا بدلالة committed وحده): إعادة استيراد ملف كامل
      // = صفر كتابة وصفر فشل — نجاح منطقي لا «فشل» أحمر زائف.
      const written = parts.reduce((a, p) => (p.committed ? a + p.created + p.updated : a), 0);
      setWrittenCount(written);
      if (stoppedAt != null) {
        notify.err(new Error("توقّف الاستيراد عند دفعة فاشلة — راجِع التفاصيل."));
      } else if (merged.failed === 0 && written > 0) {
        notify.ok(`تم استيراد ${written} سجلّاً`);
      } else if (merged.failed === 0) {
        notify.ok("لا جديد — كل الصفوف موجودة مسبقاً وتُخطّيت (لا تتكرّر البيانات ولا الأرصدة).");
      } else if (written > 0) {
        notify.ok(`تم استيراد ${written} سجلّاً وتجاوُز ${merged.failed} فاشلاً`);
      } else {
        notify.err(new Error("لم يُستورَد شيء — راجِع تفاصيل الأخطاء."));
      }
      onDone?.(merged);
    } catch (e) {
      notify.err(e);
      setStep("map");
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  function exportErrorLog() {
    const rows = checked
      .filter((r) => r.errors.length > 0)
      .map((r) => ({ row: r.rowNumber, errors: r.errors.map((e) => e.message).join(" • ") }));
    exportRows(rows, {
      filename: `أخطاء-استيراد-${entityName}`,
      columns: [
        { key: "row", header: "الصف" },
        { key: "errors", header: "الأخطاء" },
      ],
    });
  }

  // أعمدة المعاينة = الحقول المربوطة بالترتيب.
  const previewFields = fields.filter((f) => mappedFieldKeys.has(f.key));

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        dir="rtl"
        showCloseButton={!busy}
        className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[88vh] w-[min(95vw,900px)] max-w-[min(95vw,900px)] overflow-hidden sm:max-w-[min(95vw,900px)]"
      >
        <DialogHeader className="sm:text-right">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            ارفع ملف Excel/CSV. افتراضياً لا يُكتب شيء حتى تَخلو كل الصفوف من الأخطاء؛ الملفات الكبيرة
            تُرسَل دفعاتٍ كلٌّ منها ذرّية على حدة.
          </DialogDescription>
        </DialogHeader>

        {/* الخطوة ١: اختيار الملف */}
        {step === "file" && (
          <div className="space-y-3">
            <button
              type="button"
              disabled={reading}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!reading) void onFile(e.dataTransfer.files?.[0]);
              }}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 disabled:opacity-70"
            >
              {reading ? (
                <>
                  <Loader2 className="size-7 animate-spin" aria-hidden="true" />
                  <span className="text-sm font-medium text-foreground">جارٍ قراءة الملف…</span>
                </>
              ) : (
                <>
                  <Upload className="size-7" />
                  <span className="text-sm font-medium text-foreground">اختر ملفاً أو أفلِته هنا</span>
                  <span className="text-xs">صيغ مدعومة: .xlsx · .csv</span>
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                لا تملك قالباً؟ نزّل قالباً فارغاً بالأعمدة الصحيحة.
              </span>
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="size-4" />
                تنزيل القالب
              </Button>
            </div>
          </div>
        )}

        {/* الخطوة ٢: المطابقة والمعاينة */}
        {step === "map" && parse && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1 text-muted-foreground">
                <FileSpreadsheet className="size-4" />
                {fileName} — {parse.totalRows.toLocaleString("ar-IQ-u-nu-latn")} صفّ
              </span>
              <Button variant="ghost" size="sm" onClick={() => setStep("file")}>
                تغيير الملف
              </Button>
            </div>

            {/* مطابقة الأعمدة */}
            <div className="rounded-md border p-2">
              <div className="mb-2 text-xs font-medium">مطابقة الأعمدة</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {parse.headers.map((h) => (
                  <label key={h} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-mono" title={h} dir="auto">
                      {h || "(فارغ)"}
                    </span>
                    <select
                      className={selectCls}
                      value={(mapping[h] as string) ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({
                          ...m,
                          [h]: (e.target.value || null) as (keyof TRow & string) | null,
                        }))
                      }
                    >
                      <option value="">— تجاهل —</option>
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            {unmappedRequired.length > 0 && (
              <div className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertCircle className="size-4 shrink-0" />
                حقول مطلوبة غير مربوطة: {unmappedRequired.map((f) => f.label).join("، ")}
              </div>
            )}

            {currencyGuard && (
              <div className="flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                <AlertCircle className="size-4 shrink-0" />
                ربطتَ الرصيد الافتتاحي بينما عمود «{currencyField?.label}» موجود في الملف وغير مربوط —
                اربطه أو افصل الرصيد، وإلا خُزّنت أرصدة USD كأنها دينار حرفياً.
              </div>
            )}

            {/* خيارات الاستيراد — تظهر دائماً: مفتاح «تجاوز الفاشلة» يعمل لكل الكيانات (تصفية في العميل) */}
            {(
              <div className="space-y-2 rounded-md border p-2 text-xs">
                <div className="font-medium">خيارات الاستيراد</div>

                {usdRateRequired && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">سعر صرف الدولار*:</span>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      className="h-8 w-32 text-xs"
                      placeholder="1450"
                      value={usdRate}
                      onChange={(e) => setUsdRate(e.target.value)}
                      aria-invalid={!usdRateValid}
                    />
                    <span className="text-muted-foreground">أرصدة USD ستُحوَّل إلى دينار بهذا السعر.</span>
                    {!usdRateValid && usdRate.trim() !== "" && (
                      <span className="text-rose-700">سعر صرف غير صالح (رقم موجب، منزلتان كحدّ أقصى).</span>
                    )}
                  </div>
                )}

                {supportsOptions && balanceMapped && (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">اتجاه الرصيد:</span>
                      <Button
                        type="button"
                        size="sm"
                        variant={balanceSign === "asIs" ? "default" : "outline"}
                        onClick={() => setBalanceSign("asIs")}
                      >
                        كما في الملف
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={balanceSign === "invert" ? "default" : "outline"}
                        onClick={() => setBalanceSign("invert")}
                      >
                        اعكس الإشارة
                      </Button>
                      {effectiveMeta?.balanceHints && (
                        <span className="text-muted-foreground">موجب = {effectiveMeta.balanceHints.positive}</span>
                      )}
                    </div>
                    {balancePreview.length > 0 && (
                      <ul className="space-y-0.5 rounded bg-muted/50 p-2">
                        {balancePreview.map((p) => (
                          <li key={p.rowNumber} dir="auto" className="tabular-nums">
                            صف {p.rowNumber.toLocaleString("ar-IQ-u-nu-latn")}: «{p.rawText}» ⇐ {p.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Switch checked={skipFailed} onCheckedChange={setSkipFailed} id="import-skip-failed" />
                  <label htmlFor="import-skip-failed" className="cursor-pointer font-medium">
                    تجاوز الصفوف الفاشلة
                  </label>
                  <span className="text-muted-foreground">
                    {skipFailed
                      ? "يُستورَد الصحيح وتُتجاوَز الفاشلة (كرصيد سالب) مع تنبيه وسجلّ أخطاء قابل للتصدير."
                      : "مطفأ: أي صف خاطئ يمنع الاستيراد كله (الكل أو لا شيء)."}
                  </span>
                </div>

                {plannedBatchCount > 1 && (
                  <div className="text-muted-foreground">
                    سيُرسَل الملف على {plannedBatchCount.toLocaleString("ar-IQ-u-nu-latn")} دفعات (≤
                    {BATCH_SIZE.toLocaleString("ar-IQ-u-nu-latn")} صفّ) — ضمانة «كل-أو-لا-شيء» لكل دفعة على حدة،
                    وإعادة التشغيل آمنة: الموجود يُتخطّى ولا تتكرّر الأرصدة.
                  </div>
                )}
              </div>
            )}

            {/* المعاينة */}
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-right">
                    <th className="p-2 w-10">#</th>
                    {previewFields.map((f) => (
                      <th key={f.key} className="p-2 whitespace-nowrap">
                        {f.label}
                      </th>
                    ))}
                    <th className="p-2">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {checked.slice(0, PREVIEW_LIMIT).map((r) => (
                    <tr
                      key={r.rowNumber}
                      className={`border-t ${r.errors.length ? "bg-rose-50/60" : r.warnings.length ? "bg-amber-50/60" : ""}`}
                    >
                      <td className="p-2 text-muted-foreground">{r.rowNumber}</td>
                      {previewFields.map((f) => (
                        <td key={f.key} className="p-2 whitespace-nowrap" dir="auto">
                          {formatCell((r.values as Record<string, unknown>)[f.key])}
                        </td>
                      ))}
                      <td className="p-2">
                        {r.errors.length ? (
                          <span className="text-rose-700" title={r.errors.map((e) => e.message).join("\n")}>
                            {r.errors[0].message}
                            {r.errors.length > 1 ? ` (+${r.errors.length - 1})` : ""}
                          </span>
                        ) : r.warnings.length ? (
                          <span className="text-amber-700" title={r.warnings.map((w) => w.message).join("\n")}>
                            {r.warnings[0].message}
                          </span>
                        ) : (
                          <CheckCircle2 className="size-4 text-emerald-600" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {checked.length > PREVIEW_LIMIT && (
                <div className="p-2 text-center text-xs text-muted-foreground">
                  عرض أوّل {PREVIEW_LIMIT} من {checked.length.toLocaleString("ar-IQ-u-nu-latn")} صفّ (يُتحقَّق من الكل)
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-emerald-700">صحيح: {validRows.length.toLocaleString("ar-IQ-u-nu-latn")}</span>
              {warningCount > 0 && (
                <span className="text-amber-700">بتحذيرات: {warningCount.toLocaleString("ar-IQ-u-nu-latn")}</span>
              )}
              {invalidCount > 0 && (
                <span className="text-rose-700">به أخطاء: {invalidCount.toLocaleString("ar-IQ-u-nu-latn")}</span>
              )}
              {invalidCount > 0 && (
                <Button variant="ghost" size="sm" onClick={exportErrorLog}>
                  <Download className="size-4" />
                  تصدير سجلّ الأخطاء
                </Button>
              )}
            </div>
          </div>
        )}

        {/* الخطوة ٣: التنفيذ */}
        {step === "running" && (
          <div className="flex flex-col items-center gap-3 py-8" role="status" aria-live="polite" aria-busy="true">
            <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
            <div className="text-sm">
              {phase === "dry" ? "جولة فحص تمهيدية (بلا كتابة)…" : "جارٍ الاستيراد… لا تُغلق النافذة"}
            </div>
            {progress && progress.done > 0 && (
              <div className="w-64 space-y-1">
                <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} aria-label="تقدّم الاستيراد" />
                <div className="text-center text-xs text-muted-foreground">
                  {progress.done.toLocaleString("ar-IQ-u-nu-latn")} / {progress.total.toLocaleString("ar-IQ-u-nu-latn")}
                </div>
              </div>
            )}
          </div>
        )}

        {/* الخطوة ٤: الملخّص */}
        {step === "done" && summary && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryPill label="مُنشأ" value={summary.created} cls="text-emerald-700 bg-emerald-50" />
              <SummaryPill label="محدَّث" value={summary.updated} cls="text-[var(--sem-info)] bg-[var(--sem-info-bg)]" />
              <SummaryPill label="متجاوَز" value={summary.skipped} cls="text-amber-700 bg-amber-50" />
              <SummaryPill label="فاشل" value={summary.failed} cls="text-rose-700 bg-rose-50" />
            </div>
            {batchNote && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="size-4 shrink-0" />
                {batchNote}
              </div>
            )}
            {/* صندوق الفشل الأحمر عند فشلٍ فعلي بلا أي كتابة ملتزمة — لا لمجرد committed=false:
                دفعة كلها «متجاوَز» (إعادة استيراد) ليست فشلاً ولا تستحق إنذاراً أحمر كاذباً. */}
            {summary.failed > 0 && writtenCount === 0 && !batchNote && (
              <div className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
                <AlertCircle className="size-4 shrink-0" />
                لم تُكتب أي بيانات (الكل أو لا شيء) — صحّح الصفوف الفاشلة ثم أعد المحاولة.
              </div>
            )}
            {summary.failed === 0 && writtenCount === 0 && !batchNote && (
              <div className="flex items-center gap-2 rounded-md bg-[var(--sem-info-bg)] px-3 py-2 text-xs text-[var(--sem-info)]">
                <CheckCircle2 className="size-4 shrink-0" />
                لا جديد: كل الصفوف موجودة مسبقاً وتُخطّيت — إعادة الاستيراد لا تكرّر البيانات ولا الأرصدة.
              </div>
            )}
            {summary.rows.some((r) => r.status === "failed" || r.status === "skipped") && (
              <div className="max-h-56 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80">
                    <tr className="text-right">
                      <th className="p-2 w-12">الصف</th>
                      <th className="p-2">الحالة</th>
                      <th className="p-2">السبب</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows
                      .filter((r) => r.status === "failed" || r.status === "skipped")
                      .map((r) => (
                        <tr key={r.rowNumber} className="border-t">
                          <td className="p-2 text-muted-foreground">{r.rowNumber}</td>
                          <td className="p-2">{r.status === "failed" ? "فاشل" : "متجاوَز"}</td>
                          <td className="p-2" dir="auto">{r.message ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "map" && (
            <Button onClick={() => void runImport()} disabled={!canRun}>
              {invalidCount > 0 && !skipFailed
                ? `صحّح ${invalidCount.toLocaleString("ar-IQ-u-nu-latn")} صفّاً أولاً`
                : invalidCount > 0
                  ? `استيراد ${validRows.length.toLocaleString("ar-IQ-u-nu-latn")} وتجاوز ${invalidCount.toLocaleString("ar-IQ-u-nu-latn")} فاشلاً`
                  : `استيراد ${validRows.length.toLocaleString("ar-IQ-u-nu-latn")} صفّاً`}
            </Button>
          )}
          {step === "done" && (
            <Button onClick={close} variant="outline">
              إغلاق
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryPill({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-md px-3 py-2 text-center ${cls}`}>
      <div className="text-lg font-bold tabular-nums">{value.toLocaleString("ar-IQ-u-nu-latn")}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  return String(v);
}
