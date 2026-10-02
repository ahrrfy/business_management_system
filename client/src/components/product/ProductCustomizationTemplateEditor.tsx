import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { ArrowDown, ArrowUp, Copy, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addEditorOption,
  createPresetField,
  editorOptions,
  moveEditorOption,
  removeEditorOption,
  renameEditorOption,
  starterFields,
  type CustomizationKind,
  type EditorField,
  type FieldPreset,
  type FieldType,
} from "./customizationTemplateEditorModel";

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: "نص قصير",
  TEXTAREA: "نص طويل للتفاصيل",
  SELECT: "قائمة اختيارات",
  SWATCH: "ألوان أو اختيارات مرئية",
  FILE: "ملف أو رابط تصميم",
  NUMBER: "رقم",
};

const PRESET_BUTTONS: Array<{ preset: FieldPreset; label: string }> = [
  { preset: "LONG_TEXT", label: "تفاصيل يكتبها الزبون" },
  { preset: "SHORT_TEXT", label: "اسم أو عبارة" },
  { preset: "CHOICE", label: "اختيار من قائمة" },
  { preset: "COLOR", label: "اختيار لون" },
  { preset: "DESIGN_FILE", label: "ملف تصميم" },
  { preset: "NUMBER", label: "رقم" },
];

const KIND_DEFAULTS: Record<CustomizationKind, { title: string; description: string }> = {
  GENERAL: { title: "خصّص طلبك", description: "اكتب التفاصيل التي تريد تنفيذها قبل إضافة المنتج إلى السلة." },
  PRINT: { title: "تفاصيل الطباعة أو التصميم", description: "اختر طريقة التنفيذ وأرسل النص أو مرجع التصميم المطلوب." },
  GIFT: { title: "تفاصيل الهدية", description: "أضف بيانات التغليف والمستلم والرسالة قبل الإرسال." },
};

function fieldFromApi(field: {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  isRequired: boolean;
  sortOrder: number;
  maxLength: number | null;
  options: Array<{ value: string; label: string; priceDelta?: string }>;
  dependency: { fieldKey: string; operator: "equals" | "notEquals"; value: string | string[] } | null;
  priceDelta: string;
  isActive: boolean;
}): EditorField {
  return {
    id: field.id,
    fieldKey: field.fieldKey,
    label: field.label,
    fieldType: field.fieldType,
    isRequired: field.isRequired,
    sortOrder: field.sortOrder,
    maxLength: field.maxLength == null ? "" : String(field.maxLength),
    optionsText: field.options.map((option) => `${option.value} | ${option.label} | ${option.priceDelta ?? "0"}`).join("\n"),
    dependencyKey: field.dependency?.fieldKey ?? "",
    dependencyValues: field.dependency ? (Array.isArray(field.dependency.value) ? field.dependency.value : [field.dependency.value]).join(",") : "",
    dependencyOperator: field.dependency?.operator ?? "equals",
    priceDelta: field.priceDelta,
    isActive: field.isActive,
  };
}

function parseOptions(optionsText: string) {
  return optionsText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [value, label, priceDelta = "0"] = line.split("|").map((part) => part.trim());
    return { value, label, priceDelta };
  }).filter((option) => option.value && option.label);
}

type CopyTarget = { productId: number; productName: string; categoryName: string | null; hasTemplate: boolean };

