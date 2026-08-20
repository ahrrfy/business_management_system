import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type FieldType = "TEXT" | "TEXTAREA" | "SELECT" | "FILE" | "NUMBER" | "SWATCH";
type Kind = "PRINT" | "GIFT" | "GENERAL";

type EditorField = {
  id?: number;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  isRequired: boolean;
  sortOrder: number;
  maxLength: string;
  optionsText: string;
  dependencyKey: string;
  dependencyValues: string;
  dependencyOperator: "equals" | "notEquals";
  priceDelta: string;
  isActive: boolean;
};

function starterFields(kind: Kind): EditorField[] {
  if (kind === "PRINT") {
    return [
      { fieldKey: "service", label: "نوع التنفيذ", fieldType: "SELECT", isRequired: true, sortOrder: 10, maxLength: "", optionsText: "text | اسم أو عبارة | 0\nfile | صورة أو تصميم | 0\nfull | طباعة كاملة | 0", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
      { fieldKey: "packaging", label: "التغليف", fieldType: "SELECT", isRequired: false, sortOrder: 20, maxLength: "", optionsText: "standard | تغليف عادي | 0\ngift | تغليف هدية | 0", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
      { fieldKey: "message", label: "رسالة أو تفاصيل إضافية", fieldType: "TEXTAREA", isRequired: false, sortOrder: 30, maxLength: "300", optionsText: "", dependencyKey: "service", dependencyValues: "text,full", dependencyOperator: "equals", priceDelta: "0", isActive: true },
      { fieldKey: "designFile", label: "مرجع ملف التصميم", fieldType: "FILE", isRequired: true, sortOrder: 40, maxLength: "", optionsText: "", dependencyKey: "service", dependencyValues: "file,full", dependencyOperator: "equals", priceDelta: "0", isActive: true },
    ];
  }
  if (kind === "GIFT") {
    return [
      { fieldKey: "packaging", label: "التغليف", fieldType: "SELECT", isRequired: false, sortOrder: 10, maxLength: "", optionsText: "standard | تغليف عادي | 0\ngift | تغليف هدية | 0", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
      { fieldKey: "recipient", label: "اسم المستلم", fieldType: "TEXT", isRequired: false, sortOrder: 20, maxLength: "120", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
      { fieldKey: "message", label: "رسالة الإهداء", fieldType: "TEXTAREA", isRequired: false, sortOrder: 30, maxLength: "300", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true },
    ];
  }
  return [{ fieldKey: "details", label: "تفاصيل الطلب", fieldType: "TEXTAREA", isRequired: false, sortOrder: 10, maxLength: "500", optionsText: "", dependencyKey: "", dependencyValues: "", dependencyOperator: "equals", priceDelta: "0", isActive: true }];
}

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
  return optionsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label, priceDelta = "0"] = line.split("|").map((part) => part.trim());
      return { value, label, priceDelta };
    })
    .filter((option) => option.value && option.label);
}

