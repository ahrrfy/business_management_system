import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileCheck2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { PeriodFilter, DEFAULT_PERIOD, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtAr } from "@/lib/money";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";

type Readiness = RouterOutputs["statutoryAccounting"]["readiness"];
type ImportedAccount = RouterInputs["statutoryAccounting"]["replaceAccounts"]["accounts"][number];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودة",
  ACTIVE: "نافذ",
  RETIRED: "متقاعد",
};
const TYPE_LABEL: Record<string, string> = {
  ASSET: "أصول",
  LIABILITY: "التزامات",
  EQUITY: "حقوق ملكية",
  REVENUE: "إيرادات",
  EXPENSE: "مصروفات",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={status === "ACTIVE" ? "default" : "secondary"}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

function ReadinessCard({ readiness }: { readiness: Readiness | undefined }) {
  if (!readiness) return null;
  return (
    <Card className={readiness.ok ? "border-[var(--sem-pos)]/40" : "border-[var(--sem-warn)]/40"}>
      <CardContent className="flex items-start gap-3 py-4">
        {readiness.ok ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-money-positive" aria-hidden />
        ) : (
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-[var(--sem-warn)]" aria-hidden />
        )}
        <div className="space-y-1">
          <p className="font-semibold">
            {readiness.ok ? "الامتثال النظامي جاهز" : "الامتثال النظامي غير مكتمل"}
          </p>
          <p className="text-sm text-muted-foreground">{readiness.detail}</p>
          {readiness.activeProfile && (
            <p className="text-xs text-muted-foreground">
              {readiness.activeProfile.name} — الإصدار {readiness.activeProfile.version} — تغطية {readiness.mappedAccounts}/{readiness.totalInternalAccounts}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SetupTab({ canAdmin }: { canAdmin: boolean }) {
  const utils = trpc.useUtils();
  const profiles = trpc.statutoryAccounting.profiles.useQuery();
  const readiness = trpc.statutoryAccounting.readiness.useQuery();
  const [profileId, setProfileId] = useState<number | null>(null);
  const [profileKey, setProfileKey] = useState("IRAQI_STATUTORY");
  const [version, setVersion] = useState(1);
  const [name, setName] = useState("الدليل المحاسبي النظامي العراقي");
  const [authorityReference, setAuthorityReference] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [importText, setImportText] = useState("");
  const [accountantName, setAccountantName] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const detail = trpc.statutoryAccounting.detail.useQuery(
    { profileId: profileId ?? 0 },
    { enabled: profileId != null },
  );
  const [mappingDraft, setMappingDraft] = useState<Record<number, number | "">>({});

  useEffect(() => {
    if (profileId == null && profiles.data?.length) {
      const preferred = profiles.data.find((item) => item.status === "DRAFT") ?? profiles.data.find((item) => item.status === "ACTIVE") ?? profiles.data[0];
      setProfileId(preferred.id);
    }
  }, [profileId, profiles.data]);

  useEffect(() => {
    if (!detail.data) return;
    setMappingDraft(
      Object.fromEntries(
        detail.data.mappings.map((row) => [
          row.internalAccountId,
          row.statutoryAccountId ?? "",
        ]),
      ),
    );
  }, [detail.data]);

  async function refresh() {
    await Promise.all([
      utils.statutoryAccounting.profiles.invalidate(),
      utils.statutoryAccounting.readiness.invalidate(),
      utils.statutoryAccounting.detail.invalidate(),
    ]);
  }

  const createProfile = trpc.statutoryAccounting.createProfile.useMutation({
    onSuccess: async ({ id }) => {
      setProfileId(id);
      await refresh();
      toast.success("أُنشئت مسودة الإصدار النظامي.");
    },
    onError: (error) => toast.error(error.message),
  });
  const replaceAccounts = trpc.statutoryAccounting.replaceAccounts.useMutation({
    onSuccess: async ({ imported }) => {
      await refresh();
      toast.success(`تم استيراد ${imported} حساباً بصورة ذرية.`);
    },
    onError: (error) => toast.error(error.message),
  });
  const replaceMappings = trpc.statutoryAccounting.replaceMappings.useMutation({
    onSuccess: async ({ mapped }) => {
      await refresh();
      toast.success(`حُفظ ربط ${mapped} حساباً.`);
    },
    onError: (error) => toast.error(error.message),
  });
  const approve = trpc.statutoryAccounting.approveProfile.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("اعتمد الإصدار وأصبح المرجع النظامي النافذ.");
    },
    onError: (error) => toast.error(error.message),
  });

  const current = profiles.data?.find((item) => item.id === profileId);
  const editable = canAdmin && current?.status === "DRAFT";

  function importAccounts() {
    if (!profileId) return;
    try {
      const parsed: unknown = JSON.parse(importText);
      if (!Array.isArray(parsed)) throw new Error("يجب أن يكون الملف مصفوفة JSON.");
      replaceAccounts.mutate({ profileId, accounts: parsed as ImportedAccount[] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "صيغة JSON غير صالحة.");
    }
  }

  function saveMappings() {
    if (!profileId || !detail.data) return;
    replaceMappings.mutate({
      profileId,
      mappings: detail.data.mappings.flatMap((row) => {
        const statutoryAccountId = mappingDraft[row.internalAccountId];
        return statutoryAccountId ? [{ internalAccountId: row.internalAccountId, statutoryAccountId: Number(statutoryAccountId) }] : [];
      }),
    });
  }

  return (
    <div className="space-y-4">
      <ReadinessCard readiness={readiness.data} />

      {canAdmin && (
        <Card>
          <CardHeader><CardTitle className="text-base">إنشاء إصدار جديد</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1"><Label>مفتاح الدليل</Label><Input value={profileKey} onChange={(e) => setProfileKey(e.target.value)} dir="ltr" /></div>
            <div className="space-y-1"><Label>رقم الإصدار</Label><Input type="number" min={1} value={version} onChange={(e) => setVersion(Number(e.target.value))} /></div>
            <div className="space-y-1"><Label>تاريخ النفاذ</Label><Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></div>
            <div className="space-y-1 md:col-span-2"><Label>اسم الدليل</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1"><Label>مرجع الجهة أو التعليمات</Label><Input value={authorityReference} onChange={(e) => setAuthorityReference(e.target.value)} placeholder="رقم الكتاب وتاريخه" /></div>
            <div className="md:col-span-3">
              <Button disabled={createProfile.isPending || !authorityReference.trim()} onClick={() => createProfile.mutate({ profileKey, version, name, authorityReference, effectiveFrom })}>
                إنشاء مسودة
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">الإصدارات</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {profiles.isError && <ErrorState message={profiles.error.message} />}
          <AppSelect value={profileId == null ? "" : String(profileId)} onValueChange={(value) => setProfileId(Number(value))} aria-label="الإصدار النظامي" placeholder="اختر إصداراً">
            {profiles.data?.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.version} — {STATUS_LABEL[item.status]}</option>)}
          </AppSelect>
          {current && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={current.status} />
              <span>النفاذ: {current.effectiveFrom}</span>
              <span className="text-muted-foreground">المرجع: {current.authorityReference}</span>
              {current.contentHash && <code className="text-xs text-muted-foreground" dir="ltr">{current.contentHash.slice(0, 16)}…</code>}
            </div>
          )}
        </CardContent>
      </Card>

      {editable && (
        <Card>
          <CardHeader><CardTitle className="text-base">1. استيراد حسابات الإصدار</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">الاستيراد يستبدل حسابات المسودة وخريطتها معاً، ويفشل كله عند رمز مكرر أو أب غير صالح. لا تعتمد أي رموز نموذجية؛ استعمل حصراً الدليل المصدّق من محاسبك.</p>
            <Textarea className="min-h-44 font-mono text-xs" dir="ltr" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'[{"code":"...","name":"...","type":"ASSET","normalBalance":"DEBIT","parentCode":null,"isPosting":true}]'} />
            <Button variant="outline" disabled={replaceAccounts.isPending || !importText.trim()} onClick={importAccounts}>استيراد واستبدال ذري</Button>
          </CardContent>
        </Card>
      )}

      {detail.data && (
        <Card>
          <CardHeader><CardTitle className="text-base">2. ربط الدليل التشغيلي بالنظامي</CardTitle></CardHeader>
          <CardContent className="space-y-3 p-0 pb-4">
            <div className="px-6 text-sm text-muted-foreground">التغطية الحالية: {detail.data.mappedAccounts}/{detail.data.totalInternalAccounts}. يمنع النظام اختلاف نوع الحساب ويقبل حسابات الترحيل فقط.</div>
            <ScrollTableShell bordered={false}>
              <Table>
                <TableHeader className="bg-muted/50"><TableRow><TableHead>الحساب التشغيلي</TableHead><TableHead>الدور</TableHead><TableHead className="min-w-64">الحساب النظامي</TableHead></TableRow></TableHeader>
                <TableBody>
                  {detail.data.mappings.map((row) => (
                    <TableRow key={row.internalAccountId}>
                      <TableCell><span dir="ltr" className="tabular-nums">{row.internalCode}</span> — {row.internalName}</TableCell>
                      <TableCell><code className="text-xs" dir="ltr">{row.role}</code></TableCell>
                      <TableCell>
                        <AppSelect disabled={!editable} value={String(mappingDraft[row.internalAccountId] ?? "")} onValueChange={(value) => setMappingDraft((old) => ({ ...old, [row.internalAccountId]: Number(value) }))} aria-label={`ربط ${row.internalName}`} placeholder="غير مربوط">
                          <option value="">غير مربوط</option>
                          {detail.data?.accounts.filter((account) => account.isPosting && account.type === row.internalType).map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
                        </AppSelect>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTableShell>
            {editable && <div className="px-6"><Button onClick={saveMappings} disabled={replaceMappings.isPending}>حفظ الخريطة الكاملة</Button></div>}
          </CardContent>
        </Card>
      )}

      {editable && detail.data && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileCheck2 className="size-4" />3. مصادقة الإصدار</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1"><Label>اسم مراقب الحسابات/المحاسب المخوّل</Label><Input value={accountantName} onChange={(e) => setAccountantName(e.target.value)} /></div>
            <div className="space-y-1"><Label>مرجع المصادقة</Label><Input value={approvalReference} onChange={(e) => setApprovalReference(e.target.value)} placeholder="كتاب/محضر/مرفق المصادقة" /></div>
            <div className="md:col-span-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">الاعتماد يقفل هذا الإصدار نهائياً ويجعل أي إصدار نافذ سابق متقاعداً. احتفظ بالمستند الأصلي خارج النظام واربط رقمه هنا.</div>
            <div className="md:col-span-2"><Button disabled={approve.isPending || !accountantName.trim() || !approvalReference.trim() || detail.data.unmappedAccounts.length > 0 || detail.data.unresolvedJournalRoles.length > 0} onClick={() => approve.mutate({ profileId: profileId!, accountantName, approvalReference })}>اعتماد وتفعيل الإصدار</Button></div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TrialBalanceTab() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const query = trpc.statutoryAccounting.trialBalance.useQuery({ from: period.from, to: period.to }, { enabled: period.from <= period.to });
  const report = query.data;
  return (
    <div className="space-y-4">
      <PeriodFilter value={period} onChange={setPeriod} />
      {query.isError && <ErrorState message={query.error.message} />}
      {report && !report.available && <ErrorState message={report.reason} />}
      {report?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">إجمالي المدين</p><p className="font-semibold tabular-nums">{fmtAr(report.totals.debit)} د.ع</p></CardContent></Card>
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">إجمالي الدائن</p><p className="font-semibold tabular-nums">{fmtAr(report.totals.credit)} د.ع</p></CardContent></Card>
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">فرق الميزان</p><p className="font-semibold tabular-nums">{fmtAr(report.totals.difference)} د.ع</p></CardContent></Card>
          </div>
          <Card><CardHeader><CardTitle className="text-base">ميزان الإصدار {report.profile.version} — {report.profile.name}</CardTitle></CardHeader><CardContent className="p-0"><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>الرمز</TableHead><TableHead>الحساب</TableHead><TableHead>النوع</TableHead><TableHead>مدين</TableHead><TableHead>دائن</TableHead><TableHead>رصيد مدين</TableHead><TableHead>رصيد دائن</TableHead></TableRow></TableHeader><TableBody>{report.rows.map((row) => <TableRow key={row.accountId}><TableCell className="tabular-nums" dir="ltr">{row.code}</TableCell><TableCell>{row.name}</TableCell><TableCell>{TYPE_LABEL[row.type] ?? row.type}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.credit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debitBalance)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.creditBalance)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell></CardContent></Card>
        </>
      )}
    </div>
  );
}

function GeneralJournalTab() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [period.from, period.to]);
  const query = trpc.statutoryAccounting.generalJournal.useQuery({ from: period.from, to: period.to, limit: 100, offset }, { enabled: period.from <= period.to });
  const report = query.data;
  return (
    <div className="space-y-4">
      <PeriodFilter value={period} onChange={setPeriod} />
      {query.isError && <ErrorState message={query.error.message} />}
      {report && !report.available && <ErrorState message={report.reason} />}
      {report?.available && <Card><CardHeader><CardTitle className="text-base">اليومية النظامية المثبتة</CardTitle></CardHeader><CardContent className="space-y-3 p-0 pb-4"><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>التاريخ/القيد</TableHead><TableHead>المصدر</TableHead><TableHead>الحساب التشغيلي</TableHead><TableHead>الحساب النظامي</TableHead><TableHead>مدين</TableHead><TableHead>دائن</TableHead></TableRow></TableHeader><TableBody>{report.rows.map((row, index) => <TableRow key={`${row.journalId}-${index}`}><TableCell><span>{row.entryDate}</span><br /><span className="text-xs text-muted-foreground">#{row.journalId}</span></TableCell><TableCell><span dir="ltr">{row.sourceType}</span><br /><span className="text-xs text-muted-foreground" dir="ltr">{row.sourceKey ?? row.sourceId ?? "—"}</span></TableCell><TableCell><span dir="ltr">{row.internalCode}</span><br /><code className="text-xs" dir="ltr">{row.role}</code></TableCell><TableCell><span dir="ltr">{row.statutoryCode}</span> — {row.statutoryName}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.credit)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell><div className="flex items-center justify-between px-6"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>السابق</Button><span className="text-xs text-muted-foreground">السجلات {offset + 1}–{offset + report.rows.length}</span><Button variant="outline" disabled={!report.pagination.hasMore} onClick={() => setOffset(offset + 100)}>التالي</Button></div></CardContent></Card>}
    </div>
  );
}

export default function StatutoryAccounting() {
  const me = trpc.auth.me.useQuery();
  const canAdmin = me.data?.role === "admin";
  return (
    <div className="space-y-4">
      <PageHeader title="الدليل المحاسبي النظامي" description="طبقة امتثال مستقلة فوق الدليل التشغيلي: إصدار مصادق، خريطة ثابتة، وتقارير تستند إلى التصنيف المحفوظ وقت القيد." />
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /><p>النظام لا يفترض أن نموذجاً عاماً يطابق نشاطك أو تعليماتك. لا يصبح الدليل نافذاً إلا بعد اكتمال الربط وتسجيل اسم المحاسب ومرجع المصادقة.</p></div>
      <Tabs defaultValue="setup">
        <TabsList className="flex h-auto flex-wrap justify-start"><TabsTrigger value="setup">الإصدار والربط</TabsTrigger><TabsTrigger value="trial">ميزان المراجعة النظامي</TabsTrigger><TabsTrigger value="journal">اليومية النظامية</TabsTrigger></TabsList>
        <TabsContent value="setup"><SetupTab canAdmin={canAdmin} /></TabsContent>
        <TabsContent value="trial"><TrialBalanceTab /></TabsContent>
        <TabsContent value="journal"><GeneralJournalTab /></TabsContent>
      </Tabs>
    </div>
  );
}
