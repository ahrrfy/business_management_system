import { useEffect, useState } from "react";
import { Gift, Plus, Save, Star } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { Field } from "@/components/product/variantBits";
import { notify } from "@/lib/notify";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

type FormState = { id?: number; name: string; status: "DRAFT" | "ACTIVE" | "PAUSED"; pointsPerIqd: string; iqdDiscountPerPoint: string; minRedeemPoints: string; maxRedeemPercent: string; expiresAfterDays: string };
const initial: FormState = { name: "برنامج ولاء مكتبة العربية", status: "DRAFT", pointsPerIqd: "0", iqdDiscountPerPoint: "0", minRedeemPoints: "0", maxRedeemPercent: "0", expiresAfterDays: "" };
const STATUS_AR: Record<FormState["status"], string> = { DRAFT: "مسودة", ACTIVE: "نشط", PAUSED: "موقوف" };

/** صفُّ رصيد نقاط عميل — مشتقٌّ من عقد `storeAdmin.loyalty.overview`. */
type LoyaltyAccountRow = RouterOutputs["storeAdmin"]["loyalty"]["overview"]["accounts"][number];

const accountColumns: ColumnDef<LoyaltyAccountRow, unknown>[] = [
  { id: "customer", header: "العميل", accessorFn: (r) => r.customerName, cell: ({ row }) => <span className="font-medium">{row.original.customerName}</span> },
  { id: "program", header: "البرنامج", accessorFn: (r) => r.programName, cell: ({ row }) => <span className="text-muted-foreground">{row.original.programName}</span> },
  {
    id: "points",
    header: "الرصيد",
    // نصُّ العرض للنسخ، والفرز على القيمة الخامّ: الفرز النصّيّ يقرأ «1,000» أصغر من «900»
    // — والجدول كلّه «أعلى أرصدة» فترتيبه هو معناه.
    accessorFn: (r) => Number(r.pointsBalance).toLocaleString("en-US"),
    meta: { kind: "number" },
    sortDescFirst: true,
    sortingFn: (a, b) => Number(a.original.pointsBalance ?? 0) - Number(b.original.pointsBalance ?? 0),
    cell: ({ row }) => <span className="font-bold">{Number(row.original.pointsBalance).toLocaleString("en-US")}</span>,
  },
];

