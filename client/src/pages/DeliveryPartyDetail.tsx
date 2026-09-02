// لوحة تفاصيل جهة التوصيل (٩/٨) — تُفتح من شاشة «جهات التوصيل» بلا مسار مستقل.
//
// كانت الجهة سطراً واحداً (رصيد + عدّادات) وكشفها «طباعةً فقط»؛ سؤال «أي فواتير عند
// المندوب الآن ومتى آخر توريد؟» كان بلا شاشة تجيبه — endpoint الإرساليات موجود خادمياً
// وغير مستهلَك، والتوريدات بلا سجل أصلاً. هنا الخيط كاملاً: إرساليات (بفواتيرها روابط)
// → توريدات → كشف حساب حيّ (يشمل أمانات الأجرة التي كان الكشف المطبوع يُسقطها صامتاً)
// → بيانات الجهة وتعديلها (سقف العهدة كان غير قابل للضبط من أي شاشة = حارس ميت).
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Banknote, PackageOpen, Printer, Truck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { EmptyState } from "@/components/EmptyState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { printDeliveryPartyStmt } from "@/lib/printing/printTemplates";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { ACTION_LABELS } from "@shared/actionLabels";

type PartyRow = RouterOutputs["delivery"]["listParties"][number];
type StatementEntry = NonNullable<RouterOutputs["delivery"]["partyStatement"]>["entries"][number];
type ConsignmentRow = NonNullable<RouterOutputs["delivery"]["consignments"]>["rows"][number];
type RemittanceRow = RouterOutputs["delivery"]["remittances"][number];

/**
 * عمود مبلغ. `accessorFn` يُرجع النصّ المعروض (للنسخ)، و`sortingFn` رقميّ صريح بـDecimal
 * لأنّ الفرز الافتراضيّ يقارن نصّاً فيه فواصل آلاف («1,234» قبل «999») فيقلب ترتيب الذمم.
 */
function moneyCol<T>(
  id: string,
  header: string,
  get: (r: T) => string | number | null | undefined,
  display?: (r: T) => string,
  cls?: (r: T) => string | undefined,
): ColumnDef<T, unknown> {
  return {
    id,
    header,
    accessorFn: (r) => (display ? display(r) : fmt(get(r))),
    meta: { kind: "money" },
    sortDescFirst: true,
    sortingFn: (a, b) => D(get(a.original) ?? 0).cmp(D(get(b.original) ?? 0)),
    cell: ({ row }) => <span className={cls?.(row.original)}>{display ? display(row.original) : fmt(get(row.original))}</span>,
  };
}

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

/** صفُّ كشف الحساب — مشتقٌّ من بانيه فلا ينجرف عنه. */
type StatementRow = ReturnType<typeof buildStatementRows>["rows"][number];

export default function DeliveryPartyDetail({ party, onClose, onChanged }: {
  party: PartyRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const me = trpc.auth.me.useQuery();
  // مرآة بوّابة الخادم deliveryManagerProcedure (store=FULL على manager) — لا قائمة أدوار خام:
  // مدير سُحبت منه store لا يرى لوحةً سيرفضها الخادم، ودورٌ مُنح store:FULL صراحةً يراها.
  const canManageParty = !!me.data?.role && moduleAccessAllowed(
    me.data.role as RoleKey,
    (me.data.permissionsOverride ?? undefined) as PermissionMap | undefined,
    "store",
    "FULL",
    ["manager"],
  );
  const canRecover = canManageParty;
  const [tab, setTab] = useState<"consignments" | "remittances" | "statement" | "members" | "commission" | "settings">("consignments");

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm md:p-8" dir="rtl" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-2xl bg-background p-4 shadow-2xl md:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-extrabold">
              <Truck aria-hidden className="size-5 text-primary" />
              {party.name}
              <Badge variant="secondary">{party.partyType === "COMPANY" ? "شركة توصيل" : "مندوب"}</Badge>
              {!party.isActive && <Badge variant="outline">معطل</Badge>}
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
          <button className={tabBtn(tab === "commission")} onClick={() => setTab("commission")}>قاعدة العمولة</button>
          <button className={tabBtn(tab === "settings")} onClick={() => setTab("settings")}>بيانات الجهة</button>
        </div>

        {tab === "consignments" && <ConsignmentsTab partyId={party.id} canEdit={canManageParty} />}
        {tab === "remittances" && <RemittancesTab partyId={party.id} />}
        {tab === "statement" && <StatementTab party={party} />}
        {tab === "members" && <PartyMembersTab partyId={party.id} canEdit={canManageParty} />}
        {tab === "commission" && <CommissionRuleTab partyId={party.id} canEdit={canManageParty} />}
        {tab === "settings" && <SettingsTab party={party} canManage={canManageParty} canRecover={canRecover} onChanged={onChanged} />}
      </div>
    </div>
  );
}

