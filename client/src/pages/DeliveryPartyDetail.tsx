// لوحة تفاصيل جهة التوصيل (٩/٨) — تُفتح من شاشة «جهات التوصيل» بلا مسار مستقل.
//
// كانت الجهة سطراً واحداً (رصيد + عدّادات) وكشفها «طباعةً فقط»؛ سؤال «أي فواتير عند
// المندوب الآن ومتى آخر توريد؟» كان بلا شاشة تجيبه — endpoint الإرساليات موجود خادمياً
// وغير مستهلَك، والتوريدات بلا سجل أصلاً. هنا الخيط كاملاً: إرساليات (بفواتيرها روابط)
// → توريدات → كشف حساب حيّ (يشمل أمانات الأجرة التي كان الكشف المطبوع يُسقطها صامتاً)
// → بيانات الجهة وتعديلها (سقف العهدة كان غير قابل للضبط من أي شاشة = حارس ميت).
import { useEffect, useMemo, useState } from "react";
import { Banknote, PackageOpen, Printer, Truck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { EmptyState } from "@/components/EmptyState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printDeliveryPartyStmt } from "@/lib/printing/printTemplates";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

type PartyRow = RouterOutputs["delivery"]["listParties"][number];
type StatementEntry = NonNullable<RouterOutputs["delivery"]["partyStatement"]>["entries"][number];

const CN_STATUS: Record<string, { label: string; cls: string }> = {
  NOT_APPLICABLE: { label: "لا تحصيل", cls: "bg-muted text-muted-foreground" },
  UNSETTLED: { label: "غير مورّد", cls: "badge-stock-low" },
  DISPATCHED: { label: "غير مسوّاة", cls: "badge-stock-low" },
  PARTIAL: { label: "سُوّيت جزئياً", cls: "badge-stock-low" },
  SETTLED: { label: "مسوّاة", cls: "badge-status-active" },
  CANCELLED: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
  DELIVERED: { label: "مسوّاة", cls: "badge-status-active" },
  RETURNED: { label: "أُرجعت", cls: "bg-muted text-muted-foreground" },
  WRITTEN_OFF: { label: "شُطبت", cls: "badge-stock-out" },
};

const PARCEL_STATUS: Record<string, string> = {
  ASSIGNED: "مسند",
  ACCEPTED: "مقبول",
  PICKED_UP: "استلمه السائق",
  OUT_FOR_DELIVERY: "خرج للتوصيل",
  DELIVERED: "وصل العميل",
  FAILED: "تعذر التوصيل",
  RETURNED: "مرتجع",
};

const tabBtn = (active: boolean) =>
  cn(
    "rounded-lg px-3.5 py-1.5 text-sm font-bold transition-colors",
    active ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-muted/60",
  );

/** يبني صفوف الكشف بالرصيد الجاري (Decimal لا Number العائم) — يشمل FEE/FEE_HELD كصفوف
 *  إفصاح خارج الرصيد (الرصيد = DISPATCH − REMIT − WRITEOFF، نفس صيغة reconcileDeliveryFloat). */
function buildStatementRows(entries: StatementEntry[]) {
  let bal = D(0);
  let totDispatch = D(0), totSettled = D(0), totFees = D(0), heldNet = D(0);
  const rows: {
    id: number; date: string; ref: string; description: string;
    debit: string | null; credit: string | null; balance: string | null;
    /** الرصيد الجاري لحظة الصفّ — للطباعة (صفوف الإفصاح لا تغيّره لكن القالب يطبع عموده دائماً). */
    carry: string; info?: boolean;
  }[] = [];
  for (const e of entries) {
    const amt = D(e.amount);
    const date = fmtDate(e.entryDate);
    const ref = e.invoiceNumber ?? (e.notes ?? "").match(/[A-Z]{2,6}-[A-Za-z0-9-]+/)?.[0] ?? "—";
    if (e.type === "DELIVERY_DISPATCH") {
      bal = bal.plus(amt); totDispatch = totDispatch.plus(amt);
      rows.push({ id: e.id, date, ref, description: "إرسالية (عهدة COD)", debit: amt.toFixed(2), credit: null, balance: bal.toFixed(2), carry: bal.toFixed(2) });
    } else if (e.type === "DELIVERY_REMIT") {
      bal = bal.minus(amt); totSettled = totSettled.plus(amt);
      rows.push({ id: e.id, date, ref, description: e.notes?.includes("تسوية") ? "تسوية نقدية" : "توريد", debit: null, credit: amt.toFixed(2), balance: bal.toFixed(2), carry: bal.toFixed(2) });
    } else if (e.type === "DELIVERY_WRITEOFF") {
      bal = bal.minus(amt); totSettled = totSettled.plus(amt);
      const recovery = amt.lt(0);
      rows.push({
        id: e.id, date, ref,
        description: recovery ? "عكس شطب (استرداد نقدي)" : "شطب عجز",
        debit: recovery ? amt.neg().toFixed(2) : null,
        credit: recovery ? null : amt.toFixed(2),
        balance: bal.toFixed(2), carry: bal.toFixed(2),
      });
    } else if (e.type === "DELIVERY_FEE") {
      totFees = totFees.plus(amt);
      rows.push({ id: e.id, date, ref, description: "أجرة توصيل (على المكتبة)", debit: null, credit: amt.toFixed(2), balance: null, carry: bal.toFixed(2), info: true });
    } else if (e.type === "DELIVERY_FEE_HELD") {
      heldNet = heldNet.plus(amt);
      rows.push({
        id: e.id, date, ref,
        description: amt.gte(0) ? "أمانة أجرة — قُبضت في الدرج" : "أمانة أجرة — صُرفت/رُدَّت",
        debit: null, credit: amt.abs().toFixed(2), balance: null, carry: bal.toFixed(2), info: true,
      });
    }
  }
  return { rows, totDispatch, totSettled, totFees, heldNet, closing: bal };
}

export default function DeliveryPartyDetail({ party, onClose, onChanged }: {
  party: PartyRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = trpc.auth.me.useQuery();
  const isManager = ["admin", "manager"].includes(me.data?.role ?? "");
  // مرآة بوّابة الخادم storeManagerProcedure (store=FULL على manager) — لا قائمة أدوار خام:
  // مدير سُحبت منه store لا يرى لوحةً سيرفضها الخادم، ودورٌ مُنح store:FULL صراحةً يراها.
  const canRecover = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? undefined) as PermissionMap | undefined,
    "store",
    "FULL",
    ["manager"],
  );
  const [tab, setTab] = useState<"consignments" | "remittances" | "statement" | "members" | "settings">("consignments");

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm md:p-8" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-2xl bg-background p-4 shadow-2xl md:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-extrabold">
              <Truck aria-hidden className="size-5 text-primary" />
              {party.name}
              <Badge variant="secondary">{party.partyType === "COMPANY" ? "شركة توصيل" : "مندوب"}</Badge>
              {!party.isActive && <Badge variant="outline">معطّل</Badge>}
            </h2>
            {party.phone && <div className="mt-1 text-xs text-muted-foreground" dir="ltr">{party.phone}</div>}
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-lg border px-3 py-1.5 text-sm">
              <span className="text-muted-foreground">نقد بذمّتها: </span>
              <b className={cn("tabular-nums", Number(party.currentBalance) > 0 ? "text-destructive" : "")} dir="ltr">{fmt(party.currentBalance)} د.ع</b>
            </div>
            <StoreInTransitChip partyId={party.id} />
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="إغلاق"><X aria-hidden className="size-4" /></Button>
          </div>
        </div>

        <PartyFinancialSummary partyId={party.id} />

        <div className="mb-4 flex flex-wrap gap-2">
          <button className={tabBtn(tab === "consignments")} onClick={() => setTab("consignments")}>الإرساليات والفواتير</button>
          <button className={tabBtn(tab === "remittances")} onClick={() => setTab("remittances")}>سجل التوريدات</button>
          <button className={tabBtn(tab === "statement")} onClick={() => setTab("statement")}>كشف الحساب</button>
          <button className={tabBtn(tab === "members")} onClick={() => setTab("members")}>حسابات الشركة والمندوبين</button>
          <button className={tabBtn(tab === "settings")} onClick={() => setTab("settings")}>بيانات الجهة</button>
        </div>

        {tab === "consignments" && <ConsignmentsTab partyId={party.id} canEdit={isManager} />}
        {tab === "remittances" && <RemittancesTab partyId={party.id} />}
        {tab === "statement" && <StatementTab party={party} />}
        {tab === "members" && <PartyMembersTab partyId={party.id} canEdit={isManager} />}
        {tab === "settings" && <SettingsTab party={party} isManager={isManager} canRecover={canRecover} onChanged={onChanged} />}
      </div>
    </div>
  );
}