export function ProductCustomizationTemplateEditor({ productId, enabled }: { productId: number; enabled: boolean }) {
  const query = trpc.catalog.customizationTemplate.useQuery({ productId }, { enabled });
  const save = trpc.catalog.saveCustomizationTemplate.useMutation({
    onSuccess: () => setStatus("تم حفظ قالب التخصيص بنجاح."),
    onError: (error) => setStatus(error.message),
  });
  const [kind, setKind] = useState<Kind>("PRINT");
  const [title, setTitle] = useState("خصّص طلبك قبل الإضافة");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [fields, setFields] = useState<EditorField[]>(starterFields("PRINT"));
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!query.data) return;
    setKind(query.data.kind);
    setTitle(query.data.title);
    setDescription(query.data.description ?? "");
    setIsActive(query.data.isActive);
    setFields(query.data.fields.map(fieldFromApi));
  }, [query.data]);

  const fieldKeys = useMemo(() => fields.map((field) => field.fieldKey).filter(Boolean), [fields]);
  const updateField = (index: number, patch: Partial<EditorField>) => setFields((current) => current.map((field, i) => i === index ? { ...field, ...patch } : field));
  const addField = () => setFields((current) => [...current, {
    fieldKey: `field_${current.length + 1}`,
    label: "حقل جديد",
    fieldType: "TEXT",
    isRequired: false,
    sortOrder: (current.length + 1) * 10,
    maxLength: "",
    optionsText: "",
    dependencyKey: "",
    dependencyValues: "",
    dependencyOperator: "equals",
    priceDelta: "0",
    isActive: true,
  }]);
  const changeKind = (next: Kind) => {
    setKind(next);
    if (!query.data) setFields(starterFields(next));
  };

  const handleSave = () => {
    setStatus("");
    save.mutate({
      productId,
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
        sortOrder: Number(field.sortOrder) || (index + 1) * 10,
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
  };

  if (!enabled) {
    return <Card className="border-dashed"><CardHeader><CardTitle className="text-base">قالب التخصيص</CardTitle><CardDescription>فعّل «قابل للتخصيص» أولاً حتى يظهر محرر الحقول والتبعيات.</CardDescription></CardHeader></Card>;
  }

  return (
    <Card className="border-amber-200 bg-amber-50/40">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div><CardTitle className="text-base">قالب التخصيص المنظم</CardTitle><CardDescription>عرّف الحقول التي تظهر للزبون وتبعياتها. المنتج العادي لا يعرض هذا النموذج.</CardDescription></div>
        <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /> مفعّل</label>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs font-bold">نوع القالب<select value={kind} onChange={(event) => changeKind(event.target.value as Kind)} className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="PRINT">طباعة</option><option value="GIFT">هدية</option><option value="GENERAL">عام</option></select></label>
          <label className="text-xs font-bold md:col-span-2">عنوان النموذج<Input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1.5" /></label>
        </div>
        <label className="block text-xs font-bold">وصف مختصر<Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1.5 min-h-16" placeholder="ماذا يحتاج الزبون قبل الإضافة للسلة؟" /></label>
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={`${field.id ?? "new"}-${index}`} className="rounded-xl border bg-background p-3">
              <div className="grid gap-2 md:grid-cols-[1fr_1.4fr_150px_90px_auto]">
                <Input value={field.fieldKey} onChange={(event) => updateField(index, { fieldKey: event.target.value })} placeholder="fieldKey" aria-label="مفتاح الحقل" />
                <Input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} placeholder="اسم الحقل" aria-label="اسم الحقل" />
                <select value={field.fieldType} onChange={(event) => updateField(index, { fieldType: event.target.value as FieldType })} className="h-9 rounded-md border bg-background px-2 text-sm" aria-label="نوع الحقل"><option value="TEXT">نص قصير</option><option value="TEXTAREA">نص طويل</option><option value="SELECT">قائمة اختيار</option><option value="SWATCH">اختيارات مرئية</option><option value="FILE">مرجع ملف</option><option value="NUMBER">رقم</option></select>
                <Input value={field.sortOrder} onChange={(event) => updateField(index, { sortOrder: Number(event.target.value) || 0 })} type="number" placeholder="الترتيب" aria-label="الترتيب" />
                <Button type="button" variant="ghost" size="icon" onClick={() => setFields((current) => current.filter((_, i) => i !== index))} aria-label="حذف الحقل"><Trash2 className="size-4 text-rose-600" /></Button>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-4">
                <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={field.isRequired} onChange={(event) => updateField(index, { isRequired: event.target.checked })} /> مطلوب</label>
                <Input value={field.maxLength} onChange={(event) => updateField(index, { maxLength: event.target.value })} type="number" placeholder="الحد الأقصى للنص" />
                <Input value={field.priceDelta} onChange={(event) => updateField(index, { priceDelta: event.target.value })} placeholder="سعر إضافي" />
                <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={field.isActive} onChange={(event) => updateField(index, { isActive: event.target.checked })} /> ظاهر للزبون</label>
              </div>
              {["SELECT", "SWATCH"].includes(field.fieldType) && <label className="mt-2 block text-xs font-bold">الخيارات <span className="font-normal text-muted-foreground">(قيمة | عنوان | سعر إضافي، كل خيار في سطر)</span><Textarea value={field.optionsText} onChange={(event) => updateField(index, { optionsText: event.target.value })} className="mt-1.5 min-h-16 font-mono text-xs" /></label>}
              <div className="mt-2 grid gap-2 md:grid-cols-[1fr_1fr_150px]">
                <select value={field.dependencyKey} onChange={(event) => updateField(index, { dependencyKey: event.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">بلا تبعية</option>{fieldKeys.filter((key) => key !== field.fieldKey).map((key) => <option key={key} value={key}>{key}</option>)}</select>
                <Input value={field.dependencyValues} onChange={(event) => updateField(index, { dependencyValues: event.target.value })} placeholder="القيم المطلوبة مفصولة بفاصلة" disabled={!field.dependencyKey} />
                <select value={field.dependencyOperator} onChange={(event) => updateField(index, { dependencyOperator: event.target.value as "equals" | "notEquals" })} className="h-9 rounded-md border bg-background px-2 text-sm" disabled={!field.dependencyKey}><option value="equals">عند مساواة القيمة</option><option value="notEquals">عند اختلاف القيمة</option></select>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={addField}><Plus className="me-1 size-4" /> إضافة حقل</Button>
          <div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{status}</span><Button type="button" onClick={handleSave} disabled={save.isPending}><Save className="me-1 size-4" /> {save.isPending ? "جارٍ الحفظ…" : "حفظ القالب"}</Button></div>
        </div>
      </CardContent>
    </Card>
  );
}