function DependencyValuesControl({ field, fields, onChange }: {
  field: EditorField;
  fields: EditorField[];
  onChange: (value: string) => void;
}) {
  const parent = fields.find((candidate) => candidate.fieldKey === field.dependencyKey);
  const options = parent && ["SELECT", "SWATCH"].includes(parent.fieldType) ? editorOptions(parent.optionsText) : [];
  if (!field.dependencyKey || options.length === 0) {
    return <Input value={field.dependencyValues} onChange={(event) => onChange(event.target.value)} placeholder="القيم المطلوبة مفصولة بفاصلة" disabled={!field.dependencyKey} />;
  }
  const selected = new Set(field.dependencyValues.split(",").map((value) => value.trim()).filter(Boolean));
  return <div className="rounded-md border p-2 md:col-span-2"><p className="mb-2 font-bold">يظهر عند اختيار:</p><div className="flex flex-wrap gap-3">{options.map((option) => <label key={option.value} className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={selected.has(option.value)} onChange={(event) => {
    const next = new Set(selected);
    if (event.target.checked) next.add(option.value); else next.delete(option.value);
    onChange(options.filter((candidate) => next.has(candidate.value)).map((candidate) => candidate.value).join(","));
  }} /> {option.label}</label>)}</div></div>;
}

export function ProductCustomizationTemplateEditor({ productId, enabled }: { productId: number; enabled: boolean }) {
  const query = trpc.catalog.customizationTemplate.useQuery({ productId }, { enabled });
  const categoriesQ = trpc.catalog.categories.useQuery(undefined, { enabled });
  const [kind, setKind] = useState<CustomizationKind>("GENERAL");
  const [title, setTitle] = useState(KIND_DEFAULTS.GENERAL.title);
  const [description, setDescription] = useState(KIND_DEFAULTS.GENERAL.description);
  const [isActive, setIsActive] = useState(true);
  const [fields, setFields] = useState<EditorField[]>(starterFields("GENERAL"));
  const [status, setStatus] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyScope, setCopyScope] = useState<"PRODUCTS" | "CATEGORY">("PRODUCTS");
  const [targetQuery, setTargetQuery] = useState("");
  const [selectedTargets, setSelectedTargets] = useState<CopyTarget[]>([]);
  const [targetCategoryId, setTargetCategoryId] = useState("");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [loadedTemplateId, setLoadedTemplateId] = useState<number | null>(null);
  const [hydratedProductId, setHydratedProductId] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const editVersionRef = useRef(0);
  const submittedSaveVersionRef = useRef<number | null>(null);
  const submittedCopyVersionRef = useRef<number | null>(null);
  const lastQueryDataRef = useRef<{ productId: number; data: unknown } | null>(null);

  const searchTargetsQ = trpc.catalog.searchCustomizationTargets.useQuery(
    { q: targetQuery.trim(), excludeProductId: productId, limit: 20 },
    { enabled: enabled && copyOpen && copyScope === "PRODUCTS" && targetQuery.trim().length >= 1, staleTime: 30_000 },
  );
  const categoryPreviewQ = trpc.catalog.searchCustomizationTargets.useQuery(
    { categoryId: Number(targetCategoryId), excludeProductId: productId, limit: 1 },
    { enabled: enabled && copyOpen && copyScope === "CATEGORY" && Number(targetCategoryId) > 0, staleTime: 30_000 },
  );
  const save = trpc.catalog.saveCustomizationTemplate.useMutation({
    onSuccess: (result) => {
      if (submittedSaveVersionRef.current === editVersionRef.current) dirtyRef.current = false;
      setLoadedTemplateId(result.id);
      setStatus("تم حفظ قالب التخصيص بنجاح.");
      void query.refetch();
    },
    onError: (error) => setStatus(error.message),
  });
  const copyTemplate = trpc.catalog.copyCustomizationTemplate.useMutation({
    onSuccess: (result) => {
      if (submittedCopyVersionRef.current === editVersionRef.current) dirtyRef.current = false;
      setLoadedTemplateId(result.sourceTemplateId);
      setStatus(`تم نسخ القالب إلى ${result.copied} منتج${result.skipped ? `، وتخطي ${result.skipped} له قالب سابق` : ""}.`);
      setSelectedTargets([]);
      setTargetQuery("");
      void query.refetch();
      if (copyScope === "CATEGORY" && targetCategoryId) void categoryPreviewQ.refetch();
    },
    onError: (error) => setStatus(error.message),
  });
  const setActive = trpc.catalog.setCustomizationTemplateActive.useMutation({
    onSuccess: ({ isActive: active, templateId }) => {
      setLoadedTemplateId(templateId);
      setIsActive(active);
      setStatus(active ? "تم تفعيل قالب التخصيص." : "تم إيقاف قالب التخصيص.");
      void query.refetch();
    },
    onError: (error) => {
      setIsActive(query.data?.isActive ?? false);
      setStatus(error.message);
      void query.refetch();
    },
  });

  useEffect(() => {
    if (!query.isSuccess) return;
    const previous = lastQueryDataRef.current;
    if (previous?.productId === productId && previous.data === query.data) return;
    lastQueryDataRef.current = { productId, data: query.data };
    if (previous?.productId === productId && dirtyRef.current) {
      setStatus("وصل تحديث أحدث في الخلفية ولم تُمس كتابتك الحالية. احفظ أو أعد تحميل المنتج للمقارنة.");
      setHydratedProductId(productId);
      return;
    }
    dirtyRef.current = false;
    editVersionRef.current = 0;
    setHydratedProductId(productId);
    if (query.data) {
      setLoadedTemplateId(query.data.id);
      setKind(query.data.kind);
      setTitle(query.data.title);
      setDescription(query.data.description ?? "");
      setIsActive(query.data.isActive);
      setFields(query.data.fields.map(fieldFromApi));
      return;
    }
    setLoadedTemplateId(null);
    setKind("GENERAL");
    setTitle(KIND_DEFAULTS.GENERAL.title);
    setDescription(KIND_DEFAULTS.GENERAL.description);
    setIsActive(true);
    setFields(starterFields("GENERAL"));
  }, [productId, query.data, query.isSuccess]);

  const fieldKeys = useMemo(() => fields.map((field) => field.fieldKey).filter(Boolean), [fields]);
  const selectedIds = useMemo(() => new Set(selectedTargets.map((target) => target.productId)), [selectedTargets]);
  const targetCategory = useMemo(
    () => (categoriesQ.data ?? []).find((category) => Number(category.id) === Number(targetCategoryId)),
    [categoriesQ.data, targetCategoryId],
  );
  const searchResults = (searchTargetsQ.data?.items ?? []).filter((item) => item.productId !== productId && !selectedIds.has(item.productId));

  const markDirty = () => { dirtyRef.current = true; editVersionRef.current += 1; };
  const updateField = (index: number, patch: Partial<EditorField>) => {
    markDirty();
    setFields((current) => {
      const original = current[index];
      const next = current.map((field, i) => i === index ? { ...field, ...patch } : field);
      if (patch.fieldKey && patch.fieldKey !== original.fieldKey) {
        return next.map((field, i) => i !== index && field.dependencyKey === original.fieldKey ? { ...field, dependencyKey: patch.fieldKey! } : field);
      }
      if (patch.optionsText !== undefined) {
        const allowed = new Set(editorOptions(patch.optionsText).map((option) => option.value));
        return next.map((field, i) => i !== index && field.dependencyKey === original.fieldKey
          ? { ...field, dependencyValues: field.dependencyValues.split(",").map((value) => value.trim()).filter((value) => allowed.has(value)).join(",") }
          : field);
      }
      return next;
    });
  };
  const addPreset = (preset: FieldPreset) => { markDirty(); setFields((current) => [...current, createPresetField(preset, current)]); };
  const moveField = (index: number, direction: -1 | 1) => setFields((current) => {
    markDirty();
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= current.length) return current;
    const reordered = [...current];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    return reordered.map((field, fieldIndex) => ({ ...field, sortOrder: (fieldIndex + 1) * 10 }));
  });
  const changeKind = (next: CustomizationKind) => {
    markDirty();
    setKind(next);
    if (!query.data) {
      setTitle(KIND_DEFAULTS[next].title);
      setDescription(KIND_DEFAULTS[next].description);
      setFields(starterFields(next));
    }
  };
  const changeFieldType = (index: number, fieldType: FieldType) => {
    const patch: Partial<EditorField> = { fieldType };
    if (["SELECT", "SWATCH"].includes(fieldType) && !fields[index].optionsText.trim()) {
      patch.optionsText = fieldType === "SWATCH"
        ? "black | أسود | 0\nblue | أزرق | 0"
        : "option_1 | الخيار الأول | 0\noption_2 | الخيار الثاني | 0";
    }
    updateField(index, patch);
  };
  const templateInput = () => ({
    productId,
    expectedTemplateId: loadedTemplateId,
    kind,
    title,
    description: description || null,
    isActive,
    fields: fields.map((field, index) => ({
      id: field.id,
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      isRequired: field.isRequired,
      sortOrder: field.sortOrder || (index + 1) * 10,
      maxLength: field.maxLength ? Number(field.maxLength) : null,
      options: ["SELECT", "SWATCH"].includes(field.fieldType) ? parseOptions(field.optionsText) : [],
      dependency: field.dependencyKey.trim() ? {
        fieldKey: field.dependencyKey.trim(),
        operator: field.dependencyOperator,
        value: field.dependencyValues.split(",").map((value) => value.trim()).filter(Boolean),
      } : null,
      priceDelta: field.priceDelta || "0",
      isActive: field.isActive,
    })),
  });
  const handleSave = () => {
    setStatus("");
    submittedSaveVersionRef.current = editVersionRef.current;
    save.mutate(templateInput());
  };
  const handleCopy = async () => {
    setStatus("");
    try {
      if (copyScope === "CATEGORY" && !categoryPreviewQ.data) {
        setStatus("تعذّر تحميل معاينة الفئة. أعد اختيار الفئة ثم حاول مرة أخرى.");
        return;
      }
      if (copyScope === "CATEGORY" && overwriteExisting) {
        const approved = await confirm({
          variant: "warning",
          title: "استبدال تخصيص فئة كاملة؟",
          description: `سيُطبّق القالب على ${categoryPreviewQ.data?.total ?? 0} منتج نشط في فئة «${targetCategory?.name ?? "الفئة المحددة"}»، وسيُستبدل ${categoryPreviewQ.data?.withTemplate ?? 0} قالب موجود. لا يمكن استعادة القوالب المستبدلة من هذه الشاشة.`,
          confirmText: "استبدال وتعميم القالب",
        });
        if (!approved) return;
      }
      const sourceTemplate = templateInput();
      submittedCopyVersionRef.current = editVersionRef.current;
      if (copyScope === "PRODUCTS") {
        await copyTemplate.mutateAsync({
          sourceProductId: productId,
          sourceTemplate,
          scope: "PRODUCTS",
          productIds: selectedTargets.map((target) => target.productId),
          overwriteExisting,
        });
      } else {
        await copyTemplate.mutateAsync({
          sourceProductId: productId,
          sourceTemplate,
          scope: "CATEGORY",
          categoryId: Number(targetCategoryId),
          expectedMatched: categoryPreviewQ.data!.total,
          expectedExisting: categoryPreviewQ.data!.withTemplate,
          overwriteExisting,
        });
      }
    } catch {
      // mutation تعرض الرسالة المناسبة في خانة الحالة.
    }
  };

  if (!enabled) {
    return <Card className="border-dashed"><CardHeader><CardTitle className="text-base">حقول يملؤها الزبون</CardTitle><CardDescription>فعّل «قابل للتخصيص» أولاً، ثم أضف الحقول التي يحتاجها هذا المنتج.</CardDescription></CardHeader></Card>;
  }
  if (hydratedProductId !== productId && query.isError) {
    return <Card className="border-destructive/40"><CardHeader><CardTitle className="text-base">تعذّر تحميل قالب التخصيص</CardTitle><CardDescription>{query.error.message}</CardDescription></CardHeader><CardContent><Button type="button" variant="outline" onClick={() => void query.refetch()}>إعادة المحاولة</Button></CardContent></Card>;
  }
  if (hydratedProductId !== productId) {
    return <Card className="border-dashed"><CardHeader><CardTitle className="text-base">حقول يملؤها الزبون</CardTitle><CardDescription>جارٍ تحميل قالب التخصيص…</CardDescription></CardHeader></Card>;
  }

  return (
    <Card className="border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]/40">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle className="text-base">حقول يملؤها الزبون</CardTitle><CardDescription>اكتب اسم الحقل واختر نوعه. المفاتيح والترتيب تُدار تلقائياً.</CardDescription></div>
          <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={isActive} disabled={setActive.isPending} onChange={(event) => {
            const active = event.target.checked;
            setIsActive(active);
            if (query.data && loadedTemplateId != null) setActive.mutate({ productId, expectedTemplateId: loadedTemplateId, isActive: active }); else markDirty();
          }} /> يظهر للزبون</label>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-3 rounded-md border bg-background p-3">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs font-bold">الغرض من التخصيص<select value={kind} onChange={(event) => changeKind(event.target.value as CustomizationKind)} className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="GENERAL">طلب عام — الأنسب لمعظم المنتجات</option><option value="PRINT">طباعة أو تصميم</option><option value="GIFT">هدية</option></select></label>
            <label className="text-xs font-bold md:col-span-2">العنوان الذي يراه الزبون<Input value={title} onChange={(event) => { markDirty(); setTitle(event.target.value); }} className="mt-1.5" placeholder="مثال: تفاصيل تخصيص الختم" /></label>
          </div>
          <label className="block text-xs font-bold">تعليمات قصيرة للزبون<Textarea value={description} onChange={(event) => { markDirty(); setDescription(event.target.value); }} className="mt-1.5 min-h-16" placeholder="مثال: اكتب النص الذي تريد طباعته على الختم" /></label>
        </section>

        <section className="space-y-3">
          <div><h4 className="text-sm font-bold">أضف حقلاً جاهزاً</h4><p className="text-sm text-muted-foreground">يمكنك تعديل الاسم والنوع بعد الإضافة.</p></div>
          <div className="flex flex-wrap gap-2">{PRESET_BUTTONS.map((item) => <Button key={item.preset} type="button" variant="outline" size="sm" onClick={() => addPreset(item.preset)}><Plus className="size-3.5" /> {item.label}</Button>)}</div>
        </section>

        <section className="space-y-3">
          {fields.length ? fields.map((field, index) => (
            <div key={`${field.id ?? field.fieldKey}-${index}`} className="rounded-md border bg-background p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-muted-foreground">الحقل {index + 1}</span>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" className="size-11" onClick={() => moveField(index, -1)} disabled={index === 0} aria-label="نقل الحقل إلى الأعلى"><ArrowUp className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-11" onClick={() => moveField(index, 1)} disabled={index === fields.length - 1} aria-label="نقل الحقل إلى الأسفل"><ArrowDown className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-11" onClick={() => { markDirty(); setFields((current) => current.filter((_, i) => i !== index).map((candidate) => candidate.dependencyKey === field.fieldKey ? { ...candidate, dependencyKey: "", dependencyValues: "" } : candidate)); }} aria-label="حذف الحقل"><Trash2 className="size-4 text-destructive" /></Button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_15rem_auto] md:items-end">
                <label className="text-xs font-bold">اسم الحقل كما يراه الزبون<Input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} className="mt-1.5" placeholder="مثال: النص المطلوب على الختم" /></label>
                <label className="text-xs font-bold">طريقة الإجابة<select value={field.fieldType} onChange={(event) => changeFieldType(index, event.target.value as FieldType)} className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm">{Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="flex h-9 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={field.isRequired} onChange={(event) => updateField(index, { isRequired: event.target.checked })} /> مطلوب</label>
              </div>
              {["SELECT", "SWATCH"].includes(field.fieldType) && <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-bold">الخيارات التي يراها الزبون</span><Button type="button" variant="outline" size="sm" onClick={() => updateField(index, { optionsText: addEditorOption(field.optionsText) })}><Plus className="size-3.5" /> إضافة خيار</Button></div>
                {editorOptions(field.optionsText).map((option, optionIndex, options) => <div key={option.value} className="flex items-center gap-1">
                  <Input value={option.label} onChange={(event) => updateField(index, { optionsText: renameEditorOption(field.optionsText, option.value, event.target.value) })} aria-label={`اسم الخيار ${optionIndex + 1}`} />
                  <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" onClick={() => updateField(index, { optionsText: moveEditorOption(field.optionsText, option.value, -1) })} disabled={optionIndex === 0} aria-label={`نقل الخيار ${option.label} إلى الأعلى`}><ArrowUp className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" onClick={() => updateField(index, { optionsText: moveEditorOption(field.optionsText, option.value, 1) })} disabled={optionIndex === options.length - 1} aria-label={`نقل الخيار ${option.label} إلى الأسفل`}><ArrowDown className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" onClick={() => updateField(index, { optionsText: removeEditorOption(field.optionsText, option.value) })} aria-label={`حذف الخيار ${option.label}`}><Trash2 className="size-4 text-destructive" /></Button>
                </div>)}
              </div>}
              <details className="mt-3 rounded-md border border-dashed p-2 text-xs">
                <summary className="cursor-pointer font-bold text-muted-foreground">إعدادات متقدمة — اختيارية</summary>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  <label>الحد الأقصى للنص<Input value={field.maxLength} onChange={(event) => updateField(index, { maxLength: event.target.value })} type="number" className="mt-1" placeholder="تلقائي" /></label>
                  <label>سعر إضافي<Input value={field.priceDelta} onChange={(event) => updateField(index, { priceDelta: event.target.value })} className="mt-1" /></label>
                  <label>المفتاح التقني<Input value={field.fieldKey} onChange={(event) => updateField(index, { fieldKey: event.target.value })} className="mt-1 font-mono" dir="ltr" /></label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={field.isActive} onChange={(event) => updateField(index, { isActive: event.target.checked })} /> ظاهر للزبون</label>
                  <select value={field.dependencyKey} onChange={(event) => updateField(index, { dependencyKey: event.target.value })} className="h-9 rounded-md border bg-background px-2"><option value="">يظهر دائماً</option>{fieldKeys.filter((key) => key !== field.fieldKey).map((key) => <option key={key} value={key}>يظهر حسب {key}</option>)}</select>
                  <DependencyValuesControl field={field} fields={fields} onChange={(value) => updateField(index, { dependencyValues: value })} />
                </div>
              </details>
            </div>
          )) : <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">لا توجد حقول بعد. اختر أحد الحقول الجاهزة أعلاه.</div>}
        </section>

        <section className="rounded-md border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h4 className="text-sm font-bold">تطبيق نفس التخصيص بسرعة</h4><p className="text-sm text-muted-foreground">انسخ الحقول إلى منتجات محددة أو إلى فئة كاملة.</p></div>
            <Button type="button" variant="outline" size="sm" onClick={() => setCopyOpen((value) => !value)}><Copy className="size-4" /> {copyOpen ? "إغلاق النسخ" : "نسخ هذا القالب"}</Button>
          </div>
          {copyOpen && <div className="mt-4 space-y-4 border-t pt-4">
            <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="radio" name={`copy-scope-${productId}`} checked={copyScope === "PRODUCTS"} onChange={() => setCopyScope("PRODUCTS")} /> منتجات محددة</label><label className="flex items-center gap-2"><input type="radio" name={`copy-scope-${productId}`} checked={copyScope === "CATEGORY"} onChange={() => setCopyScope("CATEGORY")} /> فئة كاملة</label></div>
            {copyScope === "PRODUCTS" ? <div className="space-y-2">
              <UnifiedSearchInput value={targetQuery} onChange={setTargetQuery} placeholder="ابحث عن المنتج بالاسم…" aria-label="بحث عن منتجات لنسخ التخصيص" debounceMs={200} size="default" />
              {targetQuery.trim() && <div className="max-h-48 overflow-y-auto rounded-md border">{searchTargetsQ.isLoading ? <p className="p-3 text-sm text-muted-foreground">جارٍ البحث…</p> : searchResults.length ? searchResults.map((item) => <button key={item.productId} type="button" onClick={() => { setSelectedTargets((current) => [...current, item]); setTargetQuery(""); }} className="flex min-h-11 w-full items-center justify-between border-b px-3 py-2 text-start text-sm last:border-0 hover:bg-muted"><span><b>{item.productName}</b>{item.categoryName && <span className="ms-2 text-muted-foreground">{item.categoryName}</span>}</span><span className={item.hasTemplate ? "text-[var(--sem-warn)]" : "text-primary"}>{item.hasTemplate ? "له قالب" : "إضافة"}</span></button>) : <p className="p-3 text-sm text-muted-foreground">لا توجد نتائج جديدة.</p>}</div>}
              {selectedTargets.length > 0 && <div className="flex flex-wrap gap-2">{selectedTargets.map((target) => <span key={target.productId} className="inline-flex min-h-11 items-center gap-1 rounded-md border bg-muted ps-3 text-sm">{target.productName}{target.hasTemplate && <b className="text-[var(--sem-warn)]">له قالب</b>}<button type="button" className="flex size-11 items-center justify-center" onClick={() => setSelectedTargets((current) => current.filter((item) => item.productId !== target.productId))} aria-label={`إزالة ${target.productName}`}><X className="size-4" /></button></span>)}</div>}
            </div> : <label className="block text-sm font-bold">الفئة المستهدفة<select value={targetCategoryId} onChange={(event) => setTargetCategoryId(event.target.value)} className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="">اختر الفئة</option>{(categoriesQ.data ?? []).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{targetCategoryId && <span className="mt-2 block font-normal text-muted-foreground">سيُفحص {categoryPreviewQ.data?.total ?? "…"} منتج نشط غير المنتج الحالي، منها {categoryPreviewQ.data?.withTemplate ?? "…"} لديها قالب سابق.</span>}</label>}
            <label className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-3 text-sm"><input type="checkbox" checked={overwriteExisting} onChange={(event) => setOverwriteExisting(event.target.checked)} className="mt-0.5" /><span><b>استبدال القوالب الموجودة</b><br />اتركه غير محدد لحماية أي تخصيص أعدّه الموظفون سابقاً.</span></label>
            <Button type="button" onClick={handleCopy} disabled={copyTemplate.isPending || categoryPreviewQ.isFetching || fields.length === 0 || (copyScope === "PRODUCTS" ? selectedTargets.length === 0 : !targetCategoryId || !categoryPreviewQ.isSuccess)}><Copy className="size-4" /> {copyTemplate.isPending ? "جارٍ الحفظ والنسخ…" : copyScope === "PRODUCTS" ? `حفظ ونسخ إلى ${selectedTargets.length} منتج` : "حفظ ونسخ إلى الفئة"}</Button>
          </div>}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-muted-foreground" role="status">{status}</span><Button type="button" onClick={handleSave} disabled={save.isPending || fields.length === 0}><Save className="size-4" /> {save.isPending ? "جارٍ الحفظ…" : "حفظ قالب التخصيص"}</Button></div>
      </CardContent>
    </Card>
  );
}