export default function LoyaltyManager() {
  const utils = trpc.useUtils();
  const programs = trpc.storeAdmin.loyalty.programs.useQuery();
  const overview = trpc.storeAdmin.loyalty.overview.useQuery();
  const [form, setForm] = useState<FormState>(initial);
  const save = trpc.storeAdmin.loyalty.saveProgram.useMutation({
    onSuccess: async () => { await Promise.all([utils.storeAdmin.loyalty.programs.invalidate(), utils.storeAdmin.loyalty.overview.invalidate()]); notify.ok("تم حفظ قواعد برنامج الولاء"); },
    onError: (error) => notify.err(error),
  });
  useEffect(() => { if (!form.id && programs.data?.[0]) load(programs.data[0]); }, [programs.data]);
  const load = (program: NonNullable<typeof programs.data>[number]) => setForm({ id: program.id, name: program.name, status: program.status, pointsPerIqd: String(program.pointsPerIqd), iqdDiscountPerPoint: String(program.iqdDiscountPerPoint), minRedeemPoints: String(program.minRedeemPoints), maxRedeemPercent: String(program.maxRedeemPercent), expiresAfterDays: program.expiresAfterDays == null ? "" : String(program.expiresAfterDays) });
  const submit = () => save.mutate({ id: form.id, name: form.name.trim(), status: form.status, pointsPerIqd: form.pointsPerIqd, iqdDiscountPerPoint: form.iqdDiscountPerPoint, minRedeemPoints: Number(form.minRedeemPoints), maxRedeemPercent: Number(form.maxRedeemPercent), expiresAfterDays: form.expiresAfterDays ? Number(form.expiresAfterDays) : null });
  return <div className="max-w-7xl mx-auto space-y-4 pb-8"><PageHeader title="الولاء والنقاط" description="تحكم مركزي في قواعد كسب النقاط وتحويلها إلى خصم. لا يظهر أو يُصرف أي رصيد خارج قواعد الخادم." actions={<Button variant="outline" onClick={() => setForm(initial)}><Plus className="size-4"/> برنامج جديد</Button>}/><div className="grid gap-4 md:grid-cols-3"><Card><CardContent className="pt-5"><div className="text-sm text-muted-foreground">برامج الولاء</div><div className="mt-1 text-3xl font-bold">{programs.data?.length ?? 0}</div></CardContent></Card><Card><CardContent className="pt-5"><div className="text-sm text-muted-foreground">رصيد النقاط الكلي</div><div className="mt-1 text-3xl font-bold tabular-nums">{Number(overview.data?.totalPoints ?? 0).toLocaleString("en-US")}</div></CardContent></Card><Card><CardContent className="pt-5 flex items-center gap-3"><div className="rounded-xl bg-primary/10 p-3"><Gift className="size-6 text-primary"/></div><p className="text-sm text-muted-foreground">تمنح النقاط فقط عند تسليم الطلب، وبسجل لا يقبل التعديل.</p></CardContent></Card></div><div className="grid gap-4 lg:grid-cols-[1.25fr_.75fr]"><Card><CardHeader><CardTitle className="text-base">قواعد البرنامج</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2"><Field label="اسم البرنامج" required className="md:col-span-2"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/></Field><Field label="الحالة"><AppSelect value={form.status} onValueChange={(value) => setForm({ ...form, status: value as FormState["status"] })}><option value="DRAFT">مسودة</option><option value="ACTIVE">نشط</option><option value="PAUSED">موقوف</option></AppSelect></Field><Field label="نقاط لكل دينار"><Input dir="ltr" inputMode="decimal" value={form.pointsPerIqd} onChange={(event) => setForm({ ...form, pointsPerIqd: event.target.value })}/></Field><Field label="قيمة الخصم لكل نقطة (د.ع)"><Input dir="ltr" inputMode="decimal" value={form.iqdDiscountPerPoint} onChange={(event) => setForm({ ...form, iqdDiscountPerPoint: event.target.value })}/></Field><Field label="أدنى نقاط للاستبدال"><Input dir="ltr" inputMode="numeric" value={form.minRedeemPoints} onChange={(event) => setForm({ ...form, minRedeemPoints: event.target.value })}/></Field><Field label="أعلى نسبة خصم للطلب"><Input dir="ltr" inputMode="numeric" value={form.maxRedeemPercent} onChange={(event) => setForm({ ...form, maxRedeemPercent: event.target.value })}/></Field><Field label="انتهاء النقاط بعد (يوم)"><Input dir="ltr" inputMode="numeric" placeholder="بدون انتهاء" value={form.expiresAfterDays} onChange={(event) => setForm({ ...form, expiresAfterDays: event.target.value })}/></Field><div className="md:col-span-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground">المعادلة تُطبق عند التسليم فقط. إدارة الخصومات داخل الخادم، لذلك لا يستطيع التطبيق أو العميل فرض قيمة نقاط أو خصم غير مستحق.</div><div className="md:col-span-2 flex justify-end"><Button disabled={save.isPending || !form.name.trim()} onClick={submit}><Save className="size-4"/>{save.isPending ? ACTION_LABELS.saving : "حفظ قواعد الولاء"}</Button></div></CardContent></Card><Card><CardHeader><CardTitle className="text-base">البرامج الحالية</CardTitle></CardHeader><CardContent className="space-y-2">{(programs.data ?? []).map((program) => <button key={program.id} type="button" onClick={() => load(program)} className={`w-full rounded-lg border p-3 text-right transition ${form.id === program.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}><div className="flex items-center justify-between gap-2"><b>{program.name}</b><Badge>{STATUS_AR[program.status]}</Badge></div><div className="mt-1 text-xs text-muted-foreground">{Number(program.pointsPerIqd).toLocaleString("en-US")} نقطة/د.ع · حد الاستبدال {Number(program.minRedeemPoints).toLocaleString("en-US")}</div></button>)}{!programs.isLoading && !programs.data?.length && <div className="py-10 text-center text-sm text-muted-foreground"><Star className="mx-auto mb-2 size-6"/>أنشئ برنامجاً ثم راجعه قبل تفعيله.</div>}</CardContent></Card></div><Card><CardHeader><CardTitle className="text-base">أعلى أرصدة العملاء</CardTitle></CardHeader><CardContent><DataTable<LoyaltyAccountRow> embedded searchable={false} bounded={false} pageSize={Infinity} columns={accountColumns} data={overview.data?.accounts ?? []} loading={overview.isLoading} errorState={{ isError: overview.isError, message: overview.error?.message, onRetry: () => overview.refetch() }} emptyText="لا توجد أرصدة نقاط بعد."/></CardContent></Card></div>;
}
