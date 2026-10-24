import { useRef, useState } from "react";
import { notify } from "@/lib/notify";
import {
  mergeSummaries,
  splitIntoBatches,
  type ImportHandler,
  type ImportRow,
  type ImportRowResult,
  type ImportRunOptions,
  type ImportSummary,
} from "@/lib/import";
import { BATCH_SIZE } from "./types";
import type { ImportPreview } from "./useImportPreview";
// Server classification can include would-be creations after an atomic rollback.
// Expose only acknowledged writes as created/updated in both UI and completion callbacks.
function acknowledgedSummary(part: ImportSummary): ImportSummary {
  if (part.committed) return part;
  return {
    ...part,
    created: 0,
    updated: 0,
    failed:
      part.failed +
      part.rows.filter(
        (row) => row.status === "created" || row.status === "updated",
      ).length,
    rows: part.rows.map((row) =>
      row.status === "created" || row.status === "updated"
        ? {
            ...row,
            status: "failed",
            message: "لم يُحفظ الصف لأن الدفعة لم تلتزم.",
          }
        : row,
    ),
  };
}
export function useImportExecution<TRow>({
  preview,
  onImport,
  onDone,
  usdRate,
  balanceSign,
  skipFailed,
}: {
  preview: ImportPreview<TRow>;
  onImport: ImportHandler<TRow>;
  onDone?: (summary: ImportSummary) => void;
  usdRate: string;
  balanceSign: "asIs" | "invert";
  skipFailed: boolean;
}) {
  const {
    canRun,
    validRows,
    checked,
    effectiveMeta,
    supportsOptions,
    hasUsd,
    balanceMapped,
  } = preview;
  const lock = useRef(false);
  const [step, setStep] = useState<"idle" | "running" | "done">("idle");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [phase, setPhase] = useState<"dry" | "write" | null>(null);
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const [writtenCount, setWrittenCount] = useState(0);
  async function runImport() {
    if (!canRun || lock.current) return;
    lock.current = true;
    setBusy(true);
    setStep("running");
    setBatchNote(null);
    const payload: ImportRow<TRow>[] = validRows.map((r) => ({
      ...(r.values as TRow),
      rowNumber: r.rowNumber,
    }));
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
            rows: [...s.rows, ...clientFailed].sort(
              (a, b) => a.rowNumber - b.rowNumber,
            ),
          };
    const groupKey = effectiveMeta?.batchGroupByKey;
    const keyOf = groupKey
      ? (row: ImportRow<TRow>) =>
          String((row as Record<string, unknown>)[groupKey] ?? "")
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
    const parts: ImportSummary[] = [];
    let finalSummary: ImportSummary | undefined;
    let writing = false;
    let currentBatch = 0;
    try {
      // جولة dryRun كاملة لكل الدفعات أولاً (عند تعدّدها بلا skipFailed): لا تبدأ الكتابة إلا إذا صفرت
      // الأخطاء — وإلا فشلُ الدفعة ٧ يُبقي ١-٦ ملتزمة (استيراد جزئي صامت).
      if (batches.length > 1 && supportsOptions && !skipFailed) {
        setPhase("dry");
        const dryParts: ImportSummary[] = [];
        let done = 0;
        for (const batch of batches) {
          const part = await onImport(batch, {
            options: { ...(baseOptions ?? {}), dryRun: true },
          });
          dryParts.push(part);
          done += batch.length;
          setProgress({ done, total });
        }
        const dry = mergeSummaries(dryParts);
        if (dry.failed > 0) {
          const notWritten = dry.rows.filter(
            (row) => row.status === "created" || row.status === "updated",
          ).length;
          const stoppedDry: ImportSummary = {
            ...dry,
            committed: false,
            created: 0,
            updated: 0,
            skipped: dry.skipped + notWritten,
            rows: dry.rows.map((row) =>
              row.status === "created" || row.status === "updated"
                ? {
                    ...row,
                    status: "skipped",
                    message:
                      "لم يُنفّذ الصف؛ الفحص التمهيدي أوقف الاستيراد قبل الكتابة.",
                  }
                : row,
            ),
          };
          setWrittenCount(0);
          setSummary(stoppedDry);
          setBatchNote(
            `جولة الفحص التمهيدية (بلا كتابة) وجدت ${dry.failed.toLocaleString("ar-IQ-u-nu-latn")} صفّاً فاشلاً — لم يُكتب أي شيء. صحّح الأخطاء ثم أعد المحاولة.`,
          );
          setStep("done");
          notify.err(new Error("الفحص التمهيدي وجد أخطاء — لم يُكتب شيء."));
          finalSummary = stoppedDry;
          return;
        }
      }

      // التنفيذ الفعلي — دفعات متتابعة، كلٌّ منها ذرّية على حدة.
      setPhase("write");
      setProgress({ done: 0, total });
      writing = true;
      let done = 0;
      let stoppedAt: number | null = null;
      for (let i = 0; i < batches.length; i++) {
        currentBatch = i;
        const batch = batches[i];
        const base = done;
        const part = await onImport(batch, {
          options: baseOptions,
          onProgress: (d) => setProgress({ done: base + d, total }),
        });
        parts.push(acknowledgedSummary(part));
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
        const writtenRows = parts.reduce(
          (sum, part) =>
            part.committed ? sum + part.created + part.updated : sum,
          0,
        );
        const unsent = total - done;
        setBatchNote(
          `توقّف التنفيذ عند الدفعة ${(stoppedAt + 1).toLocaleString("ar-IQ-u-nu-latn")} من ${batches.length.toLocaleString("ar-IQ-u-nu-latn")}: ` +
            `كُتبت ${writtenRows.toLocaleString("ar-IQ-u-nu-latn")} صفّاً في الدفعات السابقة، وفشلت هذه الدفعة (لم يُكتب منها شيء)` +
            (unsent > 0
              ? `، و${unsent.toLocaleString("ar-IQ-u-nu-latn")} صفّاً لم تُرسَل.`
              : ".") +
            " تحقّق من البيانات المحفوظة قبل إعادة المحاولة؛ تخطّي الموجود يعتمد على نوع البيانات.",
        );
      }
      setSummary(merged);
      setStep("done");
      // الرسائل بدلالة ما كُتب وما فشل فعلاً (لا بدلالة committed وحده): إعادة استيراد ملف كامل
      // = صفر كتابة وصفر فشل — نجاح منطقي لا «فشل» أحمر زائف.
      const written = parts.reduce(
        (a, p) => (p.committed ? a + p.created + p.updated : a),
        0,
      );
      setWrittenCount(written);
      if (stoppedAt != null) {
        notify.err(
          new Error("توقّف الاستيراد عند دفعة فاشلة — راجِع التفاصيل."),
        );
      } else if (merged.failed === 0 && written > 0) {
        notify.ok(`تم استيراد ${written} سجلّاً`);
      } else if (merged.failed === 0) {
        notify.ok(
          "لا جديد — لم تُسجّل كتابة جديدة. راجِع تفاصيل الصفوف المتجاوزة.",
        );
      } else if (written > 0) {
        notify.ok(
          `تم استيراد ${written} سجلّاً وتجاوُز ${merged.failed} فاشلاً`,
        );
      } else {
        notify.err(new Error("لم يُستورَد شيء — راجِع تفاصيل الأخطاء."));
      }
      finalSummary = merged;
    } catch (e) {
      notify.err(e);
      // A lost response says nothing about the current batch commit. Preserve acknowledged writes only.
      finalSummary = {
        ...withClientFailures(mergeSummaries(parts)),
        committed: false,
      };
      const written = parts.reduce(
        (sum, part) =>
          part.committed ? sum + part.created + part.updated : sum,
        0,
      );
      setSummary(finalSummary);
      setWrittenCount(written);
      setStep("done");
      setBatchNote(
        writing
          ? `تعذّر تأكيد نتيجة الدفعة ${currentBatch + 1} من ${batches.length}. تؤكد الردود السابقة حفظ ${written} سجلّاً. لم تُرسل الدفعات التالية؛ تحقّق من البيانات قبل إعادة المحاولة. الملخّص يعرض الردود المؤكدة فقط.`
          : "تعذّر إكمال الفحص التمهيدي — لم تبدأ أي دفعة كتابة. راجِع الخطأ ثم أعد المحاولة.",
      );
    } finally {
      // Cache refresh failure must not turn a successful write into a retryable form.
      if (finalSummary) {
        try {
          await onDone?.(finalSummary);
        } catch (error) {
          notify.err(error);
        }
      }
      lock.current = false;
      setBusy(false);
      setPhase(null);
    }
  }

  return {
    run: runImport,
    busy,
    lock,
    summary,
    progress,
    phase,
    batchNote,
    writtenCount,
    step,
  };
}
