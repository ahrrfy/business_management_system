import { useEffect, useMemo, useState } from "react";
import { Banknote, PackageOpen, Truck, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Badge } from "@/components/ui/badge";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { D, fmt } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { ListToolbar, RowActions } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import DeliveryPartyDetail from "@/pages/DeliveryPartyDetail";

type Party = RouterOutputs["delivery"]["listParties"][number];

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
function ageBadge(days: number | null) {
  if (days == null) return <span className="text-muted-foreground">—</span>;
  const cls = days <= 7 ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : days <= 14 ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : days <= 30 ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]";
  return <span className={cn("rounded px-2 py-0.5 text-xs font-bold", cls)}>{days} يوم</span>;
}

export default function DeliveryParties() {
  const me = trpc.auth.me.useQuery();
  const isManager = ["admin", "manager"].includes(me.data?.role ?? "");
  // مرآة بوّابة الخادم: settle = cashierProcedure = requireRole("cashier","manager") وadmin يمرّ ضمنياً.
  const canSettle = ["admin", "cashier", "manager"].includes(me.data?.role ?? "");
  const utils = trpc.useUtils();
  const list = trpc.delivery.listParties.useQuery({});
  const [showCreate, setShowCreate] = useState(false);
  const [settleFor, setSettleFor] = useState<Party | null>(null);
  const [writeOffFor, setWriteOffFor] = useState<Party | null>(null);
  // «ذمة قائمة»: رصيدٌ غير صفريّ (بذمّة المندوب/الجهة نقداً لم يُورَّد بعد) — محفوظ في querystring.
  // detail: لوحة تفاصيل الجهة (٩/٨) — في الرابط كي تفتحها روابط الفواتير مباشرة.
  const [f, setF, resetF] = useUrlFilters({ outstandingOnly: "", detail: "" });
  // ٩/٨: الكشف المطبوع السريع استُبدل بلوحة التفاصيل (كشف حيّ يشمل أمانات الأجرة التي كان
  // الكشف القديم يُسقطها صامتاً + جمع Decimal بدل Number العائم + المرجع = رقم الفاتورة الفعلي).
  const detailFor = f.detail ? (list.data ?? []).find((p) => String(p.id) === f.detail) ?? null : null;

  const kpis = useMemo(() => {
    const rows = list.data ?? [];
    const totalFloat = rows.reduce((s, p) => s + Number(p.currentBalance ?? 0), 0);
    const openCount = rows.reduce((s, p) => s + Number(p.openConsignments ?? 0), 0);
    const oldest = rows.map((p) => ageDays(p.oldestOutstanding)).filter((d): d is number => d != null);
    return { totalFloat, openCount, count: rows.length, oldest: oldest.length ? Math.max(...oldest) : null };
  }, [list.data]);

  if (list.isError) return <div className="p-6"><ErrorState onRetry={() => list.refetch()} /></div>;
  const allRows = list.data ?? [];
  const rows = f.outstandingOnly === "1" ? allRows.filter((p) => !D(p.currentBalance).isZero()) : allRows;
  const activeFilterCount = f.outstandingOnly === "1" ? 1 : 0;

  return (
    <div className="space-y-5 p-4 md:p-6" dir="rtl">
      <PageHeader
        title="جهات التوصيل وذممها"
        description="المناديب وشركات التوصيل — العهدة القائمة (COD غير المورَّد) وأعمارها."
        icon={<Truck className="size-6 text-primary" aria-hidden />}
        actions={<Button onClick={() => setShowCreate(true)} disabled={!isManager}>+ جهة جديدة</Button>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="إجمالي النقد بذمّة المناديب" value={`${fmt(String(kpis.totalFloat))} د.ع`} icon={Banknote} tone={kpis.totalFloat > 0 ? "warning" : "default"} />
        <StatCard label="شحنات مفتوحة" value={String(kpis.openCount)} icon={PackageOpen} />
        <StatCard label="عدد الجهات" value={String(kpis.count)} icon={Users} />
        <StatCard label="أقدم مستحق" value={kpis.oldest != null ? `${kpis.oldest} يوم` : "—"} icon={Truck} tone={kpis.oldest != null && kpis.oldest > 14 ? "warning" : "default"} />
      </div>

      <ListToolbar
        title="الجهات"
        count={rows.length}
        loading={list.isLoading}
        activeFilterCount={activeFilterCount}
        onResetFilters={resetF}
        onRefresh={() => void list.refetch()}
        refreshing={list.isFetching}
        exportSpec={{
          filename: "جهات-التوصيل",
          sheetName: "الجهات",
          rows,
          formats: ["xlsx", "csv"],
          columns: [
            { key: "name", header: "الجهة" },
            { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
            { key: "partyType", header: "النوع", map: (r) => (r.partyType === "COMPANY" ? "شركة" : "مندوب") },
            // Slice DFP1 (٣٠/٨/٢٦) — ٤ أعمدة منفصلة (partyExposure) بدل «نقد بذمّتها» الملتبس.
            { key: "currentBalance", header: "نقد بيده", money: true },
            { key: "parcelsInTransitAmount", header: "طرود بالطريق", money: true, map: (r) => (r as { parcelsInTransitAmount?: string }).parcelsInTransitAmount ?? "0" },
            { key: "deliveredUncollectedAmount", header: "سلم لم يحصل", money: true, map: (r) => (r as { deliveredUncollectedAmount?: string }).deliveredUncollectedAmount ?? "0" },
            { key: "feesOwedAmount", header: "أجور مستحقّة له", money: true, map: (r) => (r as { feesOwedAmount?: string }).feesOwedAmount ?? "0" },
            { key: "openConsignments", header: "شحنات مفتوحة" },
            { key: "oldestOutstanding", header: "أقدم مستحق (يوم)", map: (r) => ageDays(r.oldestOutstanding) ?? "" },
            { key: "isActive", header: "الحالة", map: (r) => (r.isActive ? "نشط" : "معطّل") },
          ],
        }}
        filters={
          <label className="inline-flex h-9 items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={f.outstandingOnly === "1"}
              onChange={(e) => setF({ outstandingOnly: e.target.checked ? "1" : "" })}
            />
            ذمّة قائمة فقط (رصيد غير صفريّ)
          </label>
        }
      />

      <div className="rounded-xl border bg-card">
        {list.isLoading ? (
          <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
        ) : allRows.length === 0 ? (
          <EmptyState icon={Truck} title="لا جهات توصيل" description="أضِف مندوباً أو شركة توصيل للبدء." actionLabel={isManager ? "+ جهة جديدة" : undefined} onAction={() => setShowCreate(true)} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Truck} title="لا نتائج" description="لا جهات مطابقة لفلترك الحالي." />
        ) : (
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              {/* Slice DFP1 (٣٠/٨/٢٦، P1 #2+#7): ٤ أعمدة منفصلة (partyExposure) بدل عمود واحد ملتبس.
                  التسميات والألوان من shared/partyExposure.ts (المصدر الوحيد). */}
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-right">الجهة</th>
                  <th className="p-3 text-right">النوع</th>
                  <th className="p-3 text-left" title="نقد قبضه المندوب لم يورَّد بعد">نقد بيده</th>
                  <th className="p-3 text-left" title="بضاعة سُلِّمت للمندوب لم تصل الزبون">طرود بالطريق</th>
                  <th className="p-3 text-left" title="طرد سُلِّم للزبون بلا قبضٍ كامل — خطر أعلى">سلم لم يحصل</th>
                  <th className="p-3 text-left" title="أجور توصيل نحن مدينون بها للمندوب">أجور له</th>
                  <th className="p-3 text-center">شحنات مفتوحة</th>
                  <th className="p-3 text-center">أقدم مستحق</th>
                  <th className="p-3 text-center">الحالة</th>
                  <th className="p-3 text-center">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const bal = Number(p.currentBalance ?? 0);
                  const inTransit = Number((p as { parcelsInTransitAmount?: string }).parcelsInTransitAmount ?? 0);
                  const uncollected = Number((p as { deliveredUncollectedAmount?: string }).deliveredUncollectedAmount ?? 0);
                  const feesOwed = Number((p as { feesOwedAmount?: string }).feesOwedAmount ?? 0);
                  return (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-3 font-medium">
                        <button type="button" className="font-bold text-primary hover:underline" onClick={() => setF({ detail: String(p.id) })}>
                          {p.name}
                        </button>
                        {p.phone && <span className="ms-2 text-xs text-muted-foreground" dir="ltr">{p.phone}</span>}
                      </td>
                      <td className="p-3">{p.partyType === "COMPANY" ? "شركة" : "مندوب"}</td>
                      <td className={cn("p-3 text-left tabular-nums font-bold", bal > 0 ? "text-foreground" : "text-muted-foreground")} dir="ltr">{fmt(p.currentBalance)}</td>
                      <td className={cn("p-3 text-left tabular-nums font-bold", inTransit > 0 ? "text-[var(--sem-warn)]" : "text-muted-foreground")} dir="ltr">{fmt(String(inTransit))}</td>
                      <td className={cn("p-3 text-left tabular-nums font-bold", uncollected > 0 ? "text-destructive" : "text-muted-foreground")} dir="ltr">{fmt(String(uncollected))}</td>
                      <td className={cn("p-3 text-left tabular-nums font-bold", feesOwed > 0 ? "text-[var(--sem-pos)]" : "text-muted-foreground")} dir="ltr">{fmt(String(feesOwed))}</td>
                      <td className="p-3 text-center tabular-nums">{p.openConsignments}</td>
                      <td className="p-3 text-center">{ageBadge(ageDays(p.oldestOutstanding))}</td>
                      <td className="p-3 text-center">{p.isActive ? <Badge variant="secondary">نشط</Badge> : <Badge variant="outline">معطل</Badge>}</td>
                      <td className="p-3 text-center">
                        <RowActions
                          mode="menu"
                          contact={{
                            phone: p.phone,
                            alternativePhones: [(p as { phone2?: string | null }).phone2],
                            label: `واتساب ${p.name}`,
                            message: buildOperationalContactMessage({
                              partyName: p.name,
                              entityLabel: p.partyType === "COMPANY" ? "شركة التوصيل" : "المندوب",
                              status: p.openConsignments > 0 ? `${p.openConsignments} شحنة مفتوحة` : "لا شحنات مفتوحة",
                              nextAction: Number(p.currentBalance ?? 0) > 0 ? `توجد عهدة قيد التسوية بقيمة ${fmt(p.currentBalance)} د.ع.` : null,
                            }),
                            gate: { module: "store", level: "READ" },
                          }}
                          actions={[
                            {
                              key: "detail",
                              kind: "view",
                              label: "تفاصيل وكشف",
                              onSelect: () => setF({ detail: String(p.id) }),
                              gate: { module: "store", level: "READ" },
                            },
                            {
                              key: "settle",
                              kind: "pay",
                              label: "تسوية",
                              hidden: !canSettle,
                              disabled: bal <= 0,
                              disabledReason: "لا يوجد رصيد قابل للتسوية",
                              onSelect: () => setSettleFor(p),
                              gate: { roles: ["cashier", "manager"] },
                            },
                            {
                              key: "write-off",
                              kind: "reverse",
                              label: "شطب",
                              variant: "destructive",
                              hidden: !isManager,
                              disabled: bal <= 0,
                              disabledReason: "لا يوجد عجز قابل للشطب",
                              onSelect: () => setWriteOffFor(p),
                              gate: { managerOnly: true },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTableShell>
        )}
      </div>

      {showCreate && <CreatePartyDialog onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); utils.delivery.listParties.invalidate(); }} />}
      {settleFor && <SettleDialog party={settleFor} onClose={() => setSettleFor(null)} onDone={() => { setSettleFor(null); utils.delivery.listParties.invalidate(); }} />}
      {writeOffFor && <WriteOffDialog party={writeOffFor} onClose={() => setWriteOffFor(null)} onDone={() => { setWriteOffFor(null); utils.delivery.listParties.invalidate(); }} />}
      {detailFor && (
        <DeliveryPartyDetail
          party={detailFor}
          onClose={() => setF({ detail: "" })}
          onChanged={() => { utils.delivery.listParties.invalidate(); utils.delivery.getParty.invalidate({ id: detailFor.id }); utils.delivery.partyStatement.invalidate(); }}
        />
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-extrabold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function CreatePartyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [partyType, setPartyType] = useState<"INDIVIDUAL" | "COMPANY">("INDIVIDUAL");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [defaultFee, setDefaultFee] = useState("0");
  const [userId, setUserId] = useState<number | null>(null);
  // الحساب الأول سائق للفرد أو مدير للشركة؛ بقية عضويات الشركة تُدار بعد إنشاء الجهة.
  const accounts = trpc.delivery.courierAccounts.useQuery();
  const available = (accounts.data ?? []).filter((a) => a.linkedPartyId == null);
  const m = trpc.delivery.createParty.useMutation({ onSuccess: () => { notify.ok("أُضيفت الجهة"); onDone(); }, onError: (e) => notify.err(e) });
  return (
    <Modal title="جهة توصيل جديدة" onClose={onClose}>
      <label className="mb-1.5 block text-sm font-bold">النوع</label>
      <select className="mb-3 h-11 w-full rounded-md border bg-transparent px-3 text-sm" value={partyType} onChange={(e) => setPartyType(e.target.value as typeof partyType)}>
        <option value="INDIVIDUAL">مندوب فرد</option>
        <option value="COMPANY">شركة توصيل</option>
      </select>
      <label className="mb-1.5 block text-sm font-bold">الاسم</label>
      <Input value={name} onChange={(e) => setName(e.target.value)} className="mb-3 h-11" />
      <label className="mb-1.5 block text-sm font-bold">الهاتف</label>
      <IntlPhoneInput value={phone} onChange={setPhone} className="mb-3" ariaLabel="هاتف جهة التوصيل" />
      <label className="mb-1.5 block text-sm font-bold">أجرة توصيل افتراضية (د.ع)</label>
      <MoneyInput value={defaultFee} onChange={setDefaultFee} className="mb-3 h-11 text-end tabular-nums" ariaLabel="الأجرة الافتراضية" />
      <label className="mb-1.5 block text-sm font-bold">حساب بوابة الجهة (اختياري)</label>
      <select className="mb-1 h-11 w-full rounded-md border bg-transparent px-3 text-sm" value={userId ?? ""} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)}>
        <option value="">بلا حساب دخول</option>
        {available.map((a) => (
          <option key={a.id} value={a.id}>{a.name}{a.username ? ` (${a.username})` : ""}</option>
        ))}
      </select>
      <p className="mb-4 text-xs text-muted-foreground">
        {partyType === "COMPANY"
          ? "الحساب الأول يصبح مديراً للشركة؛ وبعد الإنشاء يمكن إضافة عدة سائقين ومديرين ومحاسبين من صفحة الجهة."
          : "الحساب المختار يصبح سائق الجهة ويرى الطلبات المسندة إليه في «توصيلاتي»."}
      </p>
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1" disabled={m.isPending || !name.trim()} onClick={() => m.mutate({ partyType, name: name.trim(), phone: phone || null, userId: userId ?? undefined, defaultFee: /^\d+(\.\d{1,2})?$/.test(defaultFee) ? defaultFee : "0" })}>{m.isPending ? "جارٍ…" : "إضافة"}</Button>
      </div>
    </Modal>
  );
}

function SettleDialog({ party, onClose, onDone }: { party: Party; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(Number(party.currentBalance ?? 0)));
  // IDEMPOTENCY (تدقيق ٢/٧): مفتاح ثابت لكل جلسة حوار (لا UUID جديد لكل نقرة) ⇒ النقر المزدوج
  // يُعاد كـreplay على الخادم بدل تسجيل تسويتين نقديّتين.
  const [reqId] = useState(() => crypto.randomUUID());
  const m = trpc.delivery.settle.useMutation({ onSuccess: () => { notify.ok("سُجِّلت التسوية"); onDone(); }, onError: (e) => notify.err(e) });
  return (
    <Modal title={`تسوية عهدة «${party.name}»`} onClose={onClose}>
      <p className="mb-2 text-sm text-muted-foreground">العهدة الحالية: <span dir="ltr" className="font-bold tabular-nums">{fmt(party.currentBalance)} د.ع</span>. يدفع المندوب نقداً (يدخل درج وردية مفتوحة).</p>
      {/* ٩/٨: الخادم يقصر هذا المسار على العهدة السائبة — نقد الإرساليات المفتوحة يُورَّد من
          شاشة «تسوية المناديب» كي تُقيَّد فواتيره وتُخفَّض ذمم عملائه (لا فاتورة تبقى معلّقة). */}
      {party.openConsignments > 0 && (
        <p className="mb-3 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-2.5 py-2 text-xs font-bold text-[var(--sem-warn)]">
          لهذه الجهة {party.openConsignments} إرسالية مفتوحة — نقدُها يُستلم من «إدارة التوصيل ← تسوية المناديب» (توريد بالإرسالية)، وهذا الحوار للعهدة السائبة فقط (عجوزات سابقة/تحصيلات متجر).
        </p>
      )}
      <label className="mb-1.5 block text-sm font-bold">المبلغ المُسدَّد (د.ع)</label>
      <MoneyInput value={amount} onChange={setAmount} className="mb-4 h-11 text-end text-lg font-bold tabular-nums" ariaLabel="مبلغ التسديد" />
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1" disabled={m.isPending || !/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0} onClick={() => m.mutate({ partyId: party.id, amount, clientRequestId: reqId })}>{m.isPending ? "جارٍ…" : "تسجيل التسوية"}</Button>
      </div>
    </Modal>
  );
}

function WriteOffDialog({ party, onClose, onDone }: { party: Party; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(Number(party.currentBalance ?? 0)));
  const [reason, setReason] = useState("");
  // ٩/٨ — الشطب الموجَّه: عجز إرساليةٍ بعينها يُشطَب باختيارها فتُقفَل (WRITTEN_OFF) وتُقيَّد
  // فاتورتُها وتُبرَّأ ذمّة عميلها (المندوب حصّل وضيّع — الزبون بريء). بدونه كانت الإرسالية
  // تبقى «زومبي» في شاشة التوريد تقبل توريداً لاحقاً يقلب الرصيد سالباً. «عهدة سائبة» تبقى
  // للعجوزات غير المرتبطة بإرسالية (الخادم يحرس الحالتين).
  const [consignmentId, setConsignmentId] = useState<string>("");
  /**
   * Codex P1 (٢٥/٨): قائمةُ الشطب لا نقبل أن تُخفي الترقيمُ إرساليةً — الموظّف يحتاج أن يجدها
   * ليختارها. نجلب كلّ الصفحات تلقائياً (٥٠٠ لكل نداء).
   */
  const open = trpc.delivery.openConsignments.useInfiniteQuery(
    { partyId: party.id, limit: 500 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  useEffect(() => {
    if (open.hasNextPage && !open.isFetchingNextPage) void open.fetchNextPage();
  }, [open.hasNextPage, open.isFetchingNextPage, open.fetchNextPage]);
  const openRows = (open.data?.pages ?? []).flatMap((p) => p.rows);
  const chosen = openRows.find((c) => String(c.id) === consignmentId) ?? null;
  const chosenRemaining = chosen ? Math.max(0, Number(chosen.codAmount) - Number(chosen.collectedAmount)) : null;
  // IDEMPOTENCY (تدقيق ٢/٧): مفتاح ثابت لكل جلسة حوار — النقر المزدوج لا يشطب العجز مرّتين.
  const [reqId] = useState(() => crypto.randomUUID());
  const m = trpc.delivery.writeOff.useMutation({ onSuccess: () => { notify.ok("شُطِب العجز"); onDone(); }, onError: (e) => notify.err(e) });
  const effAmount = chosenRemaining != null ? chosenRemaining.toFixed(2) : amount;
  const submit = async () => {
    const ok = await confirm({
      variant: "danger",
      title: "شطب عجز عهدة",
      description: chosen
        ? `ستُقفل الإرسالية ${chosen.consignmentNumber} وتُقيَّد فاتورتها مسدَّدة، ويُشطب ${fmt(effAmount)} د.ع من عهدة «${party.name}» كخسارة لا رجعة فيها (الزبون دفع للمندوب والمندوب ضيّع النقد).`
        : `سيُشطب ${fmt(effAmount)} د.ع من العهدة السائبة لـ«${party.name}» كمصروف (خسارة) لا رجعة فيه.`,
      confirmText: "شطب",
      requireText: party.name,
    });
    if (ok) m.mutate({ partyId: party.id, amount: effAmount, reason: reason.trim(), consignmentId: chosen ? chosen.id : undefined, clientRequestId: reqId });
  };
  return (
    <Modal title={`شطب عجز «${party.name}»`} onClose={onClose}>
      <p className="mb-3 text-sm text-destructive">إبراء دَين غير قابل للتحصيل — يُقيَّد خسارةً. (مدير فقط)</p>
      <label className="mb-1.5 block text-sm font-bold">ما الذي يُشطب؟</label>
      <select
        className="mb-3 h-11 w-full rounded-md border bg-transparent px-3 text-sm"
        value={consignmentId}
        onChange={(e) => setConsignmentId(e.target.value)}
      >
        <option value="">عهدة سائبة (غير مرتبطة بإرسالية مفتوحة)</option>
        {openRows.map((c) => (
          <option key={c.id} value={String(c.id)}>
            إرسالية {c.consignmentNumber} — {c.invoiceNumber ?? ""} — متبقٍّ {fmt(String(Math.max(0, Number(c.codAmount) - Number(c.collectedAmount))))} د.ع
          </option>
        ))}
      </select>
      <label className="mb-1.5 block text-sm font-bold">المبلغ المشطوب (د.ع)</label>
      <MoneyInput
        value={effAmount}
        onChange={setAmount}
        disabled={chosenRemaining != null}
        className="mb-1 h-11 text-end text-lg font-bold tabular-nums"
        ariaLabel="مبلغ التعديل"
      />
      {chosenRemaining != null && (
        <p className="mb-2 text-xs text-muted-foreground">شطب الإرسالية يكون بكامل متبقّيها — تُقفل وتُقيَّد فاتورتها مسدَّدة وتُبرَّأ ذمّة العميل.</p>
      )}
      <label className="mb-1.5 block text-sm font-bold">السبب</label>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} className="mb-4 h-11" placeholder="سبب الشطب (٣ أحرف فأكثر)" />
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={m.isPending || !/^\d+(\.\d{1,2})?$/.test(effAmount) || Number(effAmount) <= 0 || reason.trim().length < 3} onClick={submit}>{m.isPending ? "جارٍ…" : "شطب"}</Button>
      </div>
    </Modal>
  );
}
