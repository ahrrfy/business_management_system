import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Search,
  ShieldCheck,
  Upload,
} from "lucide-react";
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
import { AppSelect } from "@/components/ui/AppSelect";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { confirm } from "@/lib/confirm";
import { exportRows, exportSheets, type SheetSpec } from "@/lib/export";
import { fmtAr } from "@/lib/money";
import {
  buildBalanceStatementRows,
  buildStatutoryHashMaterial,
  buildIncomeStatementRows,
  requireCompleteStatutoryExport,
} from "@/lib/statutoryAccountingExport";
import {
  parseStatutoryAccountsFile,
  STATUTORY_ACCOUNT_FIELDS,
  suggestStatutoryMappings,
  type StatutoryAccountImportRow,
} from "@/lib/statutoryAccountingImport";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type Readiness = RouterOutputs["statutoryAccounting"]["readiness"];
type AccountLedgerRows = Extract<
  RouterOutputs["statutoryAccounting"]["accountLedger"],
  { available: true }
>["rows"];

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
const UNMAPPED_VALUE = "__UNMAPPED__";

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
  const [importRows, setImportRows] = useState<StatutoryAccountImportRow[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [parsingImport, setParsingImport] = useState(false);
  const [accountantName, setAccountantName] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const [mappingSearch, setMappingSearch] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
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
      setImportRows([]);
      setImportFileName("");
      setImportError(null);
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
  const filteredMappings = useMemo(() => {
    const needle = mappingSearch.trim().toLowerCase();
    return (detail.data?.mappings ?? []).filter((row) => {
      const selected = mappingDraft[row.internalAccountId];
      if (onlyUnmapped && selected) return false;
      if (!needle) return true;
      return `${row.internalCode} ${row.internalName} ${row.role}`.toLowerCase().includes(needle);
    });
  }, [detail.data?.mappings, mappingDraft, mappingSearch, onlyUnmapped]);

  async function selectImportFile(file?: File) {
    if (!file) return;
    setParsingImport(true);
    setImportError(null);
    try {
      const parsed = await parseStatutoryAccountsFile(file);
      setImportRows(parsed);
      setImportFileName(file.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذّرت قراءة الملف.";
      setImportRows([]);
      setImportFileName(file.name);
      setImportError(message);
      toast.error(message);
    } finally {
      setParsingImport(false);
    }
  }

  function downloadTemplate() {
    exportRows<StatutoryAccountImportRow>([], {
      filename: "قالب-الدليل-المحاسبي-النظامي",
      title: "قالب استيراد الدليل المحاسبي النظامي — لا تعتمد الحسابات قبل مصادقة المحاسب",
      columns: STATUTORY_ACCOUNT_FIELDS.map((field) => ({
        key: field.key,
        header: field.label,
        text: field.key === "code" || field.key === "parentCode",
      })),
    });
  }

  function applySuggestions() {
    if (!detail.data) return;
    const suggested = suggestStatutoryMappings(detail.data.mappings, detail.data.accounts);
    const count = Object.keys(suggested).length;
    setMappingDraft((old) => ({ ...old, ...suggested }));
    if (count) toast.success(`اقتُرح ${count} ربطاً للمراجعة؛ لم يُحفظ شيء بعد.`);
    else toast.info("لا توجد مطابقات فريدة آمنة للاقتراح.");
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

  async function confirmAccountReplacement() {
    if (!profileId || importRows.length === 0) return;
    const accepted = await confirm({
      variant: "warning",
      title: "استبدال حسابات الإصدار؟",
      description: `سيستبدل الملف «${importFileName}» حسابات المسودة بـ${importRows.length} حساباً ويمسح خريطة الربط الحالية. لا يمكن التراجع إلا بإعادة الاستيراد والربط.`,
      confirmText: "استبدال الحسابات",
    });
    if (accepted) replaceAccounts.mutate({ profileId, accounts: importRows });
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
          <AppSelect value={profileId == null ? "__NO_PROFILE__" : String(profileId)} onValueChange={(value) => value !== "__NO_PROFILE__" && setProfileId(Number(value))} aria-label="الإصدار النظامي">
            <option value="__NO_PROFILE__" disabled>اختر إصداراً</option>
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
            <p className="text-base text-muted-foreground">اقرأ XLSX أو CSV أو JSON. تُفحص الأعمدة والأنواع وشجرة الحسابات محلياً، ثم يستبدل الخادم حسابات المسودة وخريطتها بصورة ذرية. استعمل حصراً الدليل الذي صادق عليه محاسبك.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={downloadTemplate}>
                <Download className="size-4" aria-hidden />تنزيل القالب
              </Button>
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium shadow-xs hover:bg-accent focus-within:ring-[3px] focus-within:ring-ring/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                <Upload className="size-4" aria-hidden />
                {parsingImport ? "جارٍ الفحص…" : "اختيار ملف"}
                <input
                  className="sr-only"
                  type="file"
                  accept=".xlsx,.csv,.json"
                  disabled={parsingImport || replaceAccounts.isPending}
                  onChange={(event) => void selectImportFile(event.target.files?.[0])}
                />
              </label>
            </div>
            {importFileName && (
              <div className={`rounded-md border p-3 text-sm ${importError ? "border-destructive/40 text-destructive" : "border-[var(--sem-pos)]/40"}`}>
                <p className="font-medium">{importFileName}</p>
                <p className="text-muted-foreground">{importError ?? `${importRows.length} حساب صالح وجاهز للاستبدال.`}</p>
              </div>
            )}
            {importRows.length > 0 && (
              <ScrollTableShell>
                <Table>
                  <TableHeader className="bg-muted/50"><TableRow><TableHead>الرمز</TableHead><TableHead>الحساب</TableHead><TableHead>النوع</TableHead><TableHead>الطبيعة</TableHead><TableHead>الأب</TableHead></TableRow></TableHeader>
                  <TableBody>{importRows.slice(0, 8).map((row) => <TableRow key={row.code}><TableCell dir="ltr">{row.code}</TableCell><TableCell>{row.name}</TableCell><TableCell>{TYPE_LABEL[row.type]}</TableCell><TableCell>{row.normalBalance === "DEBIT" ? "مدين" : "دائن"}</TableCell><TableCell dir="ltr">{row.parentCode ?? "—"}</TableCell></TableRow>)}</TableBody>
                </Table>
              </ScrollTableShell>
            )}
            <Button disabled={replaceAccounts.isPending || importRows.length === 0} onClick={() => void confirmAccountReplacement()}>تأكيد الاستبدال الذري</Button>
          </CardContent>
        </Card>
      )}

      {detail.data && (
        <Card>
          <CardHeader><CardTitle className="text-base">2. ربط الدليل التشغيلي بالنظامي</CardTitle></CardHeader>
          <CardContent className="space-y-3 p-0 pb-4">
            <div className="px-6 text-sm text-muted-foreground">التغطية الحالية: {detail.data.mappedAccounts}/{detail.data.totalInternalAccounts}. يمنع النظام اختلاف نوع الحساب ويقبل حسابات الترحيل فقط.</div>
            <div className="flex flex-wrap items-center gap-2 px-6">
              <div className="relative min-w-64 flex-1">
                <Label className="sr-only" htmlFor="statutory-mapping-search">بحث في ربط الحسابات</Label>
                <Search className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input id="statutory-mapping-search" className="pr-9" value={mappingSearch} onChange={(event) => setMappingSearch(event.target.value)} placeholder="بحث بالرمز أو الاسم أو الدور" />
              </div>
              <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input type="checkbox" checked={onlyUnmapped} onChange={(event) => setOnlyUnmapped(event.target.checked)} />غير المربوط فقط
              </label>
              {editable && <Button type="button" variant="outline" onClick={applySuggestions}>اقتراح المطابقات الآمنة</Button>}
            </div>
            <ScrollTableShell bordered={false}>
              <Table>
                <TableHeader className="bg-muted/50"><TableRow><TableHead>الحساب التشغيلي</TableHead><TableHead>الدور</TableHead><TableHead className="min-w-64">الحساب النظامي</TableHead></TableRow></TableHeader>
                <TableBody>
                  {filteredMappings.map((row) => (
                    <TableRow key={row.internalAccountId}>
                      <TableCell><span dir="ltr" className="tabular-nums">{row.internalCode}</span> — {row.internalName}</TableCell>
                      <TableCell><code className="text-xs" dir="ltr">{row.role}</code></TableCell>
                      <TableCell>
                        <AppSelect disabled={!editable} value={mappingDraft[row.internalAccountId] ? String(mappingDraft[row.internalAccountId]) : UNMAPPED_VALUE} onValueChange={(value) => setMappingDraft((old) => ({ ...old, [row.internalAccountId]: value === UNMAPPED_VALUE ? "" : Number(value) }))} aria-label={`ربط ${row.internalName}`}>
                          <option value={UNMAPPED_VALUE}>غير مربوط</option>
                          {detail.data?.accounts.filter((account) => account.isPosting && account.type === row.internalType).map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
                        </AppSelect>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTableShell>
            {editable && <div className="flex flex-wrap items-center gap-3 px-6"><Button onClick={saveMappings} disabled={replaceMappings.isPending}>حفظ الخريطة الكاملة</Button><span className="text-xs text-muted-foreground">الاقتراحات لا تصبح نافذة إلا بعد الحفظ ثم مصادقة المحاسب.</span></div>}
          </CardContent>
        </Card>
      )}

      {editable && detail.data && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileCheck2 className="size-4" />3. مصادقة الإصدار</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1"><Label>اسم مراقب الحسابات/المحاسب المخوّل</Label><Input value={accountantName} onChange={(e) => setAccountantName(e.target.value)} /></div>
            <div className="space-y-1"><Label>مرجع المصادقة</Label><Input value={approvalReference} onChange={(e) => setApprovalReference(e.target.value)} placeholder="كتاب/محضر/مرفق المصادقة" /></div>
            <div className="md:col-span-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-base text-[var(--sem-warn)]">الاعتماد يقفل هذا الإصدار نهائياً ويجعل أي إصدار نافذ سابق متقاعداً. المتبقي قبل الاعتماد: {detail.data.unmappedAccounts.length} حساب و{detail.data.unresolvedJournalRoles.length} دور يومية. احتفظ بالمستند الأصلي خارج النظام واربط رقمه هنا.</div>
            <div className="md:col-span-2"><Button disabled={approve.isPending || !accountantName.trim() || !approvalReference.trim() || detail.data.unmappedAccounts.length > 0 || detail.data.unresolvedJournalRoles.length > 0} onClick={() => approve.mutate({ profileId: profileId!, accountantName, approvalReference })}>اعتماد وتفعيل الإصدار</Button></div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FinancialStatementsTab() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const utils = trpc.useUtils();
  const enabled = period.from <= period.to;
  const trialQuery = trpc.statutoryAccounting.trialBalance.useQuery({ from: period.from, to: period.to, profileScope: "ALL_APPROVED" }, { enabled });
  const incomeQuery = trpc.statutoryAccounting.incomeStatement.useQuery({ from: period.from, to: period.to, profileScope: "ALL_APPROVED" }, { enabled });
  const balanceQuery = trpc.statutoryAccounting.balanceSheet.useQuery({ asOf: period.to, profileScope: "ALL_APPROVED" }, { enabled });
  const trial = trialQuery.data;
  const income = incomeQuery.data;
  const balance = balanceQuery.data;
  const visibleBalanceRows = balance?.available ? buildBalanceStatementRows(balance) : [];
  const visibleIncomeRows = income?.available ? buildIncomeStatementRows(income) : [];

  function exportAccountantPack() {
    exportSheets(`حزمة-مراقب-الحسابات-${period.from}-${period.to}`, async () => {
      const pack = await utils.statutoryAccounting.accountantPack.fetch(period);
      if (!pack.available) throw new Error(pack.reason);
      const freshTrial = pack.trialBalance;
      const freshIncome = pack.incomeStatement;
      const freshBalance = pack.balanceSheet;
      const details = pack.profileDetails;
      const includedProfiles = details.map((detail) => detail.profile);
      const journal = requireCompleteStatutoryExport(pack.generalJournal, "اليومية النظامية");
      const meta = [
        { label: "الفترة", value: `${period.from} — ${period.to}` },
        { label: "لقطة الاستخراج", value: pack.generatedAt },
        { label: "دورة الدفتر", value: pack.cycleId },
        { label: "مرجع الترحيل النافذ", value: `${freshTrial.profile.name} / ${freshTrial.profile.version}` },
        { label: "نطاق التقرير", value: "كل لقطات الإصدارات المعتمدة المثبتة على القيود" },
        { label: "الإصدارات المشمولة", value: includedProfiles.map((profile) => `${profile.profileKey}/${profile.version} (#${profile.id}): ${profile.contentHash ?? "—"}`).join(" | ") },
        {
          label: "صيغة البصمة",
          value: "لكل معرّف دليل: UTF-8 ثم SHA-256 للنص {\"accounts\":[ACCOUNT.canonicalJson مرتبة بالتسلسل],\"mappings\":[MAPPING.canonicalJson مرتبة بالتسلسل]} في ورقة مواد البصمة؛ القيم داخل JSON تحفظ null وtrue/false حرفياً.",
        },
      ];
      const moneyColumn = (key: string, header: string) => ({ key, header, money: true, map: (row: Record<string, unknown>) => Number(row[key] ?? 0) });
      const balanceRows = buildBalanceStatementRows(freshBalance);
      const incomeRows = buildIncomeStatementRows(freshIncome);
      return [
        {
          sheetName: "اعتماد الإصدار",
          title: "بيانات اعتماد الإصدار النظامي",
          meta,
          rows: details.flatMap((detail) => [
            { profileId: detail.profile.id, profileKey: detail.profile.profileKey, version: detail.profile.version, field: "اسم الدليل", value: detail.profile.name },
            { profileId: detail.profile.id, profileKey: detail.profile.profileKey, version: detail.profile.version, field: "مرجع الجهة", value: detail.profile.authorityReference },
            { profileId: detail.profile.id, profileKey: detail.profile.profileKey, version: detail.profile.version, field: "تاريخ النفاذ", value: detail.profile.effectiveFrom },
            { profileId: detail.profile.id, profileKey: detail.profile.profileKey, version: detail.profile.version, field: "مراقب الحسابات", value: detail.profile.accountantName ?? "—" },
            { profileId: detail.profile.id, profileKey: detail.profile.profileKey, version: detail.profile.version, field: "مرجع المصادقة", value: detail.profile.approvalReference ?? "—" },
            { profileId: detail.profile.id, profileKey: detail.profile.profileKey, version: detail.profile.version, field: "بصمة SHA-256", value: detail.profile.contentHash ?? "—" },
          ]),
          columns: [{ key: "profileId", header: "معرّف الدليل" }, { key: "profileKey", header: "مفتاح الدليل", text: true }, { key: "version", header: "الإصدار" }, { key: "field", header: "البيان" }, { key: "value", header: "القيمة" }],
        },
        {
          sheetName: "مواد البصمة",
          title: "الحمولة القانونية القابلة لإعادة حساب بصمة SHA-256",
          meta,
          rows: buildStatutoryHashMaterial(details),
          columns: [
            { key: "profileId", header: "معرّف الدليل" },
            { key: "profileKey", header: "مفتاح الدليل", text: true },
            { key: "profileVersion", header: "الإصدار" },
            { key: "expectedHash", header: "البصمة المتوقعة", text: true },
            { key: "section", header: "القسم", text: true },
            { key: "sequence", header: "التسلسل" },
            { key: "canonicalJson", header: "JSON القانوني", text: true },
          ],
        },
        {
          sheetName: "الدليل النظامي",
          title: "كامل شجرة الدليل النظامي المثبتة في بصمة الاعتماد",
          meta,
          rows: details.flatMap((detail) => detail.approvedAccounts.map((account) => ({
            ...account,
            profileId: detail.profile.id,
            profileKey: detail.profile.profileKey,
            profileVersion: detail.profile.version,
          }))),
          columns: [
            { key: "profileId", header: "معرّف الدليل" },
            { key: "profileKey", header: "مفتاح الدليل", text: true },
            { key: "profileVersion", header: "الإصدار" },
            { key: "statutoryAccountId", header: "معرّف الحساب في البصمة" },
            { key: "code", header: "الرمز", text: true },
            { key: "name", header: "اسم الحساب" },
            { key: "type", header: "النوع" },
            { key: "normalBalance", header: "طبيعة الرصيد" },
            { key: "parentId", header: "معرّف الأب في البصمة" },
            { key: "parentCode", header: "رمز الأب", text: true },
            { key: "isPosting", header: "يقبل الترحيل (true/false)" },
            { key: "sortOrder", header: "الترتيب" },
          ],
        },
        {
          sheetName: "خريطة الحسابات",
          title: "خريطة الدليل التشغيلي إلى النظامي — متحققة من بصمة الاعتماد",
          meta,
          rows: details.flatMap((detail) => detail.approvedMappings.map((mapping) => ({
            ...mapping,
            profileId: detail.profile.id,
            profileKey: detail.profile.profileKey,
            profileVersion: detail.profile.version,
          }))),
          columns: [
            { key: "profileId", header: "معرّف الدليل" },
            { key: "profileKey", header: "مفتاح الدليل", text: true },
            { key: "profileVersion", header: "الإصدار" },
            { key: "internalCode", header: "الرمز التشغيلي" },
            { key: "role", header: "دور النظام" },
            { key: "statutoryCode", header: "الرمز النظامي" },
            { key: "statutoryName", header: "الحساب النظامي" },
          ],
        },
        {
          sheetName: "المركز المالي",
          title: `قائمة المركز المالي في ${period.to}`,
          meta,
          rows: balanceRows,
          columns: [{ key: "section", header: "القسم" }, { key: "version", header: "الإصدار" }, { key: "code", header: "الرمز" }, { key: "name", header: "الحساب" }, moneyColumn("amount", "المبلغ")],
        },
        {
          sheetName: "قائمة الدخل",
          title: "قائمة الدخل النظامية",
          meta,
          rows: incomeRows,
          columns: [{ key: "section", header: "القسم" }, { key: "version", header: "الإصدار" }, { key: "code", header: "الرمز" }, { key: "name", header: "الحساب" }, moneyColumn("amount", "المبلغ")],
        },
        {
          sheetName: "ميزان المراجعة",
          title: "ميزان المراجعة النظامي",
          meta,
          rows: freshTrial.rows,
          columns: [
            { key: "profileVersion", header: "الإصدار" }, { key: "code", header: "الرمز" }, { key: "name", header: "الحساب" }, { key: "type", header: "النوع" },
            moneyColumn("debit", "مدين"), moneyColumn("credit", "دائن"), moneyColumn("debitBalance", "رصيد مدين"), moneyColumn("creditBalance", "رصيد دائن"),
          ],
          totalsRow: { name: "الإجمالي", debit: Number(freshTrial.totals.debit), credit: Number(freshTrial.totals.credit) },
        },
        {
          sheetName: "اليومية العامة",
          title: "اليومية النظامية المثبتة",
          meta,
          rows: journal,
          columns: [
            { key: "profileVersion", header: "الإصدار" }, { key: "entryDate", header: "التاريخ" }, { key: "journalId", header: "رقم القيد" }, { key: "sourceType", header: "المصدر" },
            { key: "internalCode", header: "الحساب التشغيلي" }, { key: "role", header: "الدور" },
            { key: "statutoryCode", header: "الرمز النظامي" }, { key: "statutoryName", header: "الحساب النظامي" },
            moneyColumn("debit", "مدين"), moneyColumn("credit", "دائن"),
          ],
        },
      ] as SheetSpec[];
    });
  }

  const error = trialQuery.error ?? incomeQuery.error ?? balanceQuery.error;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-full overflow-x-auto pb-1"><PeriodFilter value={period} onChange={setPeriod} /></div>
        <Button disabled={!trial?.available || !income?.available || !balance?.available || trial.mode !== "ACTIVE"} onClick={exportAccountantPack}>
          <FileSpreadsheet className="size-4" aria-hidden />تصدير حزمة مراقب الحسابات
        </Button>
      </div>
      {error && <ErrorState message={error.message} />}
      {trial && !trial.available && <ErrorState message={trial.reason} />}
      {trial?.available && trial.mode !== "ACTIVE" && (
        <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-base text-[var(--sem-warn)]">
          هذه أرقام معاينة من دورة SHADOW وليست قوائم رسمية. يتاح تصدير حزمة مراقب الحسابات بعد اجتياز بوابة ACTIVE فقط.
        </div>
      )}
      {trial?.available && income?.available && balance?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">إجمالي الأصول</p><p className="font-semibold tabular-nums">{fmtAr(balance.totals.assets)} د.ع</p></CardContent></Card>
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">الالتزامات وحقوق الملكية</p><p className="font-semibold tabular-nums">{fmtAr(balance.totals.liabilitiesAndEquity)} د.ع</p></CardContent></Card>
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">صافي نتيجة النشاط</p><p className="font-semibold tabular-nums">{fmtAr(income.totals.netIncome)} د.ع</p></CardContent></Card>
            <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">فرق ميزان المراجعة</p><p className="font-semibold tabular-nums">{fmtAr(trial.totals.difference)} د.ع</p></CardContent></Card>
          </div>
          <Card><CardHeader><CardTitle className="text-base">قائمة المركز المالي في {period.to}</CardTitle></CardHeader><CardContent className="p-0"><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>القسم</TableHead><TableHead>الإصدار</TableHead><TableHead>الرمز</TableHead><TableHead>الحساب</TableHead><TableHead>المبلغ</TableHead></TableRow></TableHeader><TableBody>{visibleBalanceRows.map((row) => <TableRow key={row.key} className={row.emphasis ? "font-semibold" : undefined}><TableCell>{row.section}</TableCell><TableCell className="tabular-nums">{row.version}</TableCell><TableCell dir="ltr">{row.code || "—"}</TableCell><TableCell>{row.name}</TableCell><TableCell className="tabular-nums">{fmtAr(row.amount)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">قائمة الدخل</CardTitle></CardHeader><CardContent className="p-0"><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>القسم</TableHead><TableHead>الإصدار</TableHead><TableHead>الرمز</TableHead><TableHead>الحساب</TableHead><TableHead>المبلغ</TableHead></TableRow></TableHeader><TableBody>{visibleIncomeRows.map((row) => <TableRow key={row.key} className={row.emphasis ? "font-semibold" : undefined}><TableCell>{row.section}</TableCell><TableCell className="tabular-nums">{row.version}</TableCell><TableCell dir="ltr">{row.code || "—"}</TableCell><TableCell>{row.name}</TableCell><TableCell className="tabular-nums">{fmtAr(row.amount)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">ميزان المراجعة — كل اللقطات المعتمدة</CardTitle></CardHeader><CardContent className="p-0"><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>الإصدار</TableHead><TableHead>الرمز</TableHead><TableHead>الحساب</TableHead><TableHead>النوع</TableHead><TableHead>مدين</TableHead><TableHead>دائن</TableHead><TableHead>رصيد مدين</TableHead><TableHead>رصيد دائن</TableHead></TableRow></TableHeader><TableBody>{trial.rows.map((row) => <TableRow key={`${row.profileId}-${row.accountId}`}><TableCell className="tabular-nums">{row.profileVersion}</TableCell><TableCell className="tabular-nums" dir="ltr">{row.code}</TableCell><TableCell>{row.name}</TableCell><TableCell>{TYPE_LABEL[row.type] ?? row.type}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.credit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debitBalance)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.creditBalance)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell></CardContent></Card>
        </>
      )}
    </div>
  );
}

function AccountLedgerTab() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const utils = trpc.useUtils();
  const profiles = trpc.statutoryAccounting.profiles.useQuery();
  const active = profiles.data?.find((profile) => profile.status === "ACTIVE");
  const detail = trpc.statutoryAccounting.detail.useQuery({ profileId: active?.id ?? 0 }, { enabled: Boolean(active) });
  const choices = useMemo(
    () => detail.data?.accounts.filter((account) => account.isPosting) ?? [],
    [detail.data?.accounts],
  );
  useEffect(() => {
    if (accountId == null && choices.length) setAccountId(choices[0].id);
  }, [accountId, choices]);
  useEffect(() => setOffset(0), [period.from, period.to, accountId]);
  const query = trpc.statutoryAccounting.accountLedger.useQuery(
    { from: period.from, to: period.to, accountId: accountId ?? 0, profileId: active?.id, limit: 100, offset },
    { enabled: Boolean(active && accountId && period.from <= period.to) },
  );
  const report = query.data;

  function exportLedger() {
    if (!report?.available || !active || !accountId) return;
    exportSheets(`كشف-حساب-${report.account.code}`, async () => {
      const chunk = await utils.statutoryAccounting.accountLedgerExport.fetch({
        from: period.from,
        to: period.to,
        accountId,
        profileId: active.id,
      });
      if (!chunk.available) throw new Error(chunk.reason);
      const rows = requireCompleteStatutoryExport(chunk, "كشف الحساب");
      return [{
        sheetName: "كشف الحساب",
        title: `كشف ${chunk.account.code} — ${chunk.account.name}`,
        meta: [
          { label: "الفترة", value: `${period.from} — ${period.to}` },
          { label: "الرصيد الافتتاحي المدين", value: chunk.opening.debitBalance },
          { label: "الرصيد الافتتاحي الدائن", value: chunk.opening.creditBalance },
        ],
        rows,
        columns: [
          { key: "entryDate", header: "التاريخ" }, { key: "journalId", header: "رقم القيد" },
          { key: "sourceType", header: "المصدر" }, { key: "sourceKey", header: "مرجع المصدر" },
          { key: "internalCode", header: "الحساب التشغيلي" }, { key: "role", header: "الدور" },
          { key: "debit", header: "مدين", money: true, map: (row: AccountLedgerRows[number]) => Number(row.debit) },
          { key: "credit", header: "دائن", money: true, map: (row: AccountLedgerRows[number]) => Number(row.credit) },
          { key: "debitBalance", header: "رصيد مدين", money: true, map: (row: AccountLedgerRows[number]) => Number(row.debitBalance) },
          { key: "creditBalance", header: "رصيد دائن", money: true, map: (row: AccountLedgerRows[number]) => Number(row.creditBalance) },
        ],
      }] as SheetSpec[];
    });
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[1fr_2fr]">
        <AppSelect value={accountId == null ? "" : String(accountId)} onValueChange={(value) => setAccountId(Number(value))} aria-label="الحساب النظامي" placeholder="اختر حساباً">
          {choices.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
        </AppSelect>
        <div className="max-w-full overflow-x-auto pb-1"><PeriodFilter value={period} onChange={setPeriod} /></div>
      </div>
      {!active && <ErrorState message="لا يوجد إصدار نظامي نافذ." />}
      {query.isError && <ErrorState message={query.error.message} />}
      {report && !report.available && <ErrorState message={report.reason} />}
      {report?.available && <Card><CardHeader className="grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"><CardTitle className="text-base">كشف {report.account.code} — {report.account.name}</CardTitle><Button variant="outline" size="sm" onClick={exportLedger}><Download className="size-4" aria-hidden />تصدير الكشف</Button></CardHeader><CardContent className="space-y-3 p-0 pb-4"><div className="px-6 text-sm text-muted-foreground">الرصيد الافتتاحي: مدين {fmtAr(report.opening.debitBalance)} / دائن {fmtAr(report.opening.creditBalance)} د.ع</div><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>التاريخ/القيد</TableHead><TableHead>المصدر</TableHead><TableHead>الدور التشغيلي</TableHead><TableHead>مدين</TableHead><TableHead>دائن</TableHead><TableHead>رصيد مدين</TableHead><TableHead>رصيد دائن</TableHead></TableRow></TableHeader><TableBody>{report.rows.map((row) => <TableRow key={row.lineId}><TableCell>{row.entryDate}<br /><span className="text-xs text-muted-foreground">#{row.journalId}</span></TableCell><TableCell dir="ltr">{row.sourceKey ?? row.sourceId ?? row.sourceType}</TableCell><TableCell><span dir="ltr">{row.internalCode}</span><br /><code className="text-xs" dir="ltr">{row.role}</code></TableCell><TableCell className="tabular-nums">{fmtAr(row.debit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.credit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debitBalance)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.creditBalance)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell><div className="flex items-center justify-between px-6"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>السابق</Button><span className="text-xs text-muted-foreground">الحركات {offset + 1}–{offset + report.rows.length}</span><Button variant="outline" disabled={!report.pagination.hasMore} onClick={() => setOffset(offset + 100)}>التالي</Button></div></CardContent></Card>}
    </div>
  );
}

function GeneralJournalTab() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [period.from, period.to]);
  const query = trpc.statutoryAccounting.generalJournal.useQuery({ from: period.from, to: period.to, profileScope: "ALL_APPROVED", limit: 100, offset }, { enabled: period.from <= period.to });
  const report = query.data;
  return (
    <div className="space-y-4">
      <div className="max-w-full overflow-x-auto pb-1"><PeriodFilter value={period} onChange={setPeriod} /></div>
      {query.isError && <ErrorState message={query.error.message} />}
      {report && !report.available && <ErrorState message={report.reason} />}
      {report?.available && <Card><CardHeader><CardTitle className="text-base">اليومية النظامية المثبتة</CardTitle></CardHeader><CardContent className="space-y-3 p-0 pb-4"><ScrollTableShell bordered={false}><Table><TableHeader className="bg-muted/50"><TableRow><TableHead>الإصدار</TableHead><TableHead>التاريخ/القيد</TableHead><TableHead>المصدر</TableHead><TableHead>الحساب التشغيلي</TableHead><TableHead>الحساب النظامي</TableHead><TableHead>مدين</TableHead><TableHead>دائن</TableHead></TableRow></TableHeader><TableBody>{report.rows.map((row, index) => <TableRow key={`${row.journalId}-${index}`}><TableCell className="tabular-nums">{row.profileVersion}</TableCell><TableCell><span>{row.entryDate}</span><br /><span className="text-xs text-muted-foreground">#{row.journalId}</span></TableCell><TableCell><span dir="ltr">{row.sourceType}</span><br /><span className="text-xs text-muted-foreground" dir="ltr">{row.sourceKey ?? row.sourceId ?? "—"}</span></TableCell><TableCell><span dir="ltr">{row.internalCode}</span><br /><code className="text-xs" dir="ltr">{row.role}</code></TableCell><TableCell><span dir="ltr">{row.statutoryCode}</span> — {row.statutoryName}</TableCell><TableCell className="tabular-nums">{fmtAr(row.debit)}</TableCell><TableCell className="tabular-nums">{fmtAr(row.credit)}</TableCell></TableRow>)}</TableBody></Table></ScrollTableShell><div className="flex items-center justify-between px-6"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>السابق</Button><span className="text-xs text-muted-foreground">السجلات {offset + 1}–{offset + report.rows.length}</span><Button variant="outline" disabled={!report.pagination.hasMore} onClick={() => setOffset(offset + 100)}>التالي</Button></div></CardContent></Card>}
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
        <TabsList className="flex h-auto flex-wrap justify-start"><TabsTrigger value="setup">الإصدار والربط</TabsTrigger><TabsTrigger value="statements">القوائم وحزمة المحاسب</TabsTrigger><TabsTrigger value="ledger">كشف حساب نظامي</TabsTrigger><TabsTrigger value="journal">اليومية النظامية</TabsTrigger></TabsList>
        <TabsContent value="setup"><SetupTab canAdmin={canAdmin} /></TabsContent>
        <TabsContent value="statements"><FinancialStatementsTab /></TabsContent>
        <TabsContent value="ledger"><AccountLedgerTab /></TabsContent>
        <TabsContent value="journal"><GeneralJournalTab /></TabsContent>
      </Tabs>
    </div>
  );
}
