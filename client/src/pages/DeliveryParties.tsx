import { useEffect, useMemo, useState } from "react";
import { Banknote, PackageOpen, ShieldCheck, Truck, Users, XCircle } from "lucide-react";
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
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

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
  const role = me.data?.role as RoleKey | undefined;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const isManager = !!role && moduleAccessAllowed(role, override, "store", "FULL", ["manager"]);
  const canRequestWriteOff = role === "admin";
  const canReviewWriteOff = !!role && moduleAccessAllowed(
    role,
    override,
    "store",
    "FULL",
    ["manager"],
  );
  // مرآة deliveryCashierProcedure بما فيها المنح الصريح.
  const canSettle = !!role && moduleAccessAllowed(role, override, "store", "FULL", ["cashier", "manager"]);
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

      {canReviewWriteOff && (
        <WriteOffApprovalQueue
          userId={Number(me.data?.id ?? 0)}
          onChanged={() => {
            void utils.delivery.listParties.invalidate();
            void utils.delivery.listWriteOffRequests.invalidate();
          }}
        />
      )}

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
            { key: "deliveredUncollectedAmount", header: "سُلِّم لم يُحصَّل", money: true, map: (r) => (r as { deliveredUncollectedAmount?: string }).deliveredUncollectedAmount ?? "0" },
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
                  <th className="p-3 text-left" title="طرد سُلِّم للزبون بلا قبضٍ كامل — خطر أعلى">سُلِّم لم يُحصَّل</th>
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
                      <td className="p-3 text-center">{p.isActive ? <Badge variant="secondary">نشط</Badge> : <Badge variant="outline">معطّل</Badge>}</td>
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
                              hidden: !canRequestWriteOff,
                              disabled: bal <= 0,
                              disabledReason: "لا يوجد عجز قابل للشطب",
                              onSelect: () => setWriteOffFor(p),
                              gate: { roles: ["admin"] },
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
  const [evidenceNote, setEvidenceNote] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
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
  const m = trpc.delivery.writeOff.useMutation({ onSuccess: () => { notify.ok("أُرسل طلب الشطب بانتظار اعتماد مستقل"); onDone(); }, onError: (e) => notify.err(e) });
  const effAmount = chosenRemaining != null ? chosenRemaining.toFixed(2) : amount;
  const submit = async () => {
    const ok = await confirm({
      variant: "danger",
      title: "إرسال طلب شطب عجز",
      description: chosen
        ? `سيُنشأ طلب لمراجعة شطب الإرسالية ${chosen.consignmentNumber} بقيمة ${fmt(effAmount)} د.ع. لن تُغلق الإرسالية ولن يتغير أي رصيد أو قيد قبل اعتماد مراجع توصيل مستقل ومخوّل.`
        : `سيُنشأ طلب لمراجعة شطب ${fmt(effAmount)} د.ع من العهدة السائبة لـ«${party.name}». لا أثر مالي قبل الاعتماد المستقل.`,
      confirmText: "إرسال الطلب",
      requireText: party.name,
    });
    if (ok) m.mutate({
      partyId: party.id,
      amount: effAmount,
      reason: reason.trim(),
      evidenceNote: evidenceNote.trim() || undefined,
      attachmentUrl: attachmentUrl.trim() || undefined,
      consignmentId: chosen ? chosen.id : undefined,
      clientRequestId: reqId,
    });
  };
  return (
    <Modal title={`طلب شطب عجز «${party.name}»`} onClose={onClose}>
      <p className="mb-3 text-sm text-destructive">هذا مستند طلب فقط؛ لا يتغير الرصيد ولا الإرسالية قبل اعتماد مراجع توصيل مستقل ومخوّل.</p>
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
      <Input value={reason} onChange={(e) => setReason(e.target.value)} className="mb-3 h-11" placeholder="سبب الشطب (٣ أحرف فأكثر)" />
      <label className="mb-1.5 block text-sm font-bold">وصف الإثبات</label>
      <Input value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} className="mb-3 h-11" placeholder="محضر فقد/مطابقة أو مرجع المراجعة" />
      <label className="mb-1.5 block text-sm font-bold">رابط المرفق (بديل عن الوصف)</label>
      <Input value={attachmentUrl} onChange={(e) => setAttachmentUrl(e.target.value)} className="mb-4 h-11" placeholder="https://..." dir="ltr" />
      <div className="flex gap-2.5">
        <Button variant="outline" className="flex-1" onClick={onClose}>إلغاء</Button>
        <Button className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={m.isPending || !/^\d+(\.\d{1,2})?$/.test(effAmount) || Number(effAmount) <= 0 || reason.trim().length < 3 || (!evidenceNote.trim() && !attachmentUrl.trim())} onClick={submit}>{m.isPending ? "جارٍ…" : "إرسال طلب الشطب"}</Button>
      </div>
    </Modal>
  );
}

