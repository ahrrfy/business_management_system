/**
 * DeliveryPricingZones — إدارة مناطق التوصيل وقواعد تسعيرها (Slice I، ٢٩/٨/٢٦).
 *
 * الجداول موجودة منذ Slice 7 (هجرة 0279)، والحسابيّة (`computeDeliveryFee`) مبنيّة ومختبَرة.
 * هذه الشاشة تُغلق الفجوة الإدارية: المدير يعرّف المناطق وقواعد التسعير من مكانٍ واحد، ويعاين
 * الأجرة الناتجة مباشرةً قبل اعتماد القاعدة.
 *
 * التقسيم:
 *  - عمودٌ يسار: قائمة المناطق (اختيار/إضافة/تعديل).
 *  - عمودٌ يمين: قواعد المنطقة المُختارة + معاينة حيّة للأجرة.
 */
import { useState } from "react";
import { Banknote, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/form/MoneyInput";
import { AppSelect } from "@/components/ui/AppSelect";
import { EmptyState } from "@/components/EmptyState";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { confirm } from "@/lib/confirm";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const RULE_TYPE_LABEL: Record<string, string> = {
  FLAT_FEE: "ثابت للمنطقة",
  PER_KM: "أساس + كم",
  WEIGHT: "أساس + وزن",
};

export default function DeliveryPricingZones() {
  const utils = trpc.useUtils();
  const zones = trpc.delivery.listZones.useQuery();
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);
  const [zoneForm, setZoneForm] = useState<{
    id: number | null;
    code: string;
    name: string;
    isActive: boolean;
    displayOrder: string;
  }>({ id: null, code: "", name: "", isActive: true, displayOrder: "0" });

  const saveZone = trpc.delivery.saveZone.useMutation({
    onSuccess: (r) => {
      notify.ok(zoneForm.id ? "حُدِّثت المنطقة" : "أُنشئت المنطقة");
      utils.delivery.listZones.invalidate();
      setSelectedZoneId(r.id);
      setZoneForm({ id: null, code: "", name: "", isActive: true, displayOrder: "0" });
    },
    onError: (e) => notify.err(e),
  });
  const deleteZone = trpc.delivery.deleteZone.useMutation({
    onSuccess: () => {
      notify.ok("حُذفت المنطقة");
      utils.delivery.listZones.invalidate();
      if (zoneForm.id != null) setSelectedZoneId(null);
    },
    onError: (e) => notify.err(e),
  });

  const submitZone = () => {
    if (!zoneForm.code.trim() || !zoneForm.name.trim()) {
      notify.err("رمزُ المنطقة واسمُها إلزاميّان");
      return;
    }
    saveZone.mutate({
      id: zoneForm.id,
      code: zoneForm.code.trim(),
      name: zoneForm.name.trim(),
      isActive: zoneForm.isActive,
      displayOrder: Number(zoneForm.displayOrder) || 0,
    });
  };

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="مناطق التسعير للتوصيل"
        description="عرِّف مناطقك بأسعارٍ ثابتةٍ أو بأساسٍ + كم/وزن. المستهلك (كاشير الاستقبال) يستدعي المعاينة عند إدخال المنطقة."
        icon={<Banknote className="size-5" aria-hidden />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(280px,320px)_1fr]">
        {/* ─── قائمة المناطق ─── */}
        <div className="space-y-3">
          <div className="rounded-lg border bg-card">
            <div className="border-b p-3 text-sm font-extrabold">المناطق</div>
            {zones.isLoading ? (
              <div className="p-4 text-center text-xs text-muted-foreground">{L.loading}</div>
            ) : (zones.data ?? []).length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">لا مناطق بعد — أَضف منطقةً أدناه.</div>
            ) : (
              <ul className="max-h-[400px] overflow-y-auto py-1">
                {(zones.data ?? []).map((z) => (
                  <li key={z.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedZoneId(Number(z.id));
                        setZoneForm({
                          id: Number(z.id),
                          code: z.code ?? "",
                          name: z.name ?? "",
                          isActive: !!z.isActive,
                          displayOrder: String(z.displayOrder ?? 0),
                        });
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm transition-colors hover:bg-muted/50",
                        selectedZoneId === Number(z.id) && "bg-primary/10 font-bold text-primary",
                      )}
                    >
                      <span className="truncate">
                        <span className="font-bold">{z.name}</span>
                        <span className="ms-1 text-[10px] text-muted-foreground" dir="ltr">({z.code})</span>
                      </span>
                      {!z.isActive && <Badge variant="outline" className="shrink-0 text-[9px]">معطَّلة</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border p-3">
            <h4 className="mb-3 text-sm font-extrabold">{zoneForm.id ? "تعديل المنطقة" : "منطقة جديدة"}</h4>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="zone-code" className="text-xs">الرمز</Label>
                  <Input id="zone-code" value={zoneForm.code} onChange={(e) => setZoneForm((f) => ({ ...f, code: e.target.value }))} placeholder="baghdad" dir="ltr" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="zone-order" className="text-xs">الترتيب</Label>
                  <Input id="zone-order" type="number" value={zoneForm.displayOrder} onChange={(e) => setZoneForm((f) => ({ ...f, displayOrder: e.target.value }))} dir="ltr" />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="zone-name" className="text-xs">اسم المنطقة</Label>
                <Input id="zone-name" value={zoneForm.name} onChange={(e) => setZoneForm((f) => ({ ...f, name: e.target.value }))} placeholder="بغداد — المركز" />
              </div>
              <label className="flex items-center gap-2 text-xs font-bold">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={zoneForm.isActive}
                  onChange={(e) => setZoneForm((f) => ({ ...f, isActive: e.target.checked }))}
                />
                فعّالة
              </label>
              <div className="flex gap-2">
                <Button onClick={submitZone} disabled={saveZone.isPending} className="flex-1">
                  {saveZone.isPending ? L.saving : zoneForm.id ? "حفظ" : "إضافة"}
                </Button>
                {zoneForm.id && (
                  <>
                    <Button variant="outline" onClick={() => setZoneForm({ id: null, code: "", name: "", isActive: true, displayOrder: "0" })}>
                      إلغاء
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon"
                      title="حذف المنطقة"
                      onClick={async () => {
                        const ok = await confirm({
                          variant: "danger",
                          title: "حذف المنطقة",
                          description: "سيُحذف كذلك جميع قواعد تسعيرها. لا يمكن التراجع.",
                          confirmText: "حذف",
                        });
                        if (!ok) return;
                        deleteZone.mutate({ id: zoneForm.id! });
                      }}
                      disabled={deleteZone.isPending}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ─── قواعد المنطقة المُختارة ─── */}
        <div className="space-y-3">
          {selectedZoneId == null ? (
            <EmptyState
              icon={Banknote}
              title="اختر منطقةً"
              description="اختر منطقةً من العمود اليمنى لعرض قواعد تسعيرها ومعاينة الأجرة."
            />
          ) : (
            <PricingRulesPanel zoneId={selectedZoneId} />
          )}
        </div>
      </div>
    </div>
  );
}

function PricingRulesPanel({ zoneId }: { zoneId: number }) {
  const utils = trpc.useUtils();
  const rules = trpc.delivery.listPricingRules.useQuery({ zoneId });
  const [form, setForm] = useState<{
    id: number | null;
    ruleType: "FLAT_FEE" | "PER_KM" | "WEIGHT";
    baseFee: string;
    perKmFee: string;
    perKgFee: string;
    minFee: string;
    maxFee: string;
    notes: string;
  }>({ id: null, ruleType: "FLAT_FEE", baseFee: "5000", perKmFee: "", perKgFee: "", minFee: "", maxFee: "", notes: "" });
  const [previewKm, setPreviewKm] = useState("5");
  const [previewKg, setPreviewKg] = useState("2");
  const preview = trpc.delivery.previewDeliveryQuote.useQuery(
    { zoneId, distanceKm: Number(previewKm) || 0, weightKg: Number(previewKg) || 0 },
    { enabled: !!(rules.data && rules.data.length > 0) },
  );

  const save = trpc.delivery.savePricingRule.useMutation({
    onSuccess: () => {
      notify.ok(form.id ? "حُدِّثت القاعدة" : "أُنشئت قاعدة التسعير");
      utils.delivery.listPricingRules.invalidate({ zoneId });
      utils.delivery.previewDeliveryQuote.invalidate({ zoneId });
      setForm({ id: null, ruleType: "FLAT_FEE", baseFee: "5000", perKmFee: "", perKgFee: "", minFee: "", maxFee: "", notes: "" });
    },
    onError: (e) => notify.err(e),
  });
  const del = trpc.delivery.deletePricingRule.useMutation({
    onSuccess: () => {
      notify.ok("حُذفت القاعدة");
      utils.delivery.listPricingRules.invalidate({ zoneId });
      utils.delivery.previewDeliveryQuote.invalidate({ zoneId });
    },
    onError: (e) => notify.err(e),
  });

  const rows = rules.data ?? [];
  const needsPerKm = form.ruleType === "PER_KM";
  const needsPerKg = form.ruleType === "WEIGHT";
  const submit = () => {
    if (!Number(form.baseFee)) { notify.err("أدخِل الأجرة الأساس"); return; }
    save.mutate({
      id: form.id,
      zoneId,
      ruleType: form.ruleType,
      baseFee: form.baseFee,
      perKmFee: needsPerKm ? form.perKmFee || null : null,
      perKgFee: needsPerKg ? form.perKgFee || null : null,
      minFee: form.minFee || null,
      maxFee: form.maxFee || null,
      notes: form.notes || null,
      isActive: true,
    });
  };

  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <div className="rounded-lg border">
          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-bold text-muted-foreground">قواعد التسعير ({rows.length})</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">النمط</TableHead>
                <TableHead className="text-left">الأساس</TableHead>
                <TableHead className="text-left">إضافيّ</TableHead>
                <TableHead className="text-left">الحدود</TableHead>
                <TableHead className="text-center">الحالة</TableHead>
                <TableHead className="text-center">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-bold">{RULE_TYPE_LABEL[r.ruleType] ?? r.ruleType}</TableCell>
                  <TableCell className="text-left tabular-nums" dir="ltr">{fmt(r.baseFee)}</TableCell>
                  <TableCell className="text-left text-xs tabular-nums" dir="ltr">
                    {r.perKmFee ? `${fmt(r.perKmFee)}/كم` : r.perKgFee ? `${fmt(r.perKgFee)}/كغم` : "—"}
                  </TableCell>
                  <TableCell className="text-left text-xs tabular-nums" dir="ltr">
                    {r.minFee ? `≥${fmt(r.minFee)}` : ""}{r.minFee && r.maxFee ? " · " : ""}{r.maxFee ? `≤${fmt(r.maxFee)}` : ""}
                    {!r.minFee && !r.maxFee && "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    {r.isActive
                      ? <Badge variant="secondary" className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">فعّالة</Badge>
                      : <Badge variant="outline">معطَّلة</Badge>}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex justify-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => setForm({
                        id: Number(r.id),
                        ruleType: r.ruleType as never,
                        baseFee: String(r.baseFee ?? "0"),
                        perKmFee: String(r.perKmFee ?? ""),
                        perKgFee: String(r.perKgFee ?? ""),
                        minFee: String(r.minFee ?? ""),
                        maxFee: String(r.maxFee ?? ""),
                        notes: r.notes ?? "",
                      })}>تعديل</Button>
                      <Button size="sm" variant="destructive" onClick={() => del.mutate({ id: Number(r.id) })} disabled={del.isPending}>حذف</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length === 0 && !rules.isLoading && (
        <EmptyState icon={Plus} title="لا قواعد بعد" description="أَضف قاعدة تسعيرٍ للمنطقة كي يحسب النظام الأجرة تلقائياً." />
      )}

      {/* نموذج قاعدةٍ جديدة/تعديل */}
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 text-sm font-extrabold">{form.id ? "تعديل القاعدة" : "قاعدة جديدة"}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs font-bold">النمط</Label>
            <AppSelect
              value={form.ruleType}
              onValueChange={(v) => setForm((f) => ({ ...f, ruleType: v as never }))}
              placeholder="اختر النمط"
            >
              <option value="FLAT_FEE">ثابت للمنطقة</option>
              <option value="PER_KM">أساس + كم</option>
              <option value="WEIGHT">أساس + وزن</option>
            </AppSelect>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-bold">الأجرة الأساس (د.ع)</Label>
            <MoneyInput value={form.baseFee} onChange={(v) => setForm((f) => ({ ...f, baseFee: v }))} ariaLabel="الأجرة الأساس" />
          </div>
          {needsPerKm && (
            <div className="space-y-1">
              <Label className="text-xs font-bold">لكل كم (د.ع)</Label>
              <MoneyInput value={form.perKmFee} onChange={(v) => setForm((f) => ({ ...f, perKmFee: v }))} ariaLabel="لكل كم" />
            </div>
          )}
          {needsPerKg && (
            <div className="space-y-1">
              <Label className="text-xs font-bold">لكل كغم (د.ع)</Label>
              <MoneyInput value={form.perKgFee} onChange={(v) => setForm((f) => ({ ...f, perKgFee: v }))} ariaLabel="لكل كغم" />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs font-bold">حدّ أدنى (اختياري)</Label>
            <MoneyInput value={form.minFee} onChange={(v) => setForm((f) => ({ ...f, minFee: v }))} ariaLabel="حدّ أدنى" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-bold">حدّ أعلى (اختياري)</Label>
            <MoneyInput value={form.maxFee} onChange={(v) => setForm((f) => ({ ...f, maxFee: v }))} ariaLabel="حدّ أعلى" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs font-bold">ملاحظات</Label>
            <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="اختياريّ" />
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? L.saving : (form.id ? "حفظ" : "إضافة قاعدة")}</Button>
          {form.id && (
            <Button variant="outline" onClick={() => setForm({ id: null, ruleType: "FLAT_FEE", baseFee: "5000", perKmFee: "", perKgFee: "", minFee: "", maxFee: "", notes: "" })}>
              إلغاء
            </Button>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="rounded-lg border p-4">
          <h4 className="mb-3 text-sm font-extrabold">معاينة الأجرة</h4>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs font-bold">المسافة (كم)</Label>
              <Input type="number" value={previewKm} onChange={(e) => setPreviewKm(e.target.value)} dir="ltr" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-bold">الوزن (كغم)</Label>
              <Input type="number" value={previewKg} onChange={(e) => setPreviewKg(e.target.value)} dir="ltr" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-bold">الأجرة المحسوبة</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-base font-black tabular-nums text-[var(--sem-info)]" dir="ltr">
                {preview.data ? `${fmt(preview.data.fee)} د.ع` : preview.isLoading ? "…" : "—"}
              </div>
            </div>
          </div>
          {preview.data && (
            <p className="mt-2 text-xs text-muted-foreground">
              {preview.data.breakdown.minApplied ? "طُبِّق الحدّ الأدنى." : preview.data.breakdown.maxApplied ? "طُبِّق الحدّ الأعلى." : "احتساب مباشر."}
              {preview.data.breakdown.distanceFee ? ` · إضافة مسافة ${fmt(preview.data.breakdown.distanceFee)}` : ""}
              {preview.data.breakdown.weightFee ? ` · إضافة وزن ${fmt(preview.data.breakdown.weightFee)}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
