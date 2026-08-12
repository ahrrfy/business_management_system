// شاشة الهدايا والمجانيات — G-م١ الوارد (استلام مجّانيّ من مورّد، صفر تكلفة) + G-م٢ الصادر (منح للعميل،
// GIFT_OUT + حوكمة SOD: فوق العتبة/غير المدير ⇒ اعتماد مدير آخر). القراءة/الكتابة خلف مفتاح `gifts`.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, BarChart3, Check, Gift, Megaphone, MessageCircle, Plus, Printer, Trash2, X } from "lucide-react";
import { hasModuleAccess } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { RowActions } from "@/components/list/RowActions";
import { FilterField } from "@/components/list";
import { ListToolbar } from "@/components/list/ListToolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppSelect } from "@/components/ui/AppSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TablePager } from "@/components/table/TablePager";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import SupplierPicker from "@/components/voucher/SupplierPicker";
import CustomerPicker from "@/components/CustomerPicker";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine } from "@/components/invoice/types";
import { printGiftVoucherA4 } from "@/lib/printing/giftVoucher";
import { buildGiftMessage, openWhatsApp } from "@/lib/whatsapp";

type Mode = "list" | "in" | "out" | "report" | "campaigns";
type DirFilter = "ALL" | "IN" | "OUT";
type GiftStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "DELIVERED" | "CANCELLED" | "REVERSED";
type StatusFilter = "ALL" | GiftStatus;
type GiftLine = { key: number; variantId: number; productUnitId: number; label: string; unit: string; quantity: string };
type GiftListRow = RouterOutputs["gifts"]["list"]["rows"][number];
/** حجم صفحة سجلّ السندات — الترقيم خادميّ حقيقيّ (لا اقتطاع صامت عند ٢٠٠). */
const PAGE_SIZE = 50;

const STATUS_AR: Record<string, string> = {
  DRAFT: "مسوّدة",
  PENDING_APPROVAL: "بانتظار اعتماد",
  APPROVED: "معتمد",
  DELIVERED: "مُنجَز",
  CANCELLED: "ملغى",
  REVERSED: "معكوس",
};