/** طرود متجر «مع المندوب» لم تُؤكَّد بعد (١٠/٨): عهدة المتجر تُرفع عند التأكيد لا الإرسال —
 *  ما بيده فعلياً كان غير ظاهر في أي عهدة أو كشف. */
/**
 * ملخّصٌ ماليّ لجهة التوصيل — Slice DFP2 (٣١/٨/٢٦، إعادة تصميم):
 *
 * الفحص البصريّ (٣١/٨) أظهر شبكةً بستّ إحصائيّات تعرض:
 *   COD مطلوب: 500 (آخر طرد فقط!) · COD خطل: 102,500 · COD ورد: 0 · نقد بذمة: 102,500 ·
 *   **أجرة مكتسبة: 705,000** (تراكميّة تاريخيّة مضلِّلة) · **أجرة مستحقة: -1,000** (سالبة!).
 * ستّة أرقام تدّعي أنّها التعرّض، بعضها متضارب وبعضها بمعانٍ غير واضحة.
 *
 * الحلّ: أربع إحصائيّات وحيدةٌ تُطابق نموذج `partyExposure` (نقد بيده + طرود بالطريق +
 * سلَّم لم يحصَّل + أجور له) + **قسمُ الشفافيّة التاريخيّة** يعرض التراكميّات (أجرة مكتسبة
 * تاريخيّاً + قصّ صريح للسالب) بلونٍ رمادي بلا إبراز.
 *
 * التسميات كلها بلا تشكيل (شارات < 14px تتشوّه بصرياً بالتشكيل).
 */
