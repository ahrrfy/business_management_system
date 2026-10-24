import * as React from "react";
import { D } from "@/lib/money";
import {
  buildRows,
  findBarcodeConflicts,
  findFileDuplicates,
  findSkuConflicts,
  normHeader,
  splitIntoBatches,
  type CellError,
  type ColumnMapping,
  type ImportField,
  type ImportMeta,
  type ImportParseResult,
  type ParsedRow,
} from "@/lib/import";
import { BATCH_SIZE } from "./types";
export function useImportPreview<TRow>({
  fields,
  meta,
  parse,
  mapping,
  skipFailed,
  usdRate,
  balanceSign,
}: {
  fields: ImportField<TRow>[];
  meta?: ImportMeta;
  parse: ImportParseResult | null;
  mapping: ColumnMapping<TRow>;
  skipFailed: boolean;
  usdRate: string;
  balanceSign: "asIs" | "invert";
}) {
  // fallback للمنتجات دون لمس Products.tsx: غياب الـprop + وجود مفتاح productName ⇒ تجميع وتقسيم
  // (سلوك عميلٍ صرف)، مع إخفاء خيارات الخادم لأنها لن تصل الخادم أصلاً.
  const effectiveMeta: ImportMeta | undefined = React.useMemo(() => {
    if (meta) return meta;
    if (fields.some((f) => f.key === "productName")) {
      return {
        batchGroupByKey: "productName",
        supportsServerOptions: false,
        skuConflictKeys: {
          sku: "sku",
          fallback: "barcode",
          owner: "productName",
          barcode: "barcode",
          unit: "unitName",
        },
      };
    }
    return undefined;
  }, [meta, fields]);
  const supportsOptions = effectiveMeta?.supportsServerOptions === true;

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
    if (effectiveMeta.duplicateKeys)
      add(findFileDuplicates(built, effectiveMeta.duplicateKeys), "_duplicate");
    if (effectiveMeta.skuConflictKeys) {
      add(
        findSkuConflicts(built, effectiveMeta.skuConflictKeys),
        "_skuConflict",
      );
      // تكرار الباركود عبر متغيّرات مختلفة: كشف الخادم له يعمل داخل النداء الواحد فقط ويضيع عبر
      // الدفعات (دفعات أولى تلتزم ثم تفشل لاحقة) — يُكشف هنا على الملف كاملاً قبل الإرسال.
      add(
        findBarcodeConflicts(built, effectiveMeta.skuConflictKeys),
        "_barcodeConflict",
      );
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
  const warningCount = checked.filter(
    (r) => r.errors.length === 0 && r.warnings.length > 0,
  ).length;

  const mappedFieldKeys = new Set(
    Object.values(mapping).filter(Boolean) as string[],
  );
  const unmappedRequired = fields.filter(
    (f) => f.required && !mappedFieldKeys.has(f.key),
  );

  const balanceKey = effectiveMeta?.balanceKey;
  const balanceMapped = balanceKey != null && mappedFieldKeys.has(balanceKey);
  const currencyField = effectiveMeta?.currencyKey
    ? fields.find((f) => f.key === effectiveMeta.currencyKey)
    : undefined;
  const currencyMapped =
    currencyField != null && mappedFieldKeys.has(currencyField.key);

  // هل يحوي الملف صفوف USD؟ (يُظهر حقل سعر الصرف ويجعله إلزامياً)
  const hasUsd = React.useMemo(() => {
    if (!currencyField || !currencyMapped) return false;
    return checked.some(
      (r) => (r.values as Record<string, unknown>)[currencyField.key] === "USD",
    );
  }, [checked, currencyField, currencyMapped]);
  const usdRateRequired = hasUsd && supportsOptions;
  // Number للمقارنة فقط — التخزين والتمرير نصّاً (قاعدة الأموال).
  const usdRateValid =
    /^\d+(\.\d{1,2})?$/.test(usdRate.trim()) && Number(usdRate) > 0;

  // حارس فكّ الربط: رُبط الرصيد ووُجد عمودٌ تُطبَّع ترويسته إلى «العملة» وهو غير مربوط
  // ⇒ منع التنفيذ — وإلا خُزّنت أرصدة USD كأنها IQD حرفياً بلا أي إنذار.
  const currencyGuard = React.useMemo(() => {
    if (!parse || !currencyField || !balanceMapped || currencyMapped)
      return false;
    const names = new Set([
      normHeader(currencyField.label),
      normHeader(currencyField.key),
      ...(currencyField.aliases ?? []).map(normHeader),
    ]);
    return parse.headers.some(
      (h) => mapping[h] == null && names.has(normHeader(h)),
    );
  }, [parse, currencyField, balanceMapped, currencyMapped, mapping]);

  // معاينة اتجاه الرصيد المحسوبة الحيّة: ٢-٣ صفوف حقيقية ذات رصيد غير صفري مفسَّرةً بأرقامها —
  // قلب الإشارة يقلب ذمم الملف كله دفعةً واحدة، فيجب أن يُرى أثره قبل التنفيذ لا بعده.
  const balancePreview = React.useMemo(() => {
    if (!balanceKey || !balanceMapped) return [];
    const header = Object.entries(mapping).find(
      ([, fk]) => fk === balanceKey,
    )?.[0];
    const hints = effectiveMeta?.balanceHints;
    const out: { rowNumber: number; rawText: string; text: string }[] = [];
    for (const r of checked) {
      const v = (r.values as Record<string, unknown>)[balanceKey];
      if (typeof v !== "string" || D(v).isZero()) continue;
      const stored = balanceSign === "invert" ? D(v).neg() : D(v);
      const hint = stored.isNegative()
        ? (hints?.negative ?? "بالسالب")
        : (hints?.positive ?? "بالموجب");
      const curr =
        currencyField &&
        (r.values as Record<string, unknown>)[currencyField.key] === "USD"
          ? "$"
          : "د.ع";
      const rawText = header != null ? String(r.raw[header] ?? "") : v;
      out.push({
        rowNumber: r.rowNumber,
        rawText,
        text: `${hint} ${stored.abs().toNumber().toLocaleString("ar-IQ-u-nu-latn")} ${curr}`,
      });
      if (out.length >= 3) break;
    }
    return out;
  }, [
    checked,
    balanceKey,
    balanceMapped,
    balanceSign,
    mapping,
    effectiveMeta,
    currencyField,
  ]);

  // عدد الدفعات المخطّط (للنصّ التوضيحي) — التجميع بمفتاح الـmeta يمنع فصم منتج عبر دفعتين.
  const plannedBatchCount = React.useMemo(() => {
    const groupKey = effectiveMeta?.batchGroupByKey;
    const keyOf = groupKey
      ? (r: ParsedRow<TRow>) =>
          String((r.values as Record<string, unknown>)[groupKey] ?? "")
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

  return {
    effectiveMeta,
    supportsOptions,
    checked,
    invalidCount,
    validRows,
    warningCount,
    unmappedRequired,
    balanceMapped,
    currencyField,
    currencyGuard,
    balancePreview,
    hasUsd,
    usdRateRequired,
    usdRateValid,
    plannedBatchCount,
    canRun,
    previewFields: fields.filter((field) => mappedFieldKeys.has(field.key)),
  };
}
export type ImportPreview<TRow> = ReturnType<typeof useImportPreview<TRow>>;