/** طرود متجر «مع المندوب» لم تُؤكَّد بعد (١٠/٨): عهدة المتجر تُرفع عند التأكيد لا الإرسال —
 *  ما بيده فعلياً كان غير ظاهر في أي عهدة أو كشف. */
function PartyFinancialSummary({ partyId }: { partyId: number }) {
  const q = trpc.delivery.partyFinancials.useQuery({ partyId }, { staleTime: 15_000 });
  const s = q.data?.summary;
  if (!s) return null;
  const cells = [
    ["COD مطلوب تحصيله", s.codOutstanding],
    ["COD حُصّل", s.codCollected],
    ["COD وُرّد", s.codRemitted],
    ["نقد بذمة الجهة", s.cashInCustody],
    ["أجرة مكتسبة", s.feeEarned],
    ["أجرة مستحقة", s.feeDue],
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
      {cells.map(([label, value]) => (
        <div key={label} className="rounded-xl border bg-card p-3">
          <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
          <div className="mt-1 font-extrabold tabular-nums" dir="ltr">{fmt(value)} د.ع</div>
        </div>
      ))}
    </div>
  );
}

function PartyMembersTab({ partyId, canEdit }: { partyId: number; canEdit: boolean }) {
  const members = trpc.delivery.partyMembers.useQuery({ partyId });
  const accounts = trpc.delivery.courierAccounts.useQuery(undefined, { enabled: canEdit });
  const utils = trpc.useUtils();
  const [userId, setUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"DRIVER" | "MANAGER" | "ACCOUNTANT">("DRIVER");
  const refresh = () => {
    void utils.delivery.partyMembers.invalidate({ partyId });
    void utils.delivery.courierAccounts.invalidate();
  };
  const addM = trpc.delivery.addPartyMember.useMutation({
    onSuccess: () => { notify.ok("تم ربط الحساب بالجهة"); setUserId(""); refresh(); },
    onError: (e) => notify.err(e),
  });
  const removeM = trpc.delivery.removePartyMember.useMutation({
    onSuccess: () => { notify.ok("تم إيقاف العضوية"); refresh(); },
    onError: (e) => notify.err(e),
  });
  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-[1fr_180px_auto]">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className="rounded-lg border bg-background px-3 py-2 text-sm">
            <option value="">اختر حساب دخول نشطاً</option>
            {(accounts.data ?? []).filter((a) => a.linkedPartyId == null || Number(a.linkedPartyId) === partyId).map((a) => (
              <option key={a.id} value={a.id}>{a.name} {a.username ? `(${a.username})` : ""}</option>
            ))}
          </select>
          <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as typeof memberRole)} className="rounded-lg border bg-background px-3 py-2 text-sm">
            <option value="DRIVER">سائق</option>
            <option value="MANAGER">مدير الشركة</option>
            <option value="ACCOUNTANT">محاسب الشركة</option>
          </select>
          <Button disabled={!userId || addM.isPending} onClick={() => addM.mutate({ partyId, userId: Number(userId), memberRole })}>إضافة الحساب</Button>
        </div>
      )}
      <div className="divide-y rounded-xl border bg-card">
        {(members.data ?? []).map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div>
              <b>{m.name ?? m.username ?? `#${m.userId}`}</b>
              <span className="ms-2 text-xs text-muted-foreground">{m.memberRole === "DRIVER" ? "سائق" : m.memberRole === "MANAGER" ? "مدير" : "محاسب"}</span>
              {!m.isActive && <span className="ms-2 text-xs text-destructive">موقوف</span>}
            </div>
            {canEdit && m.isActive && <Button variant="outline" size="sm" disabled={removeM.isPending} onClick={() => removeM.mutate({ partyId, userId: Number(m.userId) })}>إزالة</Button>}
          </div>
        ))}
        {!members.isLoading && (members.data?.length ?? 0) === 0 && <div className="p-6 text-center text-sm text-muted-foreground">لا توجد حسابات مرتبطة.</div>}
      </div>
    </div>
  );
}

