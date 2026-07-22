// إعدادات تسعير الطباعة الرقمية — يملؤها المدير (تبويب managerOnly في PrintHub + الخادم
// managerProcedure). خمسة أقسام: الإعدادات العامّة (وضع/هامش/تجهيز) + أسعار الوجه (مقاس×نمط) +
// الورق المميّز + الوسائط العريضة + خيارات التشطيب. كل حقل ماليّ عبر MoneyInput (قيمة خام للإرسال).
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Plus, Trash2, Edit3, X, Check, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { MoneyInput } from "@/components/form/MoneyInput";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { formatIqd } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import {
  COLOR_MODE_AR,
  COLOR_MODES,
  FINISHING_UNIT_AR,
  FINISHING_UNITS,
  PAPER_SIZES,
  PAPER_UPCHARGE_UNIT_AR,
  PAPER_UPCHARGE_UNITS,
  PRICING_MODE_AR,
  PRICING_MODES,
  type ColorMode,
  type FinishingUnit,
  type PaperSizeCode,
  type PaperUpchargeUnit,
  type PricingMode,
} from "@shared/printPricing";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const sizeLabel = (c: string) => PAPER_SIZES.find((s) => s.code === c)?.label ?? c;

export default function PrintPricingSettings() {
  const utils = trpc.useUtils();
  const bundle = trpc.printPricing.settings.useQuery();
  const invalidate = () => utils.printPricing.settings.invalidate();

  return (
    <div className="space-y-4">
      <PageHeader
        title="إعدادات تسعير الطباعة"
        icon={<SlidersHorizontal aria-hidden className="size-6 text-primary" />}
        description="اضبط أسعار الوجه والوسائط والتشطيب — الحاسبة تستعملها مباشرةً. المطبعة ديجيتال: سعر الوجه يشمل الورق."
        actions={
          <Link href="/work-orders?tab=print-pricing">
            <Button variant="outline" size="sm">→ الحاسبة</Button>
          </Link>
        }
      />

      {bundle.isLoading ? (
        <Card><CardContent className="p-6 text-center text-muted-foreground">جارٍ التحميل…</CardContent></Card>
      ) : bundle.isError ? (
        <Card><CardContent className="p-6 text-center text-amber-600">{bundle.error?.message}</CardContent></Card>
      ) : (
        <>
          <GeneralSettings settings={bundle.data!.settings} onSaved={invalidate} />
          <FacePricesSection rows={bundle.data!.facePrices} onChanged={invalidate} />
          <PaperUpchargesSection rows={bundle.data!.paperUpcharges} onChanged={invalidate} />
          <WideMediaSection rows={bundle.data!.wideMedia} onChanged={invalidate} />
          <FinishingSection rows={bundle.data!.finishings} onChanged={invalidate} />
        </>
      )}
    </div>
  );
}