function PartyFinancialSummary({ partyId }: { partyId: number }) {
  const q = trpc.delivery.partyFinancials.useQuery({ partyId }, { staleTime: 15_000 });
  const s = q.data?.summary;
  if (!s) return null;
  // الأربعة الرئيسة (بصريّة بارزة).
  const primary: Array<[string, string, string, string]> = [
    ["نقد بيده", s.cashInCustody, "text-[var(--sem-warn)]", "المندوب قبضه من الزبائن ولم يورّده للمكتبة بعد."],
    ["قيد التحصيل من العملاء", s.codOutstanding, "text-foreground", "المتبقّي على الطرود المفتوحة لدى العملاء (لم يقبضه المندوب بعد)."],
    ["إجمالي التوريد التاريخيّ", s.codRemitted, "text-[var(--sem-pos)]", "مجموع ما وُرِّد من هذه الجهة إلى درج المكتبة منذ بدء العمل."],
    ["أجور له الآن", s.feeDue, "text-[var(--sem-info)]", "أجورٌ تراكمت على المكتبة لم تُدفَع بعد — تُقصّ عند صفر بحكم القرار المحاسبيّ."],
  ];
  // الشفافيّة التاريخيّة (رمادية، بلا إبراز — للتقارير لا للتسوية).
  // Slice DFP2 (٣١/٨/٢٦): إن كان feeDueRaw سالباً ⇒ الجهة استقبلت زيادةً تاريخية.
  const feeDueRaw = Number((s as { feeDueRaw?: string }).feeDueRaw ?? s.feeDue);
  const showOverpaidNote = feeDueRaw < -0.01;
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {primary.map(([label, value, tone, tip]) => (
          <div key={label} className="rounded-xl border bg-card p-3" title={tip}>
            <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
            <div className={`mt-1 font-extrabold tabular-nums ${tone}`} dir="ltr">{fmt(value)} د.ع</div>
          </div>
        ))}
      </div>
      <details className="mb-4 rounded-lg border bg-muted/20 p-2 text-xs">
        <summary className="cursor-pointer font-bold text-muted-foreground">أرقامٌ تاريخيّة تراكميّة (للتقارير لا للتسوية)</summary>
        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded border bg-card p-2" title="مجموع مبالغ COD التي أُسندت للمندوب منذ بدء العمل (تاريخيّ).">
            <div className="text-[10px] text-muted-foreground">COD أسند اجمالا</div>
            <div className="tabular-nums font-bold" dir="ltr">{fmt(s.codAssigned)} د.ع</div>
          </div>
          <div className="rounded border bg-card p-2" title="مجموع ما قبضه المندوب فعلاً من الزبائن (تاريخيّ).">
            <div className="text-[10px] text-muted-foreground">COD قبض اجمالا</div>
            <div className="tabular-nums font-bold" dir="ltr">{fmt(s.codCollected)} د.ع</div>
          </div>
          <div className="rounded border bg-card p-2" title="مجموع الأجور التي اكتسبها هذا المندوب على كل طرودٍ ناجحة منذ بدء العمل.">
            <div className="text-[10px] text-muted-foreground">أجور مكتسبة تاريخيا</div>
            <div className="tabular-nums font-bold" dir="ltr">{fmt(s.feeEarned)} د.ع</div>
          </div>
          <div className="rounded border bg-card p-2" title="مجموع الأجور المدفوعة لهذا المندوب منذ بدء العمل.">
            <div className="text-[10px] text-muted-foreground">أجور مدفوعة تاريخيا</div>
            <div className="tabular-nums font-bold" dir="ltr">{fmt(s.feePaid)} د.ع</div>
          </div>
        </div>
        {showOverpaidNote && (
          <div className="mt-2 flex items-start gap-1 rounded border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 text-[11px] font-bold text-[var(--sem-warn)]">
            <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span>أدفع لهذه الجهة زيادة عن مستحقها بمقدار {fmt(String(Math.abs(feeDueRaw)))} د.ع — راجع سندات صرف الأجور القديمة.</span>
          </div>
        )}
      </details>
    </>
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
          <AppSelect value={userId} onValueChange={(next) => setUserId(next)} className="px-3 py-2 text-sm">
            <option value="">اختر حساب دخول نشطاً</option>
            {(accounts.data ?? []).filter((a) => a.linkedPartyId == null || Number(a.linkedPartyId) === partyId).map((a) => (
              <option key={a.id} value={a.id}>{a.name} {a.username ? `(${a.username})` : ""}</option>
            ))}
          </AppSelect>
          <AppSelect value={memberRole} onValueChange={(next) => setMemberRole(next as typeof memberRole)} className="px-3 py-2 text-sm">
            <option value="DRIVER">سائق</option>
            <option value="MANAGER">مدير الشركة</option>
            <option value="ACCOUNTANT">محاسب الشركة</option>
          </AppSelect>
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
  const list = q.data?.rows ?? [];
  const listHasMore = q.data?.hasMore ?? false;
  const drivers = (members.data ?? []).filter((m) => m.isActive && m.memberRole === "DRIVER");
  // الأعمدة تُغلِق على طفرة إعادة الإسناد وقائمة السائقين ⇒ تُبنى في كل تصيير (بلا تجميد يُقادم الحالة).
  const columns: ColumnDef<ConsignmentRow, unknown>[] = [
    {
      id: "consignmentNumber",
      header: "الإرسالية",
      accessorFn: (c) => c.consignmentNumber,
      meta: { kind: "code" },
      cell: ({ row }) => <span className="text-xs">{row.original.consignmentNumber}</span>,
    },
    {
      id: "invoice",
      header: "الفاتورة",
      accessorFn: (c) => (c.invoiceId ? (c.invoiceNumber ?? "#" + c.invoiceId) : "—"),
      meta: { kind: "code" },
      cell: ({ row }) =>
        row.original.invoiceId ? (
          <a className="text-xs text-primary hover:underline" dir="ltr" href={"/invoices/" + row.original.invoiceId}>
            {row.original.invoiceNumber ?? "#" + row.original.invoiceId}
          </a>
        ) : (
          "—"
        ),
    },
    {
      id: "customer",
      header: "العميل/المستلم",
      accessorFn: (c) => c.customerName ?? c.recipientName ?? "عميل نقدي",
      meta: { width: "wide" },
      cell: ({ row }) => row.original.customerName ?? row.original.recipientName ?? "عميل نقدي",
    },
    moneyCol<ConsignmentRow>("cod", "COD", (c) => c.codAmount),
    moneyCol<ConsignmentRow>("collected", "المقبوض", (c) => c.collectedAmount),
    moneyCol<ConsignmentRow>(
      "remaining",
      "المتبقي",
      (c) => Math.max(0, Number(c.codAmount) - Number(c.collectedAmount)),
      undefined,
      (c) => (Math.max(0, Number(c.codAmount) - Number(c.collectedAmount)) > 0 ? "font-bold text-destructive" : "font-bold"),
    ),
    {
      id: "moneyStatus",
      header: "حالة التسوية",
      accessorFn: (c) => CN_STATUS[c.moneyStatus]?.label ?? c.moneyStatus,
      meta: { kind: "status" },
      cell: ({ row }) => {
        const st = CN_STATUS[row.original.moneyStatus] ?? { label: row.original.moneyStatus, cls: "bg-muted" };
        return <span className={cn("rounded px-2 py-0.5 text-xs font-bold", st.cls)}>{st.label}</span>;
      },
    },
    {
      id: "parcelStatus",
      header: "التسليم للعميل",
      accessorFn: (c) => PARCEL_STATUS[c.parcelStatus] ?? c.parcelStatus,
      meta: { kind: "status" },
      cell: ({ row }) => (
        <div className="text-xs">
          <Badge variant={row.original.parcelStatus === "DELIVERED" ? "success" : row.original.parcelStatus === "FAILED" ? "danger" : "info"}>
            {PARCEL_STATUS[row.original.parcelStatus] ?? row.original.parcelStatus}
          </Badge>
          {row.original.courierDeliveredAt && <div className="mt-1 text-money-positive">{fmtDate(row.original.courierDeliveredAt)}</div>}
        </div>
      ),
    },
    {
      id: "driver",
      header: "السائق والحركة",
      accessorFn: (c) => c.assignedUserName ?? "طابور الشركة المشترك",
      meta: { width: "wide", wrap: true },
      enableSorting: false,
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="text-xs">
            <div className="mb-1">{c.assignedUserName ?? "طابور الشركة المشترك"}</div>
            {c.failureReason && <div className="mb-1 text-destructive">{c.failureReason}</div>}
            {canEdit && (c.parcelStatus === "ASSIGNED" || c.parcelStatus === "FAILED") && (
              <AppSelect
                value={String(c.assignedUserId ?? "")}
                disabled={reassignM.isPending}
                onValueChange={(next) => reassignM.mutate({
                  partyId,
                  consignmentId: Number(c.id),
                  assignedUserId: next ? Number(next) : null,
                  clientRequestId: crypto.randomUUID(),
                })}
                className="px-2 py-1"
              >
                <option value="">مشترك لكل السائقين</option>
                {drivers.map((d) => <option key={d.userId} value={d.userId}>{d.name ?? d.username ?? "#" + d.userId}</option>)}
              </AppSelect>
            )}
          </div>
        );
      },
    },
    {
      id: "dispatchedAt",
      header: "ارسلت",
      accessorFn: (c) => (c.dispatchedAt ? fmtDate(c.dispatchedAt) : "—"),
      meta: { kind: "date" },
      cell: ({ row }) => (row.original.dispatchedAt ? fmtDate(row.original.dispatchedAt) : "—"),
    },
    {
      id: "remittanceNumber",
      header: "التوريد",
      accessorFn: (c) => c.remittanceNumber ?? "—",
      meta: { kind: "code" },
      cell: ({ row }) =>
        row.original.remittanceNumber ? (
          <span className="text-xs">{row.original.remittanceNumber}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];
  return (
    <div className="space-y-3">
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
        المالية المفتوحة فقط (غير مسوّاة / مسوّاة جزئياً)
      </label>
      <DataTable<ConsignmentRow>
        columns={columns}
        data={list}
        /* الفلترة بمربّع «المالية المفتوحة فقط» أعلاه (يغذّي الاستعلام). */
        searchable={false}
        externalFiltersActive={openOnly}
        loading={q.isLoading}
        errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => void q.refetch() }}
        emptyState={<EmptyState icon={PackageOpen} title="لا إرساليات" description="لم تُسنَد لهذه الجهة إرساليات بعد." />}
        emptyFilteredState={<EmptyState icon={PackageOpen} title="لا إرساليات مفتوحة" description="لا إرسالية غير مسوّاة لهذه الجهة." />}
      />
      {/* اقتطاعُ الخادم يُعلَن صراحةً: صفوفٌ لا تظهر ولا تُبحَث لو صمتنا عنه. */}
      {listHasMore && (
        <div className="rounded-md border border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] p-2 text-center text-xs font-bold text-[var(--sem-warn)]">
          تعرض {list.length} إرسالية — هناك المزيد. استعمل «المالية المفتوحة فقط» للتصفية.
        </div>
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
  const columns: ColumnDef<RemittanceRow, unknown>[] = [
    {
      id: "remittanceNumber",
      header: "رقم التوريد",
      accessorFn: (r) => r.remittanceNumber,
      meta: { kind: "code" },
      cell: ({ row }) => <span className="text-xs">{row.original.remittanceNumber}</span>,
    },
    {
      id: "receivedAt",
      header: "التاريخ",
      accessorFn: (r) => fmtDateTime(r.receivedAt),
      meta: { kind: "datetime" },
      cell: ({ row }) => <span className="text-xs">{fmtDateTime(row.original.receivedAt)}</span>,
    },
    moneyCol<RemittanceRow>("collectedTotal", "المقبوض", (r) => r.collectedTotal),
    moneyCol<RemittanceRow>(
      "feesTotal",
      "الأجور",
      (r) => r.feesTotal,
      (r) => (Number(r.feesTotal) > 0 ? "−" + fmt(r.feesTotal) : "—"),
      () => "text-[var(--sem-warn)]",
    ),
    moneyCol<RemittanceRow>("netRemitted", "صافي التوريد", (r) => r.netRemitted, undefined, () => "font-bold"),
    moneyCol<RemittanceRow>(
      "shortfallTotal",
      "عجز بقي عهدة",
      (r) => r.shortfallTotal,
      (r) => (Number(r.shortfallTotal) > 0 ? fmt(r.shortfallTotal) : "—"),
      (r) => (Number(r.shortfallTotal) > 0 ? "font-bold text-destructive" : "text-muted-foreground"),
    ),
    {
      id: "status",
      header: "الحالة",
      accessorFn: (r) => (r.status === "BALANCED" ? "مطابق" : r.status === "SHORT" ? "بعجز" : "بزيادة"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span
          className={cn(
            "rounded px-2 py-0.5 text-xs font-bold",
            row.original.status === "BALANCED" ? "badge-status-active" : row.original.status === "SHORT" ? "badge-stock-out" : "badge-stock-low",
          )}
        >
          {row.original.status === "BALANCED" ? "مطابق" : row.original.status === "SHORT" ? "بعجز" : "بزيادة"}
        </span>
      ),
    },
    {
      id: "receivedBy",
      header: "استلمه",
      accessorFn: (r) => r.receivedByName ?? "—",
      meta: { kind: "actor" },
      cell: ({ row }) => <span className="text-xs">{row.original.receivedByName ?? "—"}</span>,
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="inline-flex items-center gap-1.5">من <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" /></label>
        <label className="inline-flex items-center gap-1.5">إلى <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-40" /></label>
      </div>
      <DataTable<RemittanceRow>
        columns={columns}
        data={list}
        /* فلترُ الفترة أعلاه يغذّي الاستعلام — لا حقلَ بحثٍ ثانياً في الجدول. */
        searchable={false}
        externalFiltersActive={Boolean(from || to)}
        loading={q.isLoading}
        errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => void q.refetch() }}
        emptyState={<EmptyState icon={Banknote} title="لا توريدات" description="لم تُسجَّل توريدات لهذه الجهة في الفترة." />}
        emptyFilteredState={<EmptyState icon={Banknote} title="لا توريدات" description="لم تُسجَّل توريدات لهذه الجهة في الفترة." />}
      />
    </div>
  );
}