function StoreInTransitChip({ partyId }: { partyId: number }) {
  const q = trpc.delivery.storeInTransit.useQuery({ partyId }, { staleTime: 30_000 });
  if (!q.data || q.data.count === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-3 py-1.5 text-sm" title="طلبات متجر مُرسَلة معه لم يؤكَّد تسليمها — قيمتها ليست ضمن «نقد بذمّتها» بعد (تُضاف عند تأكيد التسليم)">
      <span className="text-[var(--sem-warn)] font-bold">طرود متجر بالطريق: {q.data.count}</span>
      <b className="ms-1.5 tabular-nums text-[var(--sem-warn)]" dir="ltr">{fmt(q.data.value)} د.ع</b>
    </div>
  );
}

// ───────────────────────── الإرساليات والفواتير ─────────────────────────
function ConsignmentsTab({ partyId, canEdit }: { partyId: number; canEdit: boolean }) {
  const [openOnly, setOpenOnly] = useState(false);
  const q = trpc.delivery.consignments.useQuery({ partyId, openOnly });
  const members = trpc.delivery.partyMembers.useQuery({ partyId });
  const utils = trpc.useUtils();
  const reassignM = trpc.delivery.reassignConsignment.useMutation({
    onSuccess: () => { notify.ok("تم تحديث إسناد الطرد"); void utils.delivery.consignments.invalidate({ partyId }); },
    onError: (e) => notify.err(e),
  });
  const list = q.data ?? [];
  const drivers = (members.data ?? []).filter((m) => m.isActive && m.memberRole === "DRIVER");
  return (
    <div className="space-y-3">
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
        المالية المفتوحة فقط (غير مسوّاة / مسوّاة جزئياً)
      </label>
      {q.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : list.length === 0 ? (
        <EmptyState icon={PackageOpen} title="لا إرساليات" description="لم تُسنَد لهذه الجهة إرساليات بعد." />
      ) : (
        <ScrollTableShell className="bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-2.5 text-right">الإرسالية</th>
                <th className="p-2.5 text-right">الفاتورة</th>
                <th className="p-2.5 text-right">العميل/المستلم</th>
                <th className="p-2.5 text-left">COD</th>
                <th className="p-2.5 text-left">المُحصَّل</th>
                <th className="p-2.5 text-left">المتبقّي</th>
                <th className="p-2.5 text-center">حالة التسوية</th>
                <th className="p-2.5 text-center">التسليم للعميل</th>
                <th className="p-2.5 text-right">السائق والحركة</th>
                <th className="p-2.5 text-right">أُرسلت</th>
                <th className="p-2.5 text-right">التوريد</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const remaining = Math.max(0, Number(c.codAmount) - Number(c.collectedAmount));
                const st = CN_STATUS[c.moneyStatus] ?? { label: c.moneyStatus, cls: "bg-muted" };
                return (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-2.5 font-mono text-xs" dir="ltr">{c.consignmentNumber}</td>
                    <td className="p-2.5">
                      {c.invoiceId ? (
                        <a className="font-mono text-xs text-primary hover:underline" dir="ltr" href={`/invoices/${c.invoiceId}`}>
                          {c.invoiceNumber ?? `#${c.invoiceId}`}
                        </a>
                      ) : "—"}
                    </td>
                    <td className="p-2.5">{c.customerName ?? c.recipientName ?? "عميل نقدي"}</td>
                    <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmt(c.codAmount)}</td>
                    <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmt(c.collectedAmount)}</td>
                    <td className={cn("p-2.5 text-left tabular-nums font-bold", remaining > 0 ? "text-destructive" : "")} dir="ltr">{fmt(String(remaining))}</td>
                    <td className="p-2.5 text-center">
                      <span className={cn("rounded px-2 py-0.5 text-xs font-bold", st.cls)}>{st.label}</span>
                    </td>
                    <td className="p-2.5 text-center text-xs">
                      <Badge variant={c.parcelStatus === "DELIVERED" ? "success" : c.parcelStatus === "FAILED" ? "danger" : "info"}>
                        {PARCEL_STATUS[c.parcelStatus] ?? c.parcelStatus}
                      </Badge>
                      {c.courierDeliveredAt && <div className="mt-1 text-money-positive">{fmtDate(c.courierDeliveredAt)}</div>}
                    </td>
                    <td className="min-w-48 p-2.5 text-xs">
                      <div className="mb-1">{c.assignedUserName ?? "طابور الشركة المشترك"}</div>
                      {c.failureReason && <div className="mb-1 text-destructive">{c.failureReason}</div>}
                      {canEdit && (c.parcelStatus === "ASSIGNED" || c.parcelStatus === "FAILED") && (
                        <select
                          value={c.assignedUserId ?? ""}
                          disabled={reassignM.isPending}
                          onChange={(e) => reassignM.mutate({
                            partyId,
                            consignmentId: Number(c.id),
                            assignedUserId: e.target.value ? Number(e.target.value) : null,
                            clientRequestId: crypto.randomUUID(),
                          })}
                          className="w-full rounded-md border bg-background px-2 py-1"
                        >
                          <option value="">مشترك لكل السائقين</option>
                          {drivers.map((d) => <option key={d.userId} value={d.userId}>{d.name ?? d.username ?? `#${d.userId}`}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="p-2.5 text-xs text-muted-foreground">{c.dispatchedAt ? fmtDate(c.dispatchedAt) : "—"}</td>
                    <td className="p-2.5 text-xs">
                      {c.remittanceNumber ? <span className="font-mono" dir="ltr">{c.remittanceNumber}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTableShell>
      )}
    </div>
  );
}

// ───────────────────────── سجل التوريدات ─────────────────────────
function RemittancesTab({ partyId }: { partyId: number }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = trpc.delivery.remittances.useQuery({ partyId, from: from || undefined, to: to || undefined });
  const list = q.data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="inline-flex items-center gap-1.5">من <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" /></label>
        <label className="inline-flex items-center gap-1.5">إلى <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" /></label>
      </div>
      {q.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : list.length === 0 ? (
        <EmptyState icon={Banknote} title="لا توريدات" description="لم تُسجَّل توريدات لهذه الجهة في الفترة." />
      ) : (
        <ScrollTableShell className="bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-2.5 text-right">رقم التوريد</th>
                <th className="p-2.5 text-right">التاريخ</th>
                <th className="p-2.5 text-left">المُحصَّل</th>
                <th className="p-2.5 text-left">الأجور</th>
                <th className="p-2.5 text-left">الصافي المورَّد</th>
                <th className="p-2.5 text-left">عجز بقي عهدة</th>
                <th className="p-2.5 text-center">الحالة</th>
                <th className="p-2.5 text-right">استلمه</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="p-2.5 font-mono text-xs" dir="ltr">{r.remittanceNumber}</td>
                  <td className="p-2.5 text-xs">{fmtDateTime(r.receivedAt)}</td>
                  <td className="p-2.5 text-left tabular-nums" dir="ltr">{fmt(r.collectedTotal)}</td>
                  <td className="p-2.5 text-left tabular-nums text-[var(--sem-warn)]" dir="ltr">{Number(r.feesTotal) > 0 ? `−${fmt(r.feesTotal)}` : "—"}</td>
                  <td className="p-2.5 text-left tabular-nums font-bold" dir="ltr">{fmt(r.netRemitted)}</td>
                  <td className={cn("p-2.5 text-left tabular-nums", Number(r.shortfallTotal) > 0 ? "font-bold text-destructive" : "text-muted-foreground")} dir="ltr">
                    {Number(r.shortfallTotal) > 0 ? fmt(r.shortfallTotal) : "—"}
                  </td>
                  <td className="p-2.5 text-center">
                    <span className={cn("rounded px-2 py-0.5 text-xs font-bold",
                      r.status === "BALANCED" ? "badge-status-active" : r.status === "SHORT" ? "badge-stock-out" : "badge-stock-low")}>
                      {r.status === "BALANCED" ? "مطابق" : r.status === "SHORT" ? "بعجز" : "بزيادة"}
                    </span>
                  </td>
                  <td className="p-2.5 text-xs">{r.receivedByName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTableShell>
      )}
    </div>
  );
}

// ───────────────────────── كشف الحساب ─────────────────────────
function StatementTab({ party }: { party: PartyRow }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = trpc.delivery.partyStatement.useQuery({ partyId: party.id, from: from || undefined, to: to || undefined });
  const built = useMemo(() => (q.data ? buildStatementRows(q.data.entries) : null), [q.data]);

  const print = () => {
    if (!q.data || !built) return;
    const filtered = Boolean(from || to);
    printDeliveryPartyStmt({
      partyName: q.data.party.name,
      partyType: q.data.party.partyType === "COMPANY" ? "شركة توصيل" : "مندوب",
      partyPhone: q.data.party.phone ?? undefined,
      fromDate: from || undefined,
      toDate: to || undefined,
      transactions: built.rows.map((r) => ({
        date: r.date, ref: r.ref, description: r.description,
        debit: r.debit, credit: r.credit,
        // صفوف الإفصاح (أجور/أمانات) لا تغيّر العهدة — تطبع الرصيد الجاري لحظتها لا «0.00».
        balance: r.balance ?? r.carry,
      })),
      totalDispatched: built.totDispatch.toFixed(2),
      totalSettled: built.totSettled.toFixed(2),
      totalFees: built.totFees.toFixed(2),
      // كشفٌ بفترة مفلترة يُختم برصيد **الفترة** (جدوله يبدأ من صفر) لا بالرصيد الحيّ الكامل —
      // وإلا حمل المستند الورقي رقمين لا يفسّر أحدهما الآخر (مراجعة عدائية ٩/٨).
      closingBalance: filtered ? built.closing.toFixed(2) : q.data.currentBalance,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5">من <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" /></label>
          <label className="inline-flex items-center gap-1.5">إلى <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" /></label>
        </div>
        <Button variant="outline" size="sm" onClick={print} disabled={!built}>
          <Printer aria-hidden className="size-3.5" /> طباعة الكشف
        </Button>
      </div>
      {q.isLoading ? (
        <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>
      ) : !built || built.rows.length === 0 ? (
        <EmptyState icon={Banknote} title="لا حركات" description="لا قيود توصيل لهذه الجهة في الفترة." />
      ) : (
        <>
          <ScrollTableShell className="bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-2.5 text-right">التاريخ</th>
                  <th className="p-2.5 text-right">المرجع</th>
                  <th className="p-2.5 text-right">البيان</th>
                  <th className="p-2.5 text-left">مدين (عهدة+)</th>
                  <th className="p-2.5 text-left">دائن (توريد/شطب)</th>
                  <th className="p-2.5 text-left">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {built.rows.map((r) => (
                  <tr key={r.id} className={cn("border-b last:border-0", r.info && "bg-muted/20 text-muted-foreground")}>
                    <td className="p-2.5 text-xs">{r.date}</td>
                    <td className="p-2.5 font-mono text-xs" dir="ltr">{r.ref}</td>
                    <td className="p-2.5">{r.description}</td>
                    <td className="p-2.5 text-left tabular-nums" dir="ltr">{r.debit ? fmt(r.debit) : "—"}</td>
                    <td className="p-2.5 text-left tabular-nums" dir="ltr">{r.credit ? fmt(r.credit) : "—"}</td>
                    <td className="p-2.5 text-left tabular-nums font-bold" dir="ltr">{r.balance ? fmt(r.balance) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTableShell>
          <div className="grid gap-2 rounded-xl border bg-card p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><span className="text-muted-foreground">إجمالي الإرساليات: </span><b className="tabular-nums" dir="ltr">{fmt(built.totDispatch.toFixed(2))}</b></div>
            <div><span className="text-muted-foreground">إجمالي التوريد/التسوية: </span><b className="tabular-nums" dir="ltr">{fmt(built.totSettled.toFixed(2))}</b></div>
            <div><span className="text-muted-foreground">أجور على المكتبة: </span><b className="tabular-nums" dir="ltr">{fmt(built.totFees.toFixed(2))}</b></div>
            <div>
              <span className="text-muted-foreground">أمانات أجرة معلّقة (Σ): </span>
              <b className={cn("tabular-nums", !built.heldNet.isZero() && "text-destructive")} dir="ltr">{fmt(built.heldNet.toFixed(2))}</b>
            </div>
          </div>
          {/* رصيد الفترة قد يخالف الرصيد الجاري حين تُفلتر فترة جزئية — نُفصح لا نموّه. */}
          <div className="text-xs text-muted-foreground">
            الرصيد الجاري الفعلي للجهة الآن: <b className="tabular-nums" dir="ltr">{fmt(q.data?.currentBalance ?? "0")}</b> د.ع
            {(from || to) && " — الجدول أعلاه محصور بالفترة المختارة."}
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────── بيانات الجهة ─────────────────────────
function SettingsTab({ party, isManager, canRecover, onChanged }: { party: PartyRow; isManager: boolean; canRecover: boolean; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const full = trpc.delivery.getParty.useQuery({ id: party.id });
  const accounts = trpc.delivery.courierAccounts.useQuery(undefined, { enabled: isManager });
  const [form, setForm] = useState<{
    name: string; phone: string; phone2: string; defaultFee: string; floatLimit: string;
    nationalId: string; vehicleInfo: string; notes: string; userId: number | null;
  } | null>(null);
  // تهيئة النموذج من الجلب الكامل مرّة واحدة (getParty يحمل الحقول التي لا تعيدها listParties).
  useEffect(() => {
    if (full.data && form === null) {
      setForm({
        name: full.data.name ?? "",
        phone: full.data.phone ?? "",
        phone2: full.data.phone2 ?? "",
        defaultFee: String(full.data.defaultFee ?? "0"),
        floatLimit: full.data.floatLimit != null ? String(full.data.floatLimit) : "",
        nationalId: full.data.nationalId ?? "",
        vehicleInfo: full.data.vehicleInfo ?? "",
        notes: full.data.notes ?? "",
        userId: full.data.userId != null ? Number(full.data.userId) : null,
      });
    }
  }, [full.data, form]);
  const update = trpc.delivery.updateParty.useMutation({
    onSuccess: () => { notify.ok("حُفظت بيانات الجهة"); utils.delivery.getParty.invalidate({ id: party.id }); onChanged(); },
    onError: (e) => notify.err(e),
  });
  const setActive = trpc.delivery.setPartyActive.useMutation({
    onSuccess: () => { notify.ok("حُدِّثت حالة الجهة"); onChanged(); },
    onError: (e) => notify.err(e),
  });
  const [recoverAmount, setRecoverAmount] = useState("");
  const [recoverNotes, setRecoverNotes] = useState("");
  // مفتاح idempotency ثابت أثناء المحاولة الواحدة، **يتجدّد بعد كل نجاح** — استردادٌ ثانٍ
  // بنفس المبلغ (دفعتان متساويتان) كان يُبتلع replay صامتاً بتوست نجاحٍ كاذب (مراجعة ٩/٨).
  const [recoverReqId, setRecoverReqId] = useState(() => crypto.randomUUID());
  const recover = trpc.delivery.recoverWriteOff.useMutation({
    onSuccess: (r) => {
      notify.ok("سُجِّل الاسترداد", `دخل الدرج ${fmt((r as { recovered?: string }).recovered ?? recoverAmount)} د.ع وعُكست الخسارة`);
      setRecoverAmount(""); setRecoverNotes(""); setRecoverReqId(crypto.randomUUID()); onChanged();
    },
    onError: (e) => notify.err(e),
  });

  if (!form) return <div className="p-8 text-center text-muted-foreground">جارٍ التحميل…</div>;
  const moneyOk = (v: string) => /^\d+(\.\d{1,2})?$/.test(v);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 font-extrabold">تعديل البيانات {!isManager && <span className="text-xs font-normal text-muted-foreground">(للمدير فقط)</span>}</h3>
        <fieldset disabled={!isManager} className="space-y-2.5">
          <label className="block text-sm font-bold">الاسم
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 h-10" />
          </label>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block text-sm font-bold">الهاتف
              <IntlPhoneInput value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} ariaLabel="هاتف الجهة" />
            </label>
            <label className="block text-sm font-bold">هاتف ٢
              <IntlPhoneInput value={form.phone2} onChange={(v) => setForm({ ...form, phone2: v })} ariaLabel="هاتف الجهة الثاني" />
            </label>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block text-sm font-bold">أجرة افتراضية (د.ع)
              <MoneyInput value={form.defaultFee} onChange={(v) => setForm({ ...form, defaultFee: v })} className="mt-1 h-10 text-end tabular-nums" ariaLabel="الأجرة الافتراضية" />
            </label>
            <label className="block text-sm font-bold">سقف العهدة (د.ع — فارغ = بلا حدّ)
              <MoneyInput value={form.floatLimit} onChange={(v) => setForm({ ...form, floatLimit: v })} className="mt-1 h-10 text-end tabular-nums" ariaLabel="سقف العهدة" />
            </label>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block text-sm font-bold">رقم الهوية
              <Input value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} className="mt-1 h-10" />
            </label>
            <label className="block text-sm font-bold">المركبة
              <Input value={form.vehicleInfo} onChange={(e) => setForm({ ...form, vehicleInfo: e.target.value })} className="mt-1 h-10" placeholder="نوع/لون/رقم اللوحة" />
            </label>
          </div>
          <label className="block text-sm font-bold">ملاحظات
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="mt-1 h-10" />
          </label>
          <label className="block text-sm font-bold">حساب بوابة الجهة
            <select
              className="mt-1 h-10 w-full rounded-md border bg-transparent px-3 text-sm"
              value={form.userId ?? ""}
              onChange={(e) => setForm({ ...form, userId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">بلا حساب دخول</option>
              {(accounts.data ?? [])
                .filter((a) => a.linkedPartyId == null || a.linkedPartyId === party.id)
                .map((a) => <option key={a.id} value={a.id}>{a.name}{a.username ? ` (${a.username})` : ""}</option>)}
            </select>
            <span className="mt-1 block text-xs font-normal text-muted-foreground">ربط أو تغيير الحساب ممنوع تلقائياً إذا كان سيُخفي إرساليات مفتوحة عن مستخدم قائم.</span>
          </label>
          <div className="flex gap-2 pt-1">
            <Button
              className="flex-1"
              disabled={update.isPending || !form.name.trim() || !moneyOk(form.defaultFee) || (form.floatLimit !== "" && !moneyOk(form.floatLimit))}
              onClick={() => update.mutate({
                id: party.id,
                name: form.name.trim(),
                phone: form.phone || null,
                phone2: form.phone2 || null,
                defaultFee: form.defaultFee,
                floatLimit: form.floatLimit === "" ? null : form.floatLimit,
                nationalId: form.nationalId || null,
                vehicleInfo: form.vehicleInfo || null,
                notes: form.notes || null,
                userId: form.userId,
              })}
            >{update.isPending ? "جارٍ…" : "حفظ"}</Button>
            <Button
              variant="outline"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate({ id: party.id, isActive: !party.isActive })}
            >{party.isActive ? "تعطيل الجهة" : "تفعيل الجهة"}</Button>
          </div>
        </fieldset>
      </div>

      {canRecover && (
        <div className="rounded-xl border bg-card p-4">
          <h3 className="mb-1 font-extrabold">استرداد عجز مشطوب</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            المندوب أعاد نقداً سبق شطبُه خسارةً: يدخل النقد الدرج وتُعكس الخسارة من الأرباح.
            السقف = صافي الخسارة المشطوبة تاريخياً لهذه الجهة (لا يشمل تصفية العهدة الزائدة عن الفاتورة).
          </p>
          <label className="block text-sm font-bold">المبلغ المسترَدّ (د.ع)
            <MoneyInput value={recoverAmount} onChange={setRecoverAmount} className="mt-1 h-10 text-end tabular-nums" ariaLabel="مبلغ الاسترداد" />
          </label>
          <label className="mt-2.5 block text-sm font-bold">ملاحظة
            <Input value={recoverNotes} onChange={(e) => setRecoverNotes(e.target.value)} className="mt-1 h-10" placeholder="اختياري" />
          </label>
          <Button
            className="mt-3 w-full"
            disabled={recover.isPending || !moneyOk(recoverAmount) || Number(recoverAmount) <= 0}
            onClick={() => recover.mutate({ partyId: party.id, amount: recoverAmount, notes: recoverNotes || null, clientRequestId: recoverReqId })}
          >{recover.isPending ? "جارٍ…" : "تسجيل الاسترداد"}</Button>
        </div>
      )}
    </div>
  );
}