function WriteOffApprovalQueue({ userId, onChanged }: { userId: number; onChanged: () => void }) {
  const pending = trpc.delivery.listWriteOffRequests.useQuery({ status: "PENDING" });
  const [rejectReasons, setRejectReasons] = useState<Record<number, string>>({});
  const approve = trpc.delivery.approveWriteOffRequest.useMutation({
    onSuccess: () => { notify.ok("اعتُمد طلب الشطب وطُبّق الأثر ذرّياً"); onChanged(); },
    onError: (e) => notify.err(e),
  });
  const reject = trpc.delivery.rejectWriteOffRequest.useMutation({
    onSuccess: () => { notify.ok("رُفض طلب الشطب بلا أثر مالي"); onChanged(); },
    onError: (e) => notify.err(e),
  });
  const rows = pending.data ?? [];
  return (
    <section className="rounded-xl border bg-card p-4" aria-label="طلبات شطب عهدة COD المعلقة">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold"><ShieldCheck className="size-4" aria-hidden /> مراجعة طلبات الشطب</h2>
          <p className="text-xs text-muted-foreground">الطالب لا يعتمد طلبه، ومحتسب/محصل العهدة لا يراجع شطبها.</p>
        </div>
        {!pending.isError ? <Badge variant="outline">{rows.length} معلّق</Badge> : null}
      </div>
      {pending.isLoading ? (
        <p className="text-sm text-muted-foreground">جارٍ تحميل الطلبات…</p>
      ) : pending.isError ? (
        <ErrorState onRetry={() => void pending.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">لا طلبات شطب معلقة.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const own = Number(row.requestedBy) === userId;
            const reason = rejectReasons[Number(row.id)] ?? "";
            return (
              <article key={row.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-bold">#{row.id} — {row.partyName} — {fmt(row.amount)} د.ع</p>
                    <p className="text-xs text-muted-foreground">{row.consignmentNumber ? `إرسالية ${row.consignmentNumber}` : "عهدة سائبة"} · الطالب: {row.requesterName}</p>
                    <p className="mt-1 text-sm">{row.reason}</p>
                    <p className="text-xs text-muted-foreground">الإثبات: {row.evidenceNote ?? row.attachmentUrl ?? "—"}</p>
                  </div>
                  {own && <Badge variant="outline">طلبك — يلزم مراجع آخر</Badge>}
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_auto]">
                  <Input
                    value={reason}
                    onChange={(e) => setRejectReasons((old) => ({ ...old, [Number(row.id)]: e.target.value }))}
                    placeholder="سبب الرفض (عند الرفض)"
                    disabled={own}
                  />
                  <Button
                    size="sm"
                    disabled={own || approve.isPending || reject.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        variant: "danger",
                        title: `اعتماد طلب الشطب #${row.id}`,
                        description: `سيُطبّق الشطب بقيمة ${fmt(row.amount)} د.ع الآن داخل معاملة واحدة بعد إعادة مطابقة النسخة وفصل المهام.`,
                        confirmText: "اعتماد وتطبيق",
                      });
                      if (ok) approve.mutate({
                        id: Number(row.id),
                        expectedVersion: Number(row.basePartyVersion),
                        decisionKey: `writeoff-approve-${row.id}-${userId}`,
                      });
                    }}
                  >
                    <ShieldCheck className="size-4" aria-hidden /> اعتماد
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    disabled={own || reason.trim().length < 3 || approve.isPending || reject.isPending}
                    onClick={() => reject.mutate({
                      id: Number(row.id),
                      expectedVersion: Number(row.basePartyVersion),
                      decisionKey: `writeoff-reject-${row.id}-${userId}`,
                      reason: reason.trim(),
                    })}
                  >
                    <XCircle className="size-4" aria-hidden /> رفض
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