export default function GiftsHub() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)?.permissionsOverride ?? null;
  const elevated = role === "admin" || role === "manager";
  const canWrite = hasModuleAccess(role, override, "gifts", "FULL");
  const canApprove = role === "admin" || role === "manager";

  const [mode, setMode] = useState<Mode>("list");

  // ── فلاتر سجلّ السندات (list) — كلّها خادمية عبر gifts.list؛ لا فلترة محلية تُخفي صفحات الخادم ──
  // فلاتر في querystring — تعيش مع فتح تفاصيل السند والرجوع، ويمكن مشاركتها رابطاً (نمط بقيّة القاعدة).
  const [listFilters, setListFilters, resetListFilters] = useUrlFilters({
    dir: "ALL", status: "ALL", branch: "", from: "", to: "", q: "", page: "0",
  });
  // تصحيح قيم URL (Codex P2): querystring يمكن أن يحمل قيماً باطلة (مشاركة/تعديل يدوي).
  // enum غير معروف أو رقم غير صالح ⇒ رجوع للافتراضي بدل تمرير قيمة تكسر Zod schema في gifts.list.
  const dirFilter: DirFilter =
    listFilters.dir === "IN" || listFilters.dir === "OUT" || listFilters.dir === "ALL" ? listFilters.dir : "ALL";
  const statusFilter: StatusFilter =
    listFilters.status === "ALL" || listFilters.status in STATUS_AR ? (listFilters.status as StatusFilter) : "ALL";
  const branchNum = Number(listFilters.branch);
  const listBranchId: number | "" =
    listFilters.branch !== "" && Number.isFinite(branchNum) && branchNum > 0 ? branchNum : "";
  const listFrom = listFilters.from;
  const listTo = listFilters.to;
  const query = listFilters.q;
  const qDebounced = useDebouncedValue(query.trim(), 300);
  const pageNum = Number(listFilters.page);
  const page = Number.isFinite(pageNum) && pageNum >= 0 ? Math.floor(pageNum) : 0;
  const setDirFilter = (v: DirFilter) => setListFilters({ dir: v, page: "0" });
  const setStatusFilter = (v: StatusFilter) => setListFilters({ status: v, page: "0" });
  const setListBranchId = (v: number | "") => setListFilters({ branch: v === "" ? "" : String(v), page: "0" });
  const setListFrom = (v: string) => setListFilters({ from: v, page: "0" });
  const setListTo = (v: string) => setListFilters({ to: v, page: "0" });
  const setQuery = (v: string) => setListFilters({ q: v, page: "0" });
  const setPage = (updater: number | ((p: number) => number)) =>
    setListFilters({ page: String(typeof updater === "function" ? updater(page) : updater) });

  // ── حالة النموذج (مشتركة بين الوارد والصادر) ──
  const [formBranchId, setFormBranchId] = useState<number | null>(null);
  const branchId = elevated ? formBranchId : me.data?.branchId ?? null;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: elevated });
  const [supplierId, setSupplierId] = useState<number | null>(null); // وارد
  const [customerId, setCustomerId] = useState<number | null>(null); // صادر
  const [giftType, setGiftType] = useState("");
  const [reason, setReason] = useState("");
  const [supplierRef, setSupplierRef] = useState(""); // وارد
  const [estimatedValue, setEstimatedValue] = useState(""); // وارد
  const [notes, setNotes] = useState("");
  const [sellable, setSellable] = useState(true); // وارد: قابل للبيع؟ (false = استخدام داخليّ/عيّنة)
  const [campaignId, setCampaignId] = useState<number | null>(null); // صادر: ربط حملة (اختياري)
  const [lines, setLines] = useState<GiftLine[]>([]);
  const keyRef = useRef(1);
  // مفتاح حماية الازدواج — يُولَّد لكل فتح نموذجٍ جديد؛ إعادة الإرسال بنفسه لا تُنشئ سنداً ثانياً (Codex P1).
  const [reqId, setReqId] = useState("");

  const listInput = useMemo(
    () => ({
      direction: dirFilter === "ALL" ? undefined : dirFilter,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      branchId: elevated && listBranchId !== "" ? Number(listBranchId) : undefined,
      from: listFrom || undefined,
      to: listTo || undefined,
      q: qDebounced || undefined,
    }),
    [dirFilter, statusFilter, elevated, listBranchId, listFrom, listTo, qDebounced],
  );
  const list = trpc.gifts.list.useQuery({ ...listInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const listRows = list.data?.rows ?? [];
  const listTotal = list.data?.total ?? 0;

  // حملات الهدايا (G-م٧): للاختيار في نموذج الصادر (النشطة فقط) ولإدارتها في وضع «الحملات».
  const activeCampaigns = trpc.gifts.campaignList.useQuery({ status: "ACTIVE" }, { enabled: canWrite });
  const allCampaigns = trpc.gifts.campaignList.useQuery(undefined, { enabled: mode === "campaigns" });
  const [campName, setCampName] = useState("");
  const [campBudget, setCampBudget] = useState("");
  const [campStart, setCampStart] = useState("");
  const [campEnd, setCampEnd] = useState("");
  const createCampaign = trpc.gifts.campaignCreate.useMutation({
    onSuccess: () => {
      notify.ok("تم إنشاء الحملة");
      setCampName("");
      setCampBudget("");
      setCampStart("");
      setCampEnd("");
      utils.gifts.campaignList.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const closeCampaign = trpc.gifts.campaignClose.useMutation({
    onSuccess: () => {
      notify.ok("أُغلقت الحملة");
      utils.gifts.campaignList.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  // تقرير الهدايا (خلف بوّابة التقارير) — كشف إساءة + أثر ماليّ.
  const canReports = hasModuleAccess(role, override, "reports", "READ");
  const todayStr = new Date().toISOString().slice(0, 10);
  const [repFrom, setRepFrom] = useState(`${todayStr.slice(0, 8)}01`);
  const [repTo, setRepTo] = useState(todayStr);
  const report = trpc.gifts.report.useQuery({ from: repFrom, to: repTo }, { enabled: mode === "report" && canReports });
  const reportTable = (title: string, headers: string[], rows: string[][]) => (
    <div className="overflow-x-auto rounded-lg border">
      <div className="bg-muted/50 px-3 py-2 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className={`px-3 py-1.5 ${i === 0 ? "text-start" : "text-end"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} className="py-4 text-center text-muted-foreground">
                لا بيانات
              </td>
            </tr>
          ) : (
            rows.map((r, ri) => (
              <tr key={ri} className="border-t">
                {r.map((c, ci) => (
                  <td key={ci} className={`px-3 py-1.5 ${ci === 0 ? "" : "text-end"}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  function resetForm() {
    setSupplierId(null);
    setCustomerId(null);
    setGiftType("");
    setReason("");
    setSupplierRef("");
    setEstimatedValue("");
    setNotes("");
    setSellable(true);
    setCampaignId(null);
    setLines([]);
    setFormBranchId(null);
  }
  function backToList() {
    resetForm();
    setMode("list");
    utils.gifts.list.invalidate();
  }
  function openForm(m: "in" | "out") {
    resetForm();
    setReqId(crypto.randomUUID()); // مفتاح idempotency جديد لكل عملية إنشاء
    setMode(m);
  }

  const inbound = trpc.gifts.receiveInbound.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم استلام الهدية الواردة — ${res.giftNumber}`);
      backToList();
    },
    onError: (e) => notify.err(e),
  });
  const outbound = trpc.gifts.createOutbound.useMutation({
    onSuccess: (res) => {
      notify.ok(res.pending ? `الهدية بانتظار اعتماد مدير — ${res.giftNumber}` : `تم منح الهدية — ${res.giftNumber}`);
      backToList();
      // إنجازٌ فوريّ يغيّر مُنفَق الحملة المرتبطة (إن وُجدت) — حدّث الحملات (تدقيق Codex P2) وإلا
      // يبقى منتقي الصادر/جدول الإدارة يعرض رقماً قديماً حتى إعادة جلبٍ عرَضية أخرى.
      utils.gifts.campaignList.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  // حوار «عرض قبل الاعتماد» — يعرض بنود السند للمعتمِد قبل تنفيذ الاعتماد الفعليّ (بلا تكلفة، نفس
  // نطاق gifts.get المستعمَل للطباعة/الإشعار — سند الهدية لا يحمل حقول تكلفة أصلاً).
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const approvePreviewQ = trpc.gifts.get.useQuery({ giftId: approvingId! }, { enabled: approvingId != null });
  const approve = trpc.gifts.approveGift.useMutation({
    onSuccess: () => {
      notify.ok("تم اعتماد الهدية");
      setApprovingId(null);
      utils.gifts.list.invalidate();
      utils.gifts.campaignList.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function printGift(giftId: number) {
    try {
      const g = await utils.gifts.get.fetch({ giftId });
      await printGiftVoucherA4({
        giftNumber: g.giftNumber,
        direction: g.direction,
        createdAt: g.createdAt ? new Date(g.createdAt as unknown as string).toISOString().slice(0, 10) : "",
        giftType: g.giftType,
        reason: g.reason,
        partyName: g.partyName,
        lines: g.lines.map((l) => ({ productName: l.productName, sku: l.sku, unit: l.unitName, quantity: Number(l.quantity) })),
      });
    } catch (e) {
      notify.err(e);
    }
  }

  async function shareGift(giftId: number) {
    try {
      const g = await utils.gifts.get.fetch({ giftId });
      if (!g.partyPhone) {
        notify.warn("لا هاتف مسجّل للطرف — أضِفه في ملفّه أولاً");
        return;
      }
      openWhatsApp(
        g.partyPhone,
        buildGiftMessage({
          direction: g.direction,
          giftNumber: g.giftNumber,
          partyName: g.partyName,
          lines: g.lines.map((l) => ({ productName: l.productName, unit: l.unitName, quantity: Number(l.quantity) })),
        }),
      );
    } catch (e) {
      notify.err(e);
    }
  }

  function addLine(l: InvoiceLine) {
    setLines((prev) => {
      const hit = prev.find((x) => x.variantId === l.variantId && x.productUnitId === l.productUnitId);
      if (hit) return prev.map((x) => (x === hit ? { ...x, quantity: String(Number(x.quantity) + l.qty) } : x));
      return [...prev, { key: keyRef.current++, variantId: l.variantId, productUnitId: l.productUnitId, label: l.name, unit: l.unit, quantity: String(l.qty) }];
    });
  }
  const setLineQty = (key: number, q: string) => setLines((prev) => prev.map((x) => (x.key === key ? { ...x, quantity: q } : x)));
  const removeLine = (key: number) => setLines((prev) => prev.filter((x) => x.key !== key));

  const busy = inbound.isPending || outbound.isPending;
  const canSubmit = canWrite && branchId != null && lines.length > 0 && lines.every((l) => Number(l.quantity) > 0) && !busy;
  const linePayload = () => lines.map((l) => ({ variantId: l.variantId, productUnitId: l.productUnitId, quantity: Number(l.quantity), refSalePrice: null }));

  function submitInbound() {
    if (!canSubmit) return;
    inbound.mutate({
      branchId: elevated ? branchId! : undefined,
      supplierId: supplierId ?? undefined,
      giftType: giftType.trim() || undefined,
      reason: reason.trim() || undefined,
      supplierRef: supplierRef.trim() || undefined,
      estimatedValue: estimatedValue.trim() || undefined,
      notes: notes.trim() || undefined,
      sellable,
      clientRequestId: reqId,
      lines: linePayload(),
    });
  }
  function submitOutbound() {
    if (!canSubmit) return;
    outbound.mutate({
      branchId: elevated ? branchId! : undefined,
      customerId: customerId ?? undefined,
      giftType: giftType.trim() || undefined,
      reason: reason.trim() || undefined,
      notes: notes.trim() || undefined,
      campaignId: campaignId ?? undefined,
      clientRequestId: reqId,
      lines: linePayload(),
    });
  }
  function submitCampaign() {
    if (!campName.trim()) return;
    createCampaign.mutate({
      name: campName.trim(),
      budgetCost: campBudget.trim() || undefined,
      startDate: campStart || undefined,
      endDate: campEnd || undefined,
    });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader
        title="الهدايا والمجانيات"
        description="الوارد المجّاني من الموردين (صفر تكلفة يخفّف متوسّط الكلفة، بلا دين) والصادر للعملاء (مصروف ترويجيّ بحوكمة اعتماد)."
        actions={
          mode === "list" ? (
            <div className="flex gap-2">
              {canWrite ? (
                <>
                  <Button size="sm" onClick={() => openForm("in")}>
                    <ArrowDownToLine aria-hidden className="me-1 size-4" />
                    استلام وارد
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => openForm("out")}>
                    <ArrowUpFromLine aria-hidden className="me-1 size-4" />
                    منح هدية صادرة
                  </Button>
                </>
              ) : null}
              {canReports ? (
                <Button size="sm" variant="outline" onClick={() => setMode("report")}>
                  <BarChart3 aria-hidden className="me-1 size-4" />
                  تقرير الهدايا
                </Button>
              ) : null}
              {canWrite ? (
                <Button size="sm" variant="outline" onClick={() => setMode("campaigns")}>
                  <Megaphone aria-hidden className="me-1 size-4" />
                  الحملات
                </Button>
              ) : null}
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={backToList}>
              رجوع للقائمة
            </Button>
          )
        }
      />

      {mode === "list" ? (
        <>
          <ListToolbar
            title="سندات الهدايا"
            count={listTotal}
            loading={list.isLoading}
            search={{ value: query, onChange: setQuery, placeholder: "رقم السند، السبب أو رقم عرض المورّد…" }}
            activeFilterCount={[dirFilter !== "ALL", statusFilter !== "ALL", listBranchId !== "", listFrom, listTo].filter(Boolean).length}
            onResetFilters={resetListFilters}
            onRefresh={() => void list.refetch()}
            refreshing={list.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "سندات-الهدايا",
              rows: listRows,
              formats: ["xlsx", "csv"],
              // يجلب **كل** السندات المطابقة للفلاتر (لا الصفحة المعروضة فقط) — نفس نمط Invoices.tsx.
              fetchAll: () =>
                fetchAllPaged<GiftListRow>(
                  (offset, limit) => utils.gifts.list.fetch({ ...listInput, limit, offset }).then((r) => ({ rows: r.rows, total: r.total })),
                  { pageSize: 200 },
                ),
              columns: [
                { key: "giftNumber", header: "رقم السند" },
                { key: "direction", header: "الاتجاه", map: (r) => r.direction === "IN" ? "وارد" : "صادر" },
                { key: "createdAt", header: "التاريخ" },
                { key: "party", header: "الطرف", map: (r) => r.supplierName ?? r.customerName ?? "" },
                { key: "status", header: "الحالة", map: (r) => STATUS_AR[r.status] ?? r.status },
                { key: "estimatedValue", header: "القيمة التقديرية", money: true },
              ],
            }}
            filters={
              <>
                {/* FilterField يُظهر التسمية بصرياً — aria-label وحده لا يُرى (نمط PR #559/#566). */}
                <FilterField label="الاتجاه" asGroup>
                  <div className="flex gap-1">
                    {([
                      ["ALL", "الكل"],
                      ["IN", "واردة"],
                      ["OUT", "صادرة"],
                    ] as [DirFilter, string][]).map(([k, lbl]) => (
                      <Button key={k} size="sm" variant={dirFilter === k ? "default" : "outline"} onClick={() => setDirFilter(k)}>
                        {lbl}
                      </Button>
                    ))}
                  </div>
                </FilterField>
                <FilterField label="الحالة">
                  <AppSelect value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)} className="h-8 w-40" size="sm" aria-label="فلتر الحالة">
                    <option value="ALL">كل الحالات</option>
                    {Object.entries(STATUS_AR).map(([k, lbl]) => (
                      <option key={k} value={k}>{lbl}</option>
                    ))}
                  </AppSelect>
                </FilterField>
                {elevated && (
                  <FilterField label="الفرع">
                    <AppSelect value={listBranchId === "" ? "" : String(listBranchId)} onValueChange={(v) => setListBranchId(v === "" ? "" : Number(v))} className="h-8 w-36" size="sm" aria-label="فلتر الفرع">
                      <option value="">كل الفروع</option>
                      {(branches.data ?? []).map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </AppSelect>
                  </FilterField>
                )}
                <FilterField label="من تاريخ">
                  <Input type="date" value={listFrom} onChange={(e) => setListFrom(e.target.value)} className="h-8 w-36" />
                </FilterField>
                <FilterField label="إلى تاريخ">
                  <Input type="date" value={listTo} onChange={(e) => setListTo(e.target.value)} className="h-8 w-36" />
                </FilterField>
              </>
            }
          />

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start">رقم السند</th>
                  <th className="px-3 py-2 text-start">الاتجاه</th>
                  <th className="px-3 py-2 text-start">التاريخ</th>
                  <th className="px-3 py-2 text-start">الطرف</th>
                  <th className="px-3 py-2 text-start">الحالة</th>
                  <th className="px-3 py-2 text-end">القيمة التقديرية</th>
                  <th className="px-3 py-2 text-end">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      جارٍ التحميل…
                    </td>
                  </tr>
                ) : listRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      لا توجد سندات هدايا مطابقة.
                    </td>
                  </tr>
                ) : (
                  listRows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{r.giftNumber}</td>
                      <td className="px-3 py-2">
                        <span className={r.direction === "IN" ? "text-money-positive" : "text-[var(--sem-info)]"}>
                          {r.direction === "IN" ? "وارد" : "صادر"}
                        </span>
                      </td>
                      <td className="px-3 py-2">{r.createdAt ? new Date(r.createdAt as unknown as string).toISOString().slice(0, 10) : ""}</td>
                      <td className="px-3 py-2">{r.supplierName ?? r.customerName ?? "—"}</td>
                      <td className="px-3 py-2">{STATUS_AR[r.status] ?? r.status}</td>
                      <td className="px-3 py-2 text-end">{r.estimatedValue ?? "—"}</td>
                      <td className="px-3 py-2 text-end">
                        <RowActions
                          mode="auto"
                          align="start"
                          actions={[
                            {
                              key: "approve",
                              kind: "approve",
                              label: "اعتماد",
                              icon: Check,
                              hidden: r.direction !== "OUT" || r.status !== "PENDING_APPROVAL" || !canApprove,
                              gate: { roles: ["manager"], module: "gifts", level: "FULL" },
                              disabled: approve.isPending,
                              disabledReason: "جارٍ اعتماد السند",
                              // يفتح حواراً يعرض بنود السند أوّلاً — لا اعتماد مباشر بلا مراجعة.
                              onSelect: () => setApprovingId(Number(r.id)),
                            },
                            { key: "print", kind: "print", label: "طباعة السند", icon: Printer, gate: { module: "gifts", level: "READ" }, onSelect: () => printGift(Number(r.id)) },
                            { key: "share", kind: "other", label: "إشعار واتساب", icon: MessageCircle, hidden: !r.supplierName && !r.customerName, gate: { module: "gifts", level: "READ" }, onSelect: () => shareGift(Number(r.id)) },
                          ]}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <TablePager page={page} onPageChange={setPage} pageSize={PAGE_SIZE} rowsOnPage={listRows.length} total={listTotal} isLoading={list.isFetching} />

          <Dialog open={approvingId != null} onOpenChange={(open) => !open && setApprovingId(null)}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>مراجعة السند قبل الاعتماد</DialogTitle>
                <DialogDescription>
                  {approvePreviewQ.data ? `سند ${approvePreviewQ.data.giftNumber} — ${approvePreviewQ.data.partyName ?? "بلا طرف"}` : "جارٍ التحميل…"}
                </DialogDescription>
              </DialogHeader>
              {approvePreviewQ.isLoading ? (
                <div className="py-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</div>
              ) : approvePreviewQ.data ? (
                <div className="space-y-3">
                  {approvePreviewQ.data.reason && (
                    <div className="text-sm text-muted-foreground">السبب: {approvePreviewQ.data.reason}</div>
                  )}
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-start">المنتج</th>
                          <th className="px-3 py-2 text-start">SKU</th>
                          <th className="px-3 py-2 text-start">الوحدة</th>
                          <th className="px-3 py-2 text-end">الكمية</th>
                        </tr>
                      </thead>
                      <tbody>
                        {approvePreviewQ.data.lines.map((l, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-2">{l.productName}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{l.sku}</td>
                            <td className="px-3 py-2">{l.unitName}</td>
                            <td className="px-3 py-2 text-end">{Number(l.quantity)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">تعذّر تحميل السند.</div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setApprovingId(null)} disabled={approve.isPending}>إلغاء</Button>
                <Button onClick={() => approvingId != null && approve.mutate({ giftId: approvingId })} disabled={approve.isPending || !approvePreviewQ.data}>
                  {approve.isPending ? "جارٍ الاعتماد…" : "اعتماد السند"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : mode === "report" ? (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>من</Label>
              <Input type="date" value={repFrom} onChange={(e) => setRepFrom(e.target.value)} className="h-9 w-40" />
            </div>
            <div className="space-y-1">
              <Label>إلى</Label>
              <Input type="date" value={repTo} onChange={(e) => setRepTo(e.target.value)} className="h-9 w-40" />
            </div>
          </div>
          {report.isLoading ? (
            <div className="py-6 text-center text-muted-foreground">جارٍ التحميل…</div>
          ) : report.data ? (
            <div className="grid gap-4 md:grid-cols-2">
              {reportTable("الملخّص (مُنجَز)", ["الاتجاه", "عدد", "التكلفة"], report.data.summary.map((x) => [x.direction === "IN" ? "وارد" : "صادر", String(x.count), String(x.totalCost)]))}
              {reportTable("حسب النوع/السبب (صادر)", ["النوع", "عدد", "التكلفة"], report.data.byType.map((x) => [x.giftType || "—", String(x.count), String(x.totalCost)]))}
              {reportTable("تركّز حسب المُنشئ (كشف إساءة)", ["الموظف", "عدد", "التكلفة"], report.data.byCreator.map((x) => [x.userName || "—", String(x.count), String(x.totalCost)]))}
              {reportTable("تركّز حسب العميل (كشف إساءة)", ["العميل", "عدد", "التكلفة"], report.data.byCustomer.map((x) => [x.customerName || "—", String(x.count), String(x.totalCost)]))}
            </div>
          ) : null}
        </div>
      ) : mode === "campaigns" ? (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Megaphone aria-hidden className="size-4" />
            حملة بميزانيّة (اختياريّة) تُفرَض تلقائياً: تجاوزها يُعلِّق الهدية لاعتماد مدير آخر حتى لو كان المُنشئ مديراً.
          </div>

          {elevated ? (
            // إنشاء/إغلاق الحملة سياسة عامّة (ميزانيّات/إغلاق يؤثّر على الجميع) — مدير/أدمن فقط
            // (تدقيق Codex P1)؛ الخادم يفرضها فعلياً — هذا حجبٌ واجهيّ مطابق فقط. القراءة تبقى لكل gifts≥FULL.
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1 sm:col-span-2">
                <Label>اسم الحملة *</Label>
                <Input value={campName} onChange={(e) => setCampName(e.target.value)} maxLength={120} placeholder="مثال: حملة العودة للمدارس ٢٠٢٦" />
              </div>
              <div className="space-y-1">
                <Label>الميزانيّة (اختياري)</Label>
                <MoneyInput value={campBudget} onChange={setCampBudget} placeholder="بلا سقف" ariaLabel="ميزانية الحملة" />
              </div>
              <div className="space-y-1">
                <Label>تبدأ (اختياري)</Label>
                <Input type="date" value={campStart} onChange={(e) => setCampStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>تنتهي (اختياري)</Label>
                <Input type="date" value={campEnd} onChange={(e) => setCampEnd(e.target.value)} />
              </div>
              <div className="flex items-end">
                <Button size="sm" onClick={submitCampaign} disabled={!campName.trim() || createCampaign.isPending}>
                  <Plus aria-hidden className="me-1 size-4" />
                  إنشاء حملة
                </Button>
              </div>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start">الاسم</th>
                  <th className="px-3 py-2 text-start">الحالة</th>
                  <th className="px-3 py-2 text-start">المدى</th>
                  <th className="px-3 py-2 text-end">المُنفَق / الميزانيّة</th>
                  {elevated ? <th className="px-3 py-2 text-end">إجراء</th> : null}
                </tr>
              </thead>
              <tbody>
                {(allCampaigns.data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={elevated ? 5 : 4} className="py-6 text-center text-muted-foreground">
                      لا حملات بعد.
                    </td>
                  </tr>
                ) : (
                  (allCampaigns.data ?? []).map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2">
                        <span className={c.status === "ACTIVE" ? "text-money-positive" : "text-muted-foreground"}>
                          {c.status === "ACTIVE" ? "نشطة" : "مغلقة"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {c.startDate ? new Date(c.startDate as unknown as string).toISOString().slice(0, 10) : "—"}
                        {" → "}
                        {c.endDate ? new Date(c.endDate as unknown as string).toISOString().slice(0, 10) : "—"}
                      </td>
                      <td className="px-3 py-2 text-end">
                        {/* budgetCost/spent يُحجَبان (null) خادمياً عمّن لا يرى التكلفة — نمط بقية الشاشة. */}
                        {c.spent == null ? "—" : `${c.spent}${c.budgetCost ? ` / ${c.budgetCost}` : " (بلا سقف)"}`}
                      </td>
                      {elevated ? (
                        <td className="px-3 py-2 text-end">
                          <RowActions
                            mode="inline"
                            align="start"
                            actions={[{
                              key: "close",
                              kind: "edit",
                              label: "إغلاق",
                              icon: X,
                              hidden: c.status !== "ACTIVE",
                              gate: { roles: ["manager"], module: "gifts", level: "FULL" },
                              disabled: closeCampaign.isPending,
                              disabledReason: "جارٍ إغلاق الحملة",
                              onSelect: () => closeCampaign.mutate({ campaignId: Number(c.id) }),
                            }]}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Gift aria-hidden className="size-4" />
            {mode === "in"
              ? "استلام بضاعة مجّانية من مورّد — ترفع المخزون بصفر تكلفة (تخفيف متوسّط الكلفة) بلا قيد شراء ولا دين."
              : "منح هدية للعميل — تخصم المخزون بالكلفة كمصروف «هدايا وترويج» (بلا بيع/نقد/ذمة). فوق العتبة أو من غير مدير: تُعلَّق لاعتماد مدير آخر."}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {elevated ? (
              <div className="space-y-1">
                <Label>الفرع *</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={formBranchId ?? ""}
                  onChange={(e) => setFormBranchId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">— اختر الفرع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {mode === "in" ? (
              <div className="space-y-1">
                <Label>المورّد (اختياري)</Label>
                <SupplierPicker supplierId={supplierId} onSupplierChange={setSupplierId} label="" />
              </div>
            ) : (
              <div className="space-y-1">
                <Label>العميل (اختياري)</Label>
                <CustomerPicker customerId={customerId} onCustomerChange={setCustomerId} />
              </div>
            )}

            <div className="space-y-1">
              <Label>نوع الهدية (اختياري)</Label>
              <Input value={giftType} onChange={(e) => setGiftType(e.target.value)} placeholder={mode === "in" ? "مثال: عيّنة، اشترِ واحصل" : "مثال: مجاملة، تعويض، حملة"} maxLength={32} />
            </div>

            {mode === "in" ? (
              <>
                <div className="space-y-1">
                  <Label>رقم عرض المورّد (اختياري)</Label>
                  <Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} maxLength={64} />
                </div>
                <div className="space-y-1">
                  <Label>القيمة التقديرية (اختياري)</Label>
                  <Input value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} inputMode="decimal" placeholder="للتقارير فقط — لا تدخل الدفتر" />
                </div>
              </>
            ) : null}

            <div className="space-y-1">
              <Label>السبب (اختياري)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />
            </div>

            {mode === "out" ? (
              <div className="space-y-1">
                <Label>الحملة (اختياري)</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={campaignId ?? ""}
                  onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">— بلا حملة —</option>
                  {(activeCampaigns.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.budgetCost ? ` (${c.spent}/${c.budgetCost} د.ع)` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          {mode === "in" ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sellable} onChange={(e) => setSellable(e.target.checked)} className="size-4" />
              <span>قابل للبيع (يدخل مخزون البيع ويخفّف متوسّط الكلفة)</span>
              {!sellable ? <span className="text-muted-foreground">— للاستخدام الداخليّ/عيّنة: يُوثَّق بلا رفع مخزون</span> : null}
            </label>
          ) : null}

          <div className="space-y-2">
            <Label>المنتجات *</Label>
            {branchId == null ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">اختر الفرع أولاً لإضافة المنتجات.</div>
            ) : (
              <ProductSearchBar
                invoiceType={mode === "in" ? "PURCHASE" : "SALE"}
                branchId={branchId}
                tier="RETAIL"
                onAddProduct={addLine}
                onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.info(msg))}
              />
            )}

            {lines.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-start">المنتج</th>
                      <th className="px-3 py-2 text-start">الوحدة</th>
                      <th className="px-3 py-2 text-start">الكمية</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.key} className="border-t">
                        <td className="px-3 py-2">{l.label}</td>
                        <td className="px-3 py-2">{l.unit}</td>
                        <td className="px-3 py-2">
                          <Input value={l.quantity} onChange={(e) => setLineQty(l.key, e.target.value)} inputMode="numeric" className="h-8 w-24" />
                        </td>
                        <td className="px-3 py-2 text-end">
                          <Button size="icon" variant="ghost" onClick={() => removeLine(l.key)} aria-label="حذف السطر">
                            <Trash2 aria-hidden className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label>ملاحظات (اختياري)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} />
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" onClick={backToList}>
              إلغاء
            </Button>
            <Button onClick={mode === "in" ? submitInbound : submitOutbound} disabled={!canSubmit}>
              <Plus aria-hidden className="me-1 size-4" />
              {busy ? "جارٍ الحفظ…" : mode === "in" ? "استلام" : "منح الهدية"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
