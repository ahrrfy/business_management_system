/* ============================================================================
 * المكوّنات القانونية العراقية للرواتب — البند ④ (client/src/pages/PayrollLegalSettings.tsx)
 * قسم إعدادات محصور بالمدير/الأدمن: ضمان اجتماعي + ضريبة دخل مستقطعة + مكافأة نهاية خدمة.
 * كل مكوّن بمفتاح تفعيل مستقلّ **معطَّل افتراضياً** — لا يؤثّر على الرواتب حتى يُفعِّله المالك.
 * ⚠️ النِّسب/الشرائح يضبطها المالك مع محاسبه القانونيّ (لافتة تحذير ظاهرة). مُركَّب على trpc.payroll.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/form/MoneyInput";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Coins, Plus, Receipt, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type BracketRow = { upTo: string; rate: string };

export default function PayrollLegalSettings() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const canEdit = role === "admin" || role === "manager";

  const settingsQ = trpc.payroll.legalSettings.useQuery();

  // ── حالة محلّية (تُهيَّأ من الخادم) ──────────────────────────────────────────────
  const [ssEnabled, setSsEnabled] = useState(false);
  const [ssEmployeeRate, setSsEmployeeRate] = useState("0");
  const [ssEmployerRate, setSsEmployerRate] = useState("0");
  const [ssBase, setSsBase] = useState<"basic" | "gross">("basic");

  const [taxEnabled, setTaxEnabled] = useState(false);
  const [exemption, setExemption] = useState("0");
  const [brackets, setBrackets] = useState<BracketRow[]>([]);

  const [eosEnabled, setEosEnabled] = useState(false);
  const [eosDays, setEosDays] = useState("0");

  useEffect(() => {
    const d = settingsQ.data;
    if (!d) return;
    setSsEnabled(d.socialSecurityEnabled);
    setSsEmployeeRate(d.socialSecurityEmployeeRate);
    setSsEmployerRate(d.socialSecurityEmployerRate);
    setSsBase(d.socialSecurityBase);
    setTaxEnabled(d.incomeTaxEnabled);
    setExemption(d.incomeTaxExemption);
    setBrackets(d.incomeTaxBrackets.map((b) => ({ upTo: b.upTo ?? "", rate: b.rate })));
    setEosEnabled(d.endOfServiceEnabled);
    setEosDays(d.endOfServiceDaysPerYear);
  }, [settingsQ.data]);

  const updateM = trpc.payroll.updateLegalSettings.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظت إعدادات المكوّنات القانونية");
      await utils.payroll.legalSettings.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function addBracket() {
    setBrackets((b) => [...b, { upTo: "", rate: "0" }]);
  }
  function removeBracket(i: number) {
    setBrackets((b) => b.filter((_, idx) => idx !== i));
  }
  function setBracket(i: number, patch: Partial<BracketRow>) {
    setBrackets((b) => b.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function save() {
    updateM.mutate({
      socialSecurityEnabled: ssEnabled,
      socialSecurityEmployeeRate: ssEmployeeRate.trim() || "0",
      socialSecurityEmployerRate: ssEmployerRate.trim() || "0",
      socialSecurityBase: ssBase,
      incomeTaxEnabled: taxEnabled,
      incomeTaxBrackets: brackets
        .filter((b) => b.upTo.trim() !== "" || b.rate.trim() !== "")
        .map((b) => ({ upTo: b.upTo.trim() === "" ? null : b.upTo.trim(), rate: b.rate.trim() || "0" })),
      incomeTaxExemption: exemption.trim() || "0",
      endOfServiceEnabled: eosEnabled,
      endOfServiceDaysPerYear: eosDays.trim() || "0",
    });
  }

  if (settingsQ.isLoading) return <LoadingState />;
  if (settingsQ.isError) return <ErrorState message="تعذّر تحميل الإعدادات." onRetry={() => settingsQ.refetch()} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="المكوّنات القانونية للرواتب"
        description="ضمان اجتماعي + ضريبة دخل مستقطعة + مكافأة نهاية خدمة — كلٌّ بمفتاح تفعيل مستقلّ، معطَّل افتراضياً."
        actions={
          canEdit ? (
            <Button onClick={save} disabled={updateM.isPending}>
              <Save className="size-4" aria-hidden /> {updateM.isPending ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
            </Button>
          ) : undefined
        }
      />

      {/* لافتة تحذير المحاسب القانونيّ */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <b>راجع النِّسب والشرائح مع محاسبك القانونيّ.</b> القيم هنا إعداداتٌ يضبطها المالك وفق القانون
          العراقيّ النافذ — النظام يوفّر البنية فقط ولا يفرض أرقاماً معتمَدة. ما لم تُفعَّل مكوّناتٌ، تبقى
          الرواتب تُحسب كما هي تماماً بلا أيّ خصم إضافيّ.
        </div>
      </div>

      {!canEdit && (
        <p className="text-xs text-muted-foreground">هذه الإعدادات للمدير/الأدمن فقط — لديك صلاحية عرض فقط.</p>
      )}

      {/* ① الضمان الاجتماعي */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" aria-hidden /> الضمان الاجتماعي
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="ss-enabled" className="text-sm">تفعيل خصم الضمان الاجتماعي</Label>
            <Switch id="ss-enabled" checked={ssEnabled} disabled={!canEdit} onCheckedChange={setSsEnabled} aria-label="تفعيل الضمان الاجتماعي" />
          </div>
          {ssEnabled && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ss-emp" className="text-sm">نسبة حصّة الموظف (٪)</Label>
                <Input id="ss-emp" dir="ltr" inputMode="decimal" className="tabular-nums" value={ssEmployeeRate} disabled={!canEdit} onChange={(e) => setSsEmployeeRate(e.target.value)} placeholder="5" />
                <p className="text-[11px] text-muted-foreground">تُخصَم من أجر الموظف (توضيحيّ ~٥٪).</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ss-er" className="text-sm">نسبة حصّة رب العمل (٪)</Label>
                <Input id="ss-er" dir="ltr" inputMode="decimal" className="tabular-nums" value={ssEmployerRate} disabled={!canEdit} onChange={(e) => setSsEmployerRate(e.target.value)} placeholder="12" />
                <p className="text-[11px] text-muted-foreground">كلفة على الشركة، لا تُخصَم من الموظف (توضيحيّ ~١٢٪).</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ss-base" className="text-sm">وعاء الاحتساب</Label>
                <select id="ss-base" className={selectCls} value={ssBase} disabled={!canEdit} onChange={(e) => setSsBase(e.target.value as "basic" | "gross")}>
                  <option value="basic">الأساسيّ (الراتب الأساس)</option>
                  <option value="gross">الإجماليّ (أساسيّ + مخصّصات)</option>
                </select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ② ضريبة الدخل المستقطعة */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="size-4 text-primary" aria-hidden /> ضريبة الدخل المستقطعة
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="tax-enabled" className="text-sm">تفعيل استقطاع ضريبة الدخل</Label>
            <Switch id="tax-enabled" checked={taxEnabled} disabled={!canEdit} onCheckedChange={setTaxEnabled} aria-label="تفعيل ضريبة الدخل" />
          </div>
          {taxEnabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="tax-exempt" className="text-sm">الإعفاء الشخصيّ/العائليّ (شهريّ، د.ع)</Label>
                  <MoneyInput id="tax-exempt" value={exemption} disabled={!canEdit} onChange={setExemption} />
                  <p className="text-[11px] text-muted-foreground">يُطرح من الوعاء قبل الشرائح. الوعاء = الإجماليّ − حصّة الموظف من الضمان − الإعفاء.</p>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">الشرائح التصاعدية (حدّ + نسبة)</Label>
                  {canEdit && (
                    <Button type="button" variant="outline" size="sm" onClick={addBracket}>
                      <Plus className="size-3.5" aria-hidden /> شريحة
                    </Button>
                  )}
                </div>
                {brackets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">لا شرائح مضبوطة — أضِف شريحةً واحدة على الأقل.</p>
                ) : (
                  <div className="space-y-2">
                    {brackets.map((b, i) => (
                      <div key={i} className="flex items-end gap-2">
                        <div className="flex-1 space-y-1">
                          <Label htmlFor={`br-up-${i}`} className="text-[11px] text-muted-foreground">حتى مبلغ (د.ع) — اتركه فارغاً للشريحة العليا «فما فوق»</Label>
                          <MoneyInput id={`br-up-${i}`} value={b.upTo} disabled={!canEdit} onChange={(v) => setBracket(i, { upTo: v })} />
                        </div>
                        <div className="w-24 space-y-1">
                          <Label htmlFor={`br-rate-${i}`} className="text-[11px] text-muted-foreground">النسبة (٪)</Label>
                          <Input id={`br-rate-${i}`} dir="ltr" inputMode="decimal" className="tabular-nums" value={b.rate} disabled={!canEdit} onChange={(e) => setBracket(i, { rate: e.target.value })} />
                        </div>
                        {canEdit && (
                          <Button type="button" variant="ghost" size="icon" onClick={() => removeBracket(i)} aria-label="حذف الشريحة">
                            <Trash2 className="size-4 text-destructive" aria-hidden />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  الاحتساب تصاعديّ حدّيّ: كل جزء من الوعاء ضمن حدّ شريحته يُضرَب بنسبتها. مثال توضيحيّ:
                  حتى ٢٥٠٬٠٠٠ = ٣٪، ثم حتى ٥٠٠٬٠٠٠ = ٥٪، ثم «فما فوق» = ١٥٪.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ③ مكافأة نهاية الخدمة */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="size-4 text-primary" aria-hidden /> مكافأة نهاية الخدمة (استحقاق متراكم)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="eos-enabled" className="text-sm">تفعيل احتساب استحقاق نهاية الخدمة</Label>
            <Switch id="eos-enabled" checked={eosEnabled} disabled={!canEdit} onCheckedChange={setEosEnabled} aria-label="تفعيل مكافأة نهاية الخدمة" />
          </div>
          {eosEnabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="eos-days" className="text-sm">أيام آخر راتب لكل سنة خدمة</Label>
                <Input id="eos-days" dir="ltr" inputMode="decimal" className="tabular-nums" value={eosDays} disabled={!canEdit} onChange={(e) => setEosDays(e.target.value)} placeholder="21" />
                <p className="text-[11px] text-muted-foreground">
                  المعدّل اليوميّ = الأساسيّ ÷ ٣٠. الاستحقاق الشهريّ المتراكم = (المعدّل اليوميّ × الأيام) ÷ ١٢.
                </p>
              </div>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            هذا استحقاقٌ يُعرَض ويُتراكم (التزام على الشركة) — <b>لا يُخصَم من الموظف ولا يُصرَف هنا</b>؛
            الصرف الفعليّ عند الفصل عبر تسوية نهاية الخدمة القائمة (بلا ازدواج).
          </p>
        </CardContent>
      </Card>

      {settingsQ.data?.updatedAt && (
        <p className="text-[11px] text-muted-foreground">
          آخر تحديث: {new Date(settingsQ.data.updatedAt).toLocaleString("ar-IQ")}
        </p>
      )}
    </div>
  );
}
