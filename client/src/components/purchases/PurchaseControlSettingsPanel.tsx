import { useEffect, useRef, useState } from "react";
import { RotateCcw, Save, Settings2 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

type SettingsDraft = {
  requireRequisition: boolean;
  allowEmergencyOrder: boolean;
  requireEmergencyApproval: boolean;
  priceTolerancePercent: string;
  totalToleranceAmount: string;
  blockUninvoicedReceiptsAtClose: boolean;
};

const EMPTY_DRAFT: SettingsDraft = {
  requireRequisition: false,
  allowEmergencyOrder: true,
  requireEmergencyApproval: true,
  priceTolerancePercent: "0",
  totalToleranceAmount: "0",
  blockUninvoicedReceiptsAtClose: true,
};

function PolicySwitch({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div className="space-y-1">
        <Label htmlFor={id} className="font-semibold">{label}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function PurchaseControlSettingsPanel() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState(0);
  const [draft, setDraft] = useState<SettingsDraft>(EMPTY_DRAFT);
  const hydratedVersion = useRef<string>("");

  useEffect(() => {
    if (branchId > 0 || me.data?.role === "admin") return;
    if (me.data?.branchId != null && Number(me.data.branchId) > 0) {
      setBranchId(Number(me.data.branchId));
    }
  }, [branchId, me.data?.branchId, me.data?.role]);

  const settings = trpc.purchases.controlSettings.useQuery(
    { branchId },
    { enabled: branchId > 0 },
  );

  useEffect(() => {
    if (!settings.data) return;
    const key = `${settings.data.branchId}:${settings.data.version}`;
    if (hydratedVersion.current === key) return;
    hydratedVersion.current = key;
    setDraft({
      requireRequisition: settings.data.requireRequisition,
      allowEmergencyOrder: settings.data.allowEmergencyOrder,
      requireEmergencyApproval: settings.data.requireEmergencyApproval,
      priceTolerancePercent: settings.data.priceTolerancePercent,
      totalToleranceAmount: settings.data.totalToleranceAmount,
      blockUninvoicedReceiptsAtClose: settings.data.blockUninvoicedReceiptsAtClose,
    });
  }, [settings.data]);

  const update = trpc.purchases.updateControlSettings.useMutation({
    onSuccess: async (result) => {
      notify.ok("حُفظت ضوابط المشتريات", `أصبحت نسخة إعدادات الفرع ${result.version}.`);
      hydratedVersion.current = "";
      await utils.purchases.controlSettings.invalidate({ branchId: result.branchId });
    },
    onError: (error) => notify.err(error),
  });

  function save() {
    if (!settings.data || branchId <= 0) return notify.warn("اختر فرعاً وحمّل إعداداته قبل الحفظ.");
    if (!draft.priceTolerancePercent.trim() || !draft.totalToleranceAmount.trim()) {
      return notify.warn("أدخل هامش السعر وسماح فرق الإجمالي.");
    }
    update.mutate({
      branchId,
      expectedVersion: Number(settings.data.version),
      ...draft,
      priceTolerancePercent: draft.priceTolerancePercent.trim(),
      totalToleranceAmount: draft.totalToleranceAmount.trim(),
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="ضوابط دورة المشتريات"
        icon={<Settings2 aria-hidden className="size-5 text-primary" />}
        description="سياسة كل فرع لمسار الطلب، الطوارئ، المطابقة الثلاثية وإقفال الاستلامات غير المفوترة."
        actions={
          <div className="flex flex-wrap gap-2">
            {me.data?.role === "admin" ? (
              <AppSelect
                aria-label="فرع ضوابط المشتريات"
                value={branchId ? String(branchId) : ""}
                onValueChange={(value) => {
                  setBranchId(Number(value));
                  hydratedVersion.current = "";
                }}
              >
                <option value="">اختر فرعاً</option>
                {(branches.data ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </AppSelect>
            ) : null}
            <Button variant="outline" onClick={() => void settings.refetch()} disabled={branchId <= 0 || settings.isFetching}>
              <RotateCcw aria-hidden className="size-4" /> تحديث
            </Button>
            <Button onClick={save} disabled={!settings.data || update.isPending}>
              <Save aria-hidden className="size-4" /> {update.isPending ? ACTION_LABELS.saving : "حفظ الضوابط"}
            </Button>
          </div>
        }
      />

      {branchId <= 0 ? (
        <EmptyState
          title={me.data?.role === "admin" ? "اختر فرعاً لضبط سياسته" : "لا يوجد فرع مُسنَد للمستخدم"}
          description={me.data?.role === "admin" ? "لا توجد سياسة افتراضية عابرة للفروع؛ اختر نطاقاً صريحاً." : "أُوقف تحميل وتعديل الضوابط حتى يُسند المدير فرعاً للمستخدم."}
        />
      ) : null}
      {settings.isLoading ? <LoadingState message={ACTION_LABELS.loading} /> : null}
      {settings.error ? <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} /> : null}

      {settings.data ? (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">طلب الشراء والطوارئ</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <PolicySwitch
                id="purchase-require-requisition"
                label="إلزام طلب شراء داخلي قبل أمر المورد"
                description="يمنع إنشاء أمر شراء مباشر بلا تخصيص من طلب معتمد، إلا عبر مسار الطوارئ الموثق."
                checked={draft.requireRequisition}
                onCheckedChange={(value) => setDraft((current) => ({ ...current, requireRequisition: value }))}
              />
              <PolicySwitch
                id="purchase-allow-emergency"
                label="السماح بأمر شراء طارئ"
                description="يفتح استثناءً مسبباً عند غياب طلب داخلي؛ إيقافه يغلق الاستثناء تماماً."
                checked={draft.allowEmergencyOrder}
                onCheckedChange={(value) => setDraft((current) => ({ ...current, allowEmergencyOrder: value }))}
              />
              <PolicySwitch
                id="purchase-emergency-approval"
                label="إلزام اعتماد مستقل للطوارئ"
                description="لا يتحول وسم الطوارئ إلى تجاوز ذاتي؛ يحتاج مراجعاً مستقلاً قبل الأثر."
                checked={draft.requireEmergencyApproval}
                onCheckedChange={(value) => setDraft((current) => ({ ...current, requireEmergencyApproval: value }))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">حدود المطابقة والإقفال</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="purchase-price-tolerance">هامش فرق السعر (%)</Label>
                  <MoneyInput id="purchase-price-tolerance" value={draft.priceTolerancePercent} decimals={4} onChange={(value) => setDraft((current) => ({ ...current, priceTolerancePercent: value }))} />
                  <p className="text-xs text-muted-foreground">أي فرق أعلى منه يضع فاتورة المورد في HOLD ويمنع الترحيل.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="purchase-total-tolerance">سماح فرق الإجمالي (د.ع)</Label>
                  <MoneyInput id="purchase-total-tolerance" value={draft.totalToleranceAmount} onChange={(value) => setDraft((current) => ({ ...current, totalToleranceAmount: value }))} />
                  <p className="text-xs text-muted-foreground">السماح النقدي المطلق بين فاتورة المورد وصافي أذون الاستلام.</p>
                </div>
              </div>
              <PolicySwitch
                id="purchase-block-uninvoiced-close"
                label="حجب إقفال الشهر عند وجود GRN غير مفوتر"
                description="يبقي GRNI والاستلامات غير المطابقة ظاهرة كمانع إقفال بدلاً من ترحيلها إلى شهر لاحق بصمت."
                checked={draft.blockUninvoicedReceiptsAtClose}
                onCheckedChange={(value) => setDraft((current) => ({ ...current, blockUninvoicedReceiptsAtClose: value }))}
              />
            </CardContent>
          </Card>

          <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
            نسخة الإعدادات: {Number(settings.data.version)} · آخر تعديل: {settings.data.updatedAt ? fmtDateTime(settings.data.updatedAt) : "لم تُحفظ سياسة مخصصة بعد"} · المنفذ: {settings.data.updatedBy ? `مستخدم #${Number(settings.data.updatedBy)}` : "إعداد النظام"}
          </div>
        </>
      ) : null}
    </div>
  );
}