// ─── الإعدادات العامّة ───────────────────────────────────────────────────────
function GeneralSettings({
  settings,
  onSaved,
}: {
  settings: { pricingMode: PricingMode; defaultMarginPercent: string; setupFee: string };
  onSaved: () => Promise<unknown>;
}) {
  const [form, setForm] = useState<typeof settings | null>(null);
  useEffect(() => {
    if (!form) setForm(settings);
  }, [settings, form]);

  const save = trpc.printPricing.updateSettings.useMutation({
    onSuccess: async () => {
      await onSaved();
      notify.ok("حُفظت الإعدادات العامّة");
    },
    onError: (e) => notify.err(e),
  });

  if (!form) return null;
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">الإعدادات العامّة</CardTitle></CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>وضع التسعير</Label>
          <select
            className={selectCls}
            value={form.pricingMode}
            onChange={(e) => setForm({ ...form, pricingMode: e.target.value as PricingMode })}
          >
            {PRICING_MODES.map((m) => (
              <option key={m} value={m}>{PRICING_MODE_AR[m]}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>نسبة الهامش الافتراضية ٪</Label>
          <Input
            inputMode="decimal"
            value={form.defaultMarginPercent}
            onChange={(e) => setForm({ ...form, defaultMarginPercent: e.target.value.replace(/[^\d.]/g, "") })}
            disabled={form.pricingMode === "DIRECT"}
            placeholder="0"
          />
          {form.pricingMode === "DIRECT" && (
            <p className="text-xs text-muted-foreground">الوضع المباشر: الأسعار المضبوطة هي سعر البيع (بلا هامش).</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>رسم التجهيز/التصميم</Label>
          <MoneyInput value={form.setupFee} onChange={(v) => setForm({ ...form, setupFee: v })} ariaLabel="رسم التجهيز" />
        </div>
        <div className="sm:col-span-3">
          <Button
            onClick={() => save.mutate({ pricingMode: form.pricingMode, defaultMarginPercent: form.defaultMarginPercent || "0", setupFee: form.setupFee || "0" })}
            disabled={save.isPending}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            حفظ الإعدادات العامّة
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── أسعار الوجه (المقاس × النمط) ────────────────────────────────────────────
function FacePricesSection({
  rows,
  onChanged,
}: {
  rows: { id: number; paperSize: PaperSizeCode; colorMode: ColorMode; pricePerFace: string }[];
  onChanged: () => Promise<unknown>;
}) {
  const [size, setSize] = useState<PaperSizeCode>("A4");
  const [mode, setMode] = useState<ColorMode>("COLOR");
  const [price, setPrice] = useState("");

  const upsert = trpc.printPricing.upsertFacePrice.useMutation({
    onSuccess: async () => {
      await onChanged();
      setPrice("");
      notify.ok("حُفظ سعر الوجه");
    },
    onError: (e) => notify.err(e),
  });
  const del = trpc.printPricing.deleteFacePrice.useMutation({
    onSuccess: async () => {
      await onChanged();
      notify.ok("حُذف السعر");
    },
    onError: (e) => notify.err(e),
  });

  function submit() {
    if (!price || !/[1-9]/.test(price)) {
      notify.err("أدخل سعر وجهٍ موجباً");
      return;
    }
    upsert.mutate({ paperSize: size, colorMode: mode, pricePerFace: price });
  }

  async function remove(id: number, label: string) {
    if (!(await confirm({ variant: "warning", title: "حذف السعر", description: `سيُلغى تسعير ${label}.`, confirmText: "حذف" }))) return;
    del.mutate({ id });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">أسعار الوجه المطبوع (الورق مشمول)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <select className={selectCls} value={mode} onChange={(e) => setMode(e.target.value as ColorMode)} aria-label="النمط">
            {COLOR_MODES.map((m) => <option key={m} value={m}>{COLOR_MODE_AR[m]}</option>)}
          </select>
          <select className={selectCls} value={size} onChange={(e) => setSize(e.target.value as PaperSizeCode)} aria-label="المقاس">
            {PAPER_SIZES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
          <MoneyInput value={price} onChange={setPrice} ariaLabel="سعر الوجه" placeholder="سعر الوجه" />
          <Button onClick={submit} disabled={upsert.isPending} className="bg-emerald-600 hover:bg-emerald-700">
            <Plus aria-hidden className="size-4 ms-1" /> حفظ السعر
          </Button>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">لا أسعار وجه مضبوطة بعد — أضِف المقاسات التي تستعملها.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">المقاس</th>
                  <th className="p-2 text-start">النمط</th>
                  <th className="p-2 text-start">سعر الوجه</th>
                  <th className="p-2 text-center">حذف</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="p-2">{sizeLabel(r.paperSize)}</td>
                    <td className="p-2">{COLOR_MODE_AR[r.colorMode]}</td>
                    <td className="p-2 tabular-nums">{formatIqd(r.pricePerFace)}</td>
                    <td className="p-2 text-center">
                      <Button size="sm" variant="ghost" onClick={() => void remove(r.id, `${sizeLabel(r.paperSize)} / ${COLOR_MODE_AR[r.colorMode]}`)} title="حذف">
                        <Trash2 aria-hidden className="size-3.5 text-rose-600" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── قسم قائمة عامّ (ورق مميّز / وسائط / تشطيب) ───────────────────────────────
interface ManagedRow {
  id: number;
  name: string;
  unit?: string;
  money: string;
  isActive: boolean;
}
function ManagedListSection({
  title,
  description,
  rows,
  moneyLabel,
  unitOptions,
  unitLabel,
  onCreate,
  onUpdate,
  busy,
}: {
  title: string;
  description: string;
  rows: ManagedRow[];
  moneyLabel: string;
  /** خيارات الوحدة (إن وُجدت) — {value,label}. */
  unitOptions?: { value: string; label: string }[];
  unitLabel?: string;
  onCreate: (v: { name: string; unit?: string; money: string }) => void;
  onUpdate: (v: { id: number; name?: string; unit?: string; money?: string; isActive?: boolean }) => void;
  busy: boolean;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState(unitOptions?.[0]?.value ?? "");
  const [money, setMoney] = useState("");

  function reset() {
    setEditingId(null);
    setName("");
    setUnit(unitOptions?.[0]?.value ?? "");
    setMoney("");
  }
  function startEdit(r: ManagedRow) {
    setEditingId(r.id);
    setName(r.name);
    setUnit(r.unit ?? unitOptions?.[0]?.value ?? "");
    setMoney(r.money);
  }
  function submit() {
    if (!name.trim()) {
      notify.err("الاسم مطلوب");
      return;
    }
    if (!money || !/[1-9]/.test(money)) {
      notify.err(`أدخل ${moneyLabel} موجباً`);
      return;
    }
    if (editingId != null) {
      onUpdate({ id: editingId, name: name.trim(), unit: unitOptions ? unit : undefined, money });
    } else {
      onCreate({ name: name.trim(), unit: unitOptions ? unit : undefined, money });
    }
    reset();
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={`grid grid-cols-1 gap-2 ${unitOptions ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم" />
          {unitOptions && (
            <select className={selectCls} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={unitLabel}>
              {unitOptions.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          )}
          <MoneyInput value={money} onChange={setMoney} ariaLabel={moneyLabel} placeholder={moneyLabel} />
          <div className="flex gap-1">
            <Button onClick={submit} disabled={busy} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
              {editingId != null ? <><Check aria-hidden className="size-4 ms-1" /> حفظ</> : <><Plus aria-hidden className="size-4 ms-1" /> إضافة</>}
            </Button>
            {editingId != null && (
              <Button variant="outline" onClick={reset} title="إلغاء"><X aria-hidden className="size-4" /></Button>
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">لا عناصر بعد.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">الاسم</th>
                  {unitOptions && <th className="p-2 text-start">{unitLabel}</th>}
                  <th className="p-2 text-start">{moneyLabel}</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t border-border ${r.isActive ? "" : "opacity-60"}`}>
                    <td className="p-2 font-medium">{r.name}</td>
                    {unitOptions && <td className="p-2">{unitOptions.find((u) => u.value === r.unit)?.label ?? r.unit}</td>}
                    <td className="p-2 tabular-nums">{formatIqd(r.money)}</td>
                    <td className="p-2 text-center text-xs">{r.isActive ? "فعّال" : "معطّل"}</td>
                    <td className="p-2 text-center">
                      <div className="flex justify-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => startEdit(r)} title="تعديل">
                          <Edit3 aria-hidden className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onUpdate({ id: r.id, isActive: !r.isActive })} disabled={busy}>
                          {r.isActive ? "تعطيل" : "تفعيل"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PaperUpchargesSection({
  rows,
  onChanged,
}: {
  rows: { id: number; name: string; unit: PaperUpchargeUnit; upcharge: string; isActive: boolean }[];
  onChanged: () => Promise<unknown>;
}) {
  const create = trpc.printPricing.createPaperUpcharge.useMutation({
    onSuccess: async () => { await onChanged(); notify.ok("أُضيف الورق المميّز"); },
    onError: (e) => notify.err(e),
  });
  const update = trpc.printPricing.updatePaperUpcharge.useMutation({
    onSuccess: async () => { await onChanged(); notify.ok("حُدّث الورق"); },
    onError: (e) => notify.err(e),
  });
  return (
    <ManagedListSection
      title="الورق المميّز (اختياريّ)"
      description="ورقٌ خاصّ (كوشيه/لاصق/شفاف…) بزيادةٍ فوق سعر الوجه القياسيّ — لكل وجه أو ورقة."
      rows={rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, money: r.upcharge, isActive: r.isActive }))}
      moneyLabel="الزيادة"
      unitLabel="الوحدة"
      unitOptions={PAPER_UPCHARGE_UNITS.map((u) => ({ value: u, label: PAPER_UPCHARGE_UNIT_AR[u] }))}
      onCreate={(v) => create.mutate({ name: v.name, unit: v.unit as PaperUpchargeUnit, upcharge: v.money })}
      onUpdate={(v) =>
        update.mutate({ id: v.id, name: v.name, unit: v.unit as PaperUpchargeUnit | undefined, upcharge: v.money, isActive: v.isActive })
      }
      busy={create.isPending || update.isPending}
    />
  );
}

function WideMediaSection({
  rows,
  onChanged,
}: {
  rows: { id: number; name: string; pricePerSqm: string; isActive: boolean }[];
  onChanged: () => Promise<unknown>;
}) {
  const create = trpc.printPricing.createWideMedia.useMutation({
    onSuccess: async () => { await onChanged(); notify.ok("أُضيف الوسيط"); },
    onError: (e) => notify.err(e),
  });
  const update = trpc.printPricing.updateWideMedia.useMutation({
    onSuccess: async () => { await onChanged(); notify.ok("حُدّث الوسيط"); },
    onError: (e) => notify.err(e),
  });
  return (
    <ManagedListSection
      title="الوسائط العريضة (فلكس)"
      description="أنواع الطباعة العريضة (فلكس/استيكر/فينيل…) — سعرٌ لكل متر مربّع."
      rows={rows.map((r) => ({ id: r.id, name: r.name, money: r.pricePerSqm, isActive: r.isActive }))}
      moneyLabel="سعر المتر²"
      onCreate={(v) => create.mutate({ name: v.name, pricePerSqm: v.money })}
      onUpdate={(v) => update.mutate({ id: v.id, name: v.name, pricePerSqm: v.money, isActive: v.isActive })}
      busy={create.isPending || update.isPending}
    />
  );
}

function FinishingSection({
  rows,
  onChanged,
}: {
  rows: { id: number; name: string; unit: FinishingUnit; price: string; isActive: boolean }[];
  onChanged: () => Promise<unknown>;
}) {
  const create = trpc.printPricing.createFinishing.useMutation({
    onSuccess: async () => { await onChanged(); notify.ok("أُضيف خيار التشطيب"); },
    onError: (e) => notify.err(e),
  });
  const update = trpc.printPricing.updateFinishing.useMutation({
    onSuccess: async () => { await onChanged(); notify.ok("حُدّث الخيار"); },
    onError: (e) => notify.err(e),
  });
  return (
    <ManagedListSection
      title="خيارات التشطيب"
      description="تغليف/تجليد/قصّ/طيّ… — سعرٌ لكل نسخة أو لكل شغلة."
      rows={rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, money: r.price, isActive: r.isActive }))}
      moneyLabel="السعر"
      unitLabel="الوحدة"
      unitOptions={FINISHING_UNITS.map((u) => ({ value: u, label: FINISHING_UNIT_AR[u] }))}
      onCreate={(v) => create.mutate({ name: v.name, unit: v.unit as FinishingUnit, price: v.money })}
      onUpdate={(v) =>
        update.mutate({ id: v.id, name: v.name, unit: v.unit as FinishingUnit | undefined, price: v.money, isActive: v.isActive })
      }
      busy={create.isPending || update.isPending}
    />
  );
}