// ───────────────────────── كشف الحساب ─────────────────────────
function StatementTab({ party }: { party: PartyRow }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = trpc.delivery.partyStatement.useQuery({ partyId: party.id, from: from || undefined, to: to || undefined });
  const built = useMemo(() => (q.data ? buildStatementRows(q.data.entries) : null), [q.data]);
  /*
   * ⛔ لا فرزَ على كشف حساب: الرصيد عمودٌ **جارٍ** يُحسب بترتيب القيود، وإعادةُ ترتيب الصفوف
   * تُنتج عمود رصيدٍ لا يقود إلى شيء. لذلك `enableSorting: false` على كل عمود.
   */
  const statementColumns: ColumnDef<StatementRow, unknown>[] = [
    { id: "date", header: "التاريخ", accessorFn: (r) => r.date, meta: { kind: "date" }, enableSorting: false, cell: ({ row }) => <span className="text-xs">{row.original.date}</span> },
    { id: "ref", header: "المرجع", accessorFn: (r) => r.ref, meta: { kind: "code" }, enableSorting: false, cell: ({ row }) => <span className="text-xs">{row.original.ref}</span> },
    { id: "description", header: "البيان", accessorFn: (r) => r.description, meta: { width: "wide", wrap: true }, enableSorting: false, cell: ({ row }) => row.original.description },
    { id: "debit", header: "مدين (عهدة+)", accessorFn: (r) => (r.debit ? fmt(r.debit) : "—"), meta: { kind: "money" }, enableSorting: false, cell: ({ row }) => (row.original.debit ? fmt(row.original.debit) : "—") },
    { id: "credit", header: "دائن (توريد/شطب)", accessorFn: (r) => (r.credit ? fmt(r.credit) : "—"), meta: { kind: "money" }, enableSorting: false, cell: ({ row }) => (row.original.credit ? fmt(row.original.credit) : "—") },
    {
      id: "balance",
      header: "الرصيد",
      // صفوف الإفصاح (أجور/أمانات) لا تغيّر العهدة ⇒ خانةُ رصيدها تبقى فارغة كما كانت.
      accessorFn: (r) => (r.balance ? fmt(r.balance) : ""),
      meta: { kind: "money" },
      enableSorting: false,
      cell: ({ row }) => <span className="font-bold">{row.original.balance ? fmt(row.original.balance) : ""}</span>,
    },
  ];

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
      {!built || built.rows.length === 0 ? (
        <DataTable<StatementRow>
          /* مُضمَّن كنظيره أدناه: شريطُ حالةٍ يقول «لا بيانات» ومنتقي أعمدةٍ فوق كشفٍ فارغ
             ضجيجٌ يزاحم رسالةَ الفراغ نفسها. */
          embedded
          columns={statementColumns}
          data={[]}
          searchable={false}
          loading={q.isLoading}
          errorState={{ isError: q.isError, message: q.error?.message, onRetry: () => void q.refetch() }}
          emptyState={<EmptyState icon={Banknote} title="لا حركات" description="لا قيود توصيل لهذه الجهة في الفترة." />}
        />
      ) : (
        <>
          {/* مُضمَّن: المجاميع تحته مباشرةً، والكشف يُعرض كاملاً (لا ترقيم يقطع الرصيد الجاري). */}
          <DataTable<StatementRow>
            embedded
            searchable={false}
            pageSize={Infinity}
            columns={statementColumns}
            data={built.rows}
            /* `!bg-…`: تلوينُ `odd:`/`even:` في `DataTable` أعلى تخصّصاً ⇒ بلا `!` يذوب
               تمييزُ صفوف الإفصاح (أجور/أمانات) التي لا تُغيّر عمودَ الرصيد. */
            getRowClassName={(r) => (r.info ? "!bg-muted/20 text-muted-foreground" : undefined)}
          />
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

// ───────────────────────── قاعدة العمولة (Slice G، ٢٩/٨/٢٦) ─────────────────────────
// بلاغ المالك: «محاسبياً لا تتم التسوية على المندوب والشركة يجب أن يكون كل شيء مؤتمتاً تلقائياً».
// هذه الطبقة الأولى: إدخال قاعدةٍ لكلّ جهةٍ ومعاينة العمولة المتوقّعة قبل ربطها بقيدٍ محاسبيّ آليّ
// (يأتي في Slice I بعد إذن المالك على النموذج). القاعدة الافتراضية المُقترَحة FLAT_PER_DELIVERY
// (أكثر النماذج شيوعاً في العراق: مبلغٌ ثابتٌ لكلّ توصيلٍ بصرف النظر عن الأجرة).
const RULE_TYPE_LABEL: Record<string, string> = {
  FLAT_PER_DELIVERY: "ثابت لكل توصيل",
  PERCENT_OF_FEE: "نسبة من أجرة التوصيل",
  PERCENT_OF_ORDER: "نسبة من قيمة الطلب",
  HYBRID: "ثابت + نسبة",
};
function CommissionRuleTab({ partyId, canEdit }: { partyId: number; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const list = trpc.delivery.listCommissionRules.useQuery({ partyId });
  // H2 (٢٩/٨/٢٦): علَم استبدال الأجرة بالعمولة عند التسوية — يُقرأ من getParty، ويُغيَّر بـupdateParty.
  const partyFull = trpc.delivery.getParty.useQuery({ id: partyId });
  const updateParty = trpc.delivery.updateParty.useMutation({
    onSuccess: () => {
      notify.ok("حُدِّث تفعيل استبدال الأجرة بالعمولة");
      utils.delivery.getParty.invalidate({ id: partyId });
    },
    onError: (e) => notify.err(e),
  });
  const useCommissionActive = !!partyFull.data?.useCommissionForSettlement;
  // معاينة حيّة: أدخِل أجرةً وقيمة طلبٍ افتراضيّة ← احسب العمولة التي ستُصرف بحسب القواعد الفعّالة.
  const [previewFee, setPreviewFee] = useState("5000");
  const [previewOrder, setPreviewOrder] = useState("50000");
  const preview = trpc.delivery.previewCommission.useQuery(
    { partyId, deliveryFee: Number(previewFee) || 0, orderTotal: Number(previewOrder) || 0 },
    { enabled: !!(list.data && list.data.length > 0) },
  );
  const [form, setForm] = useState<{
    id: number | null;
    ruleType: "FLAT_PER_DELIVERY" | "PERCENT_OF_FEE" | "PERCENT_OF_ORDER" | "HYBRID";
    flatAmount: string;
    percentValue: string;
    minGuarantee: string;
    maxCap: string;
    notes: string;
  }>({ id: null, ruleType: "FLAT_PER_DELIVERY", flatAmount: "2000", percentValue: "", minGuarantee: "", maxCap: "", notes: "" });
  const save = trpc.delivery.saveCommissionRule.useMutation({
    onSuccess: () => {
      notify.ok(form.id ? "حُدِّثت قاعدة العمولة" : "أُنشئت قاعدة العمولة");
      utils.delivery.listCommissionRules.invalidate({ partyId });
      setForm({ id: null, ruleType: "FLAT_PER_DELIVERY", flatAmount: "2000", percentValue: "", minGuarantee: "", maxCap: "", notes: "" });
    },
    onError: (e) => notify.err(e),
  });
  const del = trpc.delivery.deleteCommissionRule.useMutation({
    onSuccess: () => { notify.ok("حُذفت القاعدة"); utils.delivery.listCommissionRules.invalidate({ partyId }); },
    onError: (e) => notify.err(e),
  });
  const rows = list.data ?? [];
  const needsFlat = form.ruleType === "FLAT_PER_DELIVERY" || form.ruleType === "HYBRID";
  const needsPercent = form.ruleType !== "FLAT_PER_DELIVERY";
  const submit = () => {
    if (needsFlat && !Number(form.flatAmount)) { notify.err("أدخل مبلغاً ثابتاً موجباً"); return; }
    if (needsPercent && !Number(form.percentValue)) { notify.err("أدخل نسبةً موجبة"); return; }
    save.mutate({
      id: form.id,
      partyId,
      ruleType: form.ruleType,
      flatAmount: needsFlat ? form.flatAmount : null,
      percentValue: needsPercent ? form.percentValue : null,
      minGuarantee: form.minGuarantee || null,
      maxCap: form.maxCap || null,
      notes: form.notes || null,
      isActive: true,
    });
  };
  return (
    <div className="space-y-4">
      {/* H2 (٢٩/٨/٢٦): بطاقة تفعيل الاستبدال المحاسبيّ. تظهر فقط لمن يستطيع التعديل، ولا يُفعَّل
          إلّا حين تكون للجهة قاعدةٌ فعّالة (الخادم يرفض غير ذلك بلا لبس). */}
      {canEdit && (
        <div className={cn(
          "rounded-lg border p-4",
          useCommissionActive
            ? "border-[var(--sem-pos)]/45 bg-[var(--sem-pos-bg)]"
            : "border-dashed bg-muted/30",
        )}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex-1 space-y-1">
              <h4 className="text-sm font-extrabold">
                {useCommissionActive ? "التسوية المحاسبيّة مُفعَّلة" : "تفعيل التسوية بالعمولة"}
              </h4>
              <p className="text-xs text-muted-foreground">
                عند التفعيل: دفعُ أجور هذه الجهة يستبدل الأجرة بمبلغ العمولة (بحسب القاعدة أعلاه)،
                والفارقُ يُقيَّد إيراد توصيلٍ للمكتبة تلقائياً.
                {!useCommissionActive && rows.length === 0 && (
                  <span className="ms-1 font-bold text-[var(--sem-warn)]">أضف قاعدةً فعّالة أولاً.</span>
                )}
              </p>
            </div>
            <Button
              variant={useCommissionActive ? "outline" : "default"}
              disabled={updateParty.isPending || (!useCommissionActive && rows.length === 0)}
              onClick={async () => {
                const ok = await confirm({
                  variant: useCommissionActive ? "warning" : "info",
                  title: useCommissionActive ? "إيقاف الاستبدال المحاسبيّ" : "تفعيل الاستبدال المحاسبيّ",
                  description: useCommissionActive
                    ? "بعد الإيقاف: يعود دفعُ الأجرة كاملةً للمندوب بلا اقتطاعٍ لصالح المكتبة."
                    : "بعد التفعيل: كلّ دفعِ أجرةٍ لاحقٍ سيقيّد الفارق بين الأجرة والعمولة إيراداً للمكتبة. يمكن التراجع لاحقاً بلا أثر على القيود السابقة.",
                  confirmText: useCommissionActive ? "إيقاف" : "تفعيل",
                });
                if (!ok) return;
                updateParty.mutate({ id: partyId, useCommissionForSettlement: !useCommissionActive });
              }}
            >
              {updateParty.isPending ? "جارٍ…" : useCommissionActive ? "إيقاف" : "تفعيل"}
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-[var(--sem-info-bg)] p-3 text-xs text-[var(--sem-info)]">
        قاعدة العمولة تُقيَّم لكلّ إرساليّة عند التسوية. {useCommissionActive
          ? <span className="font-bold">القيد المحاسبيّ التلقائيّ <b>مُفعَّل</b> — الفارقُ إيرادٌ للمكتبة.</span>
          : "التفعيل اختياريّ (بطاقة التفعيل أعلاه)."}
      </div>

      {rows.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">النمط</TableHead>
                <TableHead className="text-left">القيم</TableHead>
                <TableHead className="text-left">الحدود</TableHead>
                <TableHead className="text-center">الحالة</TableHead>
                <TableHead className="text-center">إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-bold">{RULE_TYPE_LABEL[r.ruleType] ?? r.ruleType}</TableCell>
                  <TableCell className="text-left text-xs tabular-nums" dir="ltr">
                    {r.flatAmount ? `ثابت: ${fmt(r.flatAmount)} د.ع` : ""}
                    {r.flatAmount && r.percentValue ? " + " : ""}
                    {r.percentValue ? `${r.percentValue}%` : ""}
                  </TableCell>
                  <TableCell className="text-left text-xs tabular-nums" dir="ltr">
                    {r.minGuarantee ? `≥ ${fmt(r.minGuarantee)}` : ""}
                    {r.minGuarantee && r.maxCap ? " · " : ""}
                    {r.maxCap ? `≤ ${fmt(r.maxCap)}` : ""}
                  </TableCell>
                  <TableCell className="text-center">
                    {r.isActive
                      ? <Badge variant="secondary" className="bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]">فعالة</Badge>
                      : <Badge variant="outline">معطلة</Badge>}
                  </TableCell>
                  <TableCell className="text-center">
                    {canEdit && (
                      <div className="flex justify-center gap-1">
                        <Button size="sm" variant="outline" onClick={() => setForm({
                          id: Number(r.id),
                          ruleType: r.ruleType as never,
                          flatAmount: String(r.flatAmount ?? ""),
                          percentValue: String(r.percentValue ?? ""),
                          minGuarantee: String(r.minGuarantee ?? ""),
                          maxCap: String(r.maxCap ?? ""),
                          notes: r.notes ?? "",
                        })}>تعديل</Button>
                        <Button size="sm" variant="destructive" onClick={() => del.mutate({ id: Number(r.id) })} disabled={del.isPending}>حذف</Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {rows.length === 0 && !list.isLoading && (
        <EmptyState icon={Banknote} title="لا قاعدة عمولة بعد" description="أَضِف قاعدةً كي يحسب النظام العمولة المتوقّعة لكلّ إرساليّة." />
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border p-4">
          <h4 className="mb-3 text-sm font-extrabold">معاينة العمولة</h4>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-bold">أجرة التوصيل (د.ع)</label>
              <MoneyInput value={previewFee} onChange={setPreviewFee} ariaLabel="أجرة التوصيل للمعاينة" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold">قيمة الطلب (COD)</label>
              <MoneyInput value={previewOrder} onChange={setPreviewOrder} ariaLabel="قيمة الطلب للمعاينة" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold">العمولة المحسوبة</label>
              <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-base font-black tabular-nums text-[var(--sem-pos)]" dir="ltr">
                {preview.data ? `${fmt(preview.data.commission)} د.ع` : preview.isLoading ? "…" : "—"}
              </div>
            </div>
          </div>
          {preview.data && (
            <p className="mt-2 text-xs text-muted-foreground">
              {preview.data.breakdown.minApplied ? "طُبِّق الحدّ الأدنى المضمون." : preview.data.breakdown.maxApplied ? "طُبِّق الحدّ الأعلى." : "احتساب مباشر بلا حدود."}
            </p>
          )}
        </div>
      )}

      {canEdit && (
        <div className="rounded-lg border p-4">
          <h4 className="mb-3 text-sm font-extrabold">{form.id ? "تعديل القاعدة" : "قاعدة جديدة"}</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-bold">النمط</label>
              <AppSelect
                value={form.ruleType}
                onValueChange={(v) => setForm((f) => ({ ...f, ruleType: v as never }))}
                placeholder="اختر النمط"
              >
                <option value="FLAT_PER_DELIVERY">ثابت لكل توصيل (الأكثر شيوعاً)</option>
                <option value="PERCENT_OF_FEE">نسبة من أجرة التوصيل</option>
                <option value="PERCENT_OF_ORDER">نسبة من قيمة الطلب</option>
                <option value="HYBRID">ثابت + نسبة</option>
              </AppSelect>
            </div>
            {needsFlat && (
              <div className="space-y-1">
                <label className="text-xs font-bold">المبلغ الثابت (د.ع)</label>
                <MoneyInput value={form.flatAmount} onChange={(v) => setForm((f) => ({ ...f, flatAmount: v }))} ariaLabel="المبلغ الثابت" />
              </div>
            )}
            {needsPercent && (
              <div className="space-y-1">
                <label className="text-xs font-bold">النسبة (%)</label>
                <Input value={form.percentValue} onChange={(e) => setForm((f) => ({ ...f, percentValue: e.target.value }))} placeholder="30" />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-bold">حدّ أدنى مضمون (اختياري)</label>
              <MoneyInput value={form.minGuarantee} onChange={(v) => setForm((f) => ({ ...f, minGuarantee: v }))} ariaLabel="حدّ أدنى" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold">حدّ أعلى (اختياري)</label>
              <MoneyInput value={form.maxCap} onChange={(v) => setForm((f) => ({ ...f, maxCap: v }))} ariaLabel="حدّ أعلى" />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-bold">ملاحظات</label>
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="اختياريّ — وصفٌ أو استثناء" />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={submit} disabled={save.isPending}>{save.isPending ? ACTION_LABELS.saving : (form.id ? "حفظ" : "إضافة قاعدة")}</Button>
            {form.id && (
              <Button variant="outline" onClick={() => setForm({ id: null, ruleType: "FLAT_PER_DELIVERY", flatAmount: "2000", percentValue: "", minGuarantee: "", maxCap: "", notes: "" })}>إلغاء</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── بيانات الجهة ─────────────────────────
function SettingsTab({ party, canManage, canRecover, onChanged }: { party: PartyRow; canManage: boolean; canRecover: boolean; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const full = trpc.delivery.getParty.useQuery({ id: party.id });
  const accounts = trpc.delivery.courierAccounts.useQuery(undefined, { enabled: canManage });
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

  if (!form) return <div className="p-8 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>;
  const moneyOk = (v: string) => /^\d+(\.\d{1,2})?$/.test(v);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 font-extrabold">تعديل البيانات {!canManage && <span className="text-xs font-normal text-muted-foreground">(بحاجة إلى صلاحية إدارة التوصيل)</span>}</h3>
        <fieldset disabled={!canManage} className="space-y-2.5">
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
            <AppSelect
              className="mt-1 h-10 px-3 text-sm"
              value={String(form.userId ?? "")}
              onValueChange={(next) => setForm({ ...form, userId: next ? Number(next) : null })}
            >
              <option value="">بلا حساب دخول</option>
              {(accounts.data ?? [])
                .filter((a) => a.linkedPartyId == null || a.linkedPartyId === party.id)
                .map((a) => <option key={a.id} value={a.id}>{a.name}{a.username ? ` (${a.username})` : ""}</option>)}
            </AppSelect>
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
            >{update.isPending ? ACTION_LABELS.saving : "حفظ"}</Button>
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
