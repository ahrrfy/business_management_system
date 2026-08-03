// الحجوزات — واجهة R-م٣ (النواة). قائمة الحجوزات + حوار حجز جديد (استعلام منتج + بنود) + إلغاء/تمديد.
// الخادم جاهز: server/routers/reservationsRouter.ts + server/services/reservations/*. هذا يستهلكه فقط.
// حجز ناعم (ATP): الإنشاء يعرض تحذير «فوق المتاح» (overbooked) لا يمنع — قرار المالك. العربون/التحويل R-م٤/م٥.
import { useMemo, useState } from "react";
import { ArrowLeftRight, ArrowRight, Banknote, CalendarClock, Clock, CreditCard, Plus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtDateTime } from "@/lib/date";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list/RowActions";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import CustomerPicker from "@/components/CustomerPicker";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine } from "@/components/invoice/types";
import { cn } from "@/lib/utils";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const RESERVATION_WRITE_ROLES = ["cashier", "manager", "sales_rep"] as const;
const RESERVATION_MANAGER_ROLES = ["manager"] as const;

type ReservationStatus = "ACTIVE" | "PARTIALLY_FULFILLED" | "FULFILLED" | "EXPIRED" | "CANCELLED" | "RELEASED";
type Channel = "PHONE" | "WALK_IN" | "WHATSAPP" | "STORE";
type CheckoutMethod = "CASH" | "CARD" | "TRANSFER";
type ReservationRow = RouterOutputs["reservations"]["list"][number];

const STATUS_LABEL: Record<ReservationStatus, string> = {
  ACTIVE: "نشط",
  PARTIALLY_FULFILLED: "منفَّذ جزئياً",
  FULFILLED: "منفَّذ",
  EXPIRED: "منتهٍ",
  CANCELLED: "ملغى",
  RELEASED: "محرَّر",
};
const STATUS_VARIANT: Record<ReservationStatus, "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "default",
  PARTIALLY_FULFILLED: "secondary",
  FULFILLED: "outline",
  EXPIRED: "destructive",
  CANCELLED: "destructive",
  RELEASED: "secondary",
};
const CHANNEL_LABEL: Record<Channel, string> = { PHONE: "هاتف", WALK_IN: "حضور", WHATSAPP: "واتساب", STORE: "متجر" };
const CHANNELS = Object.keys(CHANNEL_LABEL) as Channel[];
const CLOSEABLE: ReservationStatus[] = ["ACTIVE", "PARTIALLY_FULFILLED"];

interface ReservationsHubProps {
  embedded?: boolean;
  fixedBranchId?: number;
  onClose?: () => void;
}

export default function ReservationsHub({ embedded = false, fixedBranchId, onClose }: ReservationsHubProps) {
  const me = trpc.auth.me.useQuery();
  const branches = trpc.branches.list.useQuery();
  const role = (me.data?.role ?? "user") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const canWrite = moduleAccessAllowed(role, override, "reservations", "FULL", RESERVATION_WRITE_ROLES);
  const canManage = moduleAccessAllowed(role, override, "reservations", "FULL", RESERVATION_MANAGER_ROLES) && (role === "admin" || role === "manager");

  const userBranchId = me.data?.branchId ?? null;
  const [branchId, setBranchId] = useState<number | null>(null);
  const effectiveBranch = fixedBranchId ?? branchId ?? userBranchId ?? branches.data?.[0]?.id ?? null;

  const [status, setStatus] = useState<"" | ReservationStatus>("");
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [convertTarget, setConvertTarget] = useState<ReservationRow | null>(null);
  const [convertAmount, setConvertAmount] = useState("");
  const [convertMethod, setConvertMethod] = useState<CheckoutMethod>("CASH");
  const [convertReference, setConvertReference] = useState("");

  const list = trpc.reservations.list.useQuery(
    { status: status || undefined, branchId: effectiveBranch ?? undefined, q: q.trim() || undefined, limit: 200 },
    { enabled: effectiveBranch != null },
  );
  const utils = trpc.useUtils();

  const cancel = trpc.reservations.cancel.useMutation({
    onSuccess: () => { notify.ok("أُلغي الحجز"); utils.reservations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const extend = trpc.reservations.extend.useMutation({
    onSuccess: () => { notify.ok("مُدّد الحجز"); utils.reservations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const convert = trpc.reservations.convert.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُنشئت الفاتورة ${r.invoiceNumber}`);
      setConvertTarget(null);
      setConvertAmount("");
      setConvertReference("");
      utils.reservations.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function onConvert(r: ReservationRow) {
    setConvertTarget(r);
    setConvertAmount("");
    setConvertMethod("CASH");
    setConvertReference("");
  }
  function submitConversion() {
    if (!convertTarget) return;
    const amount = convertAmount.trim();
    if (amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      notify.err("أدخل مبلغاً صحيحاً أكبر من صفر، أو اتركه فارغاً للبيع الآجل");
      return;
    }
    if (amount && convertMethod !== "CASH" && !convertReference.trim()) {
      notify.err(convertMethod === "CARD" ? "رقم عملية البطاقة مطلوب" : "رقم مرجع التحويل مطلوب");
      return;
    }
    if (!amount && !convertTarget.customerId) {
      notify.err("لا يمكن البيع الآجل لحجز بلا عميل مسجل؛ أدخل دفعة أو اربط الحجز بعميل");
      return;
    }
    const payment = amount
      ? { amount, method: convertMethod, reference: convertMethod === "CASH" ? null : convertReference.trim() }
      : null;
    convert.mutate({ reservationId: Number(convertTarget.id), payment });
  }
  function onCancel(r: ReservationRow) {
    const reason = window.prompt("سبب إلغاء الحجز (اختياري):", "");
    if (reason === null) return; // ألغى الحوار
    cancel.mutate({ id: Number(r.id), reason: reason.trim() || null });
  }
  function onExtend(r: ReservationRow) {
    const raw = window.prompt("مدّة التمديد بالساعات (١–٧٢):", "24");
    if (raw === null) return;
    const hours = Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) { notify.err("مدّة غير صالحة (١–٧٢ ساعة)"); return; }
    extend.mutate({ id: Number(r.id), hours });
  }

  const rows = list.data ?? [];

  return (
    <div className={cn("space-y-4", embedded && "h-full overflow-y-auto bg-background p-4")}>
      {embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <CalendarClock className="size-5" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-extrabold">حجوزات خدمة العملاء</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                أنشئ الحجز أو ابحث عنه، ثم حوّله إلى طلب عند حضور العميل.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canWrite && (
              <Button size="sm" onClick={() => setShowNew(true)} disabled={effectiveBranch == null}>
                <Plus aria-hidden className="size-4 me-1" /> حجز جديد
              </Button>
            )}
            {onClose && (
              <Button size="sm" variant="outline" onClick={onClose}>
                <ArrowRight aria-hidden className="size-4 me-1" /> العودة إلى الطلب
              </Button>
            )}
          </div>
        </div>
      ) : (
        <PageHeader
          title="الحجوزات"
          description="حجز منتجات للعملاء بمدّة انتهاء — حجز ناعم يخصم «المتاح» دون مسّ المخزون الفعلي. يُستدعى عند حضور العميل ليتحوّل إلى فاتورة."
          icon={<CalendarClock className="size-5" aria-hidden />}
          actions={
            canWrite ? (
              <Button size="sm" onClick={() => setShowNew(true)} disabled={effectiveBranch == null}>
                <Plus aria-hidden className="size-4 me-1" /> حجز جديد
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* منتقي الفرع للمرتفعين فقط (Codex P2): غير المرتفع مُقيَّد بفرعه خادمياً، فإظهاره يضلّله. */}
        {fixedBranchId == null && (role === "admin" || role === "manager") && (branches.data?.length ?? 0) > 1 && (
          <select
            className={selectCls}
            value={effectiveBranch ?? ""}
            onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
            aria-label="الفرع"
          >
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as "" | ReservationStatus)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          {(Object.keys(STATUS_LABEL) as ReservationStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <div className="relative flex-1 min-w-52">
          <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground"><Search className="size-4" /></span>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث برقم الحجز أو اسم/هاتف العميل…" className="pe-9" />
        </div>
      </div>

      {list.isLoading ? (
        <LoadingState />
      ) : list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : (
        <ScrollTableShell>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>رقم الحجز</TableHead>
                <TableHead>العميل</TableHead>
                <TableHead>الهاتف</TableHead>
                <TableHead>طريقة وصول الحجز</TableHead>
                <TableHead>الحالة</TableHead>
                <TableHead>ينتهي</TableHead>
                <TableHead>إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">لا حجوزات مطابقة.</TableCell></TableRow>
              ) : (
                rows.map((r) => {
                  const st = r.status as ReservationStatus;
                  const closeable = CLOSEABLE.includes(st);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono" dir="ltr">{r.reservationNumber}</TableCell>
                      <TableCell>{r.contactName || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell dir="ltr">{r.contactPhone}</TableCell>
                      <TableCell>{CHANNEL_LABEL[r.channel as Channel] ?? r.channel}</TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[st]}>{STATUS_LABEL[st] ?? st}</Badge></TableCell>
                      <TableCell className="text-xs" dir="ltr">{r.expiresAt ? fmtDateTime(r.expiresAt) : "—"}</TableCell>
                      <TableCell>
                        <RowActions
                          mode="auto"
                          actions={[
                            {
                              key: "convert",
                              kind: "create",
                              label: "تحويل إلى فاتورة",
                              icon: ShoppingCart,
                              hidden: !canWrite || !closeable,
                              gate: { roles: ["cashier", "manager", "sales_rep"], module: "reservations", level: "FULL" },
                              disabled: convert.isPending,
                              disabledReason: "جارٍ تحويل الحجز",
                              onSelect: () => onConvert(r),
                            },
                            {
                              key: "cancel",
                              kind: "delete",
                              label: "إلغاء الحجز",
                              icon: Trash2,
                              variant: "destructive",
                              hidden: !canWrite || !closeable,
                              gate: { roles: ["cashier", "manager", "sales_rep"], module: "reservations", level: "FULL" },
                              disabled: cancel.isPending,
                              disabledReason: "جارٍ إلغاء الحجز",
                              onSelect: () => onCancel(r),
                            },
                            {
                              key: "extend",
                              kind: "edit",
                              label: "تمديد الحجز",
                              icon: Clock,
                              hidden: !canManage || !closeable,
                              gate: { roles: ["manager"], module: "reservations", level: "FULL" },
                              disabled: extend.isPending,
                              disabledReason: "جارٍ تمديد الحجز",
                              onSelect: () => onExtend(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </ScrollTableShell>
      )}

      {showNew && effectiveBranch != null && (
        <NewReservationDialog
          branchId={effectiveBranch}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); utils.reservations.list.invalidate(); }}
        />
      )}

      <Dialog open={convertTarget != null} onOpenChange={(open) => !open && !convert.isPending && setConvertTarget(null)}>
        <DialogContent className="sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>تحويل الحجز إلى طلب</DialogTitle>
            <DialogDescription>
              الحجز {convertTarget?.reservationNumber} جاهز للتنفيذ. أدخل المبلغ الذي استلمته من العميل الآن.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="reservation-payment-amount">المبلغ المدفوع الآن (د.ع)</Label>
              <MoneyInput
                id="reservation-payment-amount"
                value={convertAmount}
                onChange={setConvertAmount}
                decimals={0}
                placeholder="اتركه فارغاً للبيع الآجل"
                ariaLabel="المبلغ المدفوع عند تحويل الحجز"
              />
              <p className="text-[11px] text-muted-foreground">النقد يُضاف إلى مبلغ الدرج. البطاقة والتحويل يُسجّلان منفصلين.</p>
            </div>

            {convertAmount.trim() && Number(convertAmount) > 0 ? (
              <div className="space-y-2">
                <Label>طريقة الدفع</Label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { value: "CASH", label: "نقدي", Icon: Banknote },
                    { value: "CARD", label: "بطاقة", Icon: CreditCard },
                    { value: "TRANSFER", label: "تحويل", Icon: ArrowLeftRight },
                  ] as const).map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { setConvertMethod(value); if (value === "CASH") setConvertReference(""); }}
                      className={cn(
                        "flex h-14 flex-col items-center justify-center gap-1 rounded-lg border-2 text-xs font-extrabold transition-colors",
                        convertMethod === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                      )}
                    >
                      <Icon className="size-4" aria-hidden /> {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {convertAmount.trim() && Number(convertAmount) > 0 && convertMethod !== "CASH" ? (
              <div className="space-y-1.5">
                <Label htmlFor="reservation-payment-reference">
                  {convertMethod === "CARD" ? "رقم عملية البطاقة" : "رقم مرجع التحويل"} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="reservation-payment-reference"
                  value={convertReference}
                  onChange={(e) => setConvertReference(e.target.value)}
                  maxLength={100}
                  autoComplete="off"
                  placeholder="أدخل الرقم الظاهر في الإيصال أو تطبيق البنك"
                  dir="ltr"
                />
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setConvertTarget(null)} disabled={convert.isPending}>إلغاء</Button>
            <Button onClick={submitConversion} disabled={convert.isPending}>
              <ShoppingCart className="size-4 me-1" aria-hidden />
              {convert.isPending ? "جارٍ الإتمام…" : "تأكيد الطلب"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface LineDraft {
  variantId: number;
  productUnitId: number;
  name: string;
  unit: string;
  stockBase: number;
  price: string;
  qty: number;
}

function NewReservationDialog({ branchId, onClose, onCreated }: { branchId: number; onClose: () => void; onCreated: () => void }) {
  const [contactPhone, setContactPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [channel, setChannel] = useState<Channel>("PHONE");
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);

  const create = trpc.reservations.create.useMutation({
    onSuccess: (r) => {
      if (r.overbookedVariantIds.length > 0) {
        notify.warn(`أُنشئ الحجز ${r.reservationNumber} — تنبيه: ${r.overbookedVariantIds.length} منتج محجوز فوق المتاح.`);
      } else {
        notify.ok(`أُنشئ الحجز ${r.reservationNumber}`);
      }
      onCreated();
    },
    onError: (e) => notify.err(e),
  });

  function addFromSearch(line: InvoiceLine) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.variantId === line.variantId && l.productUnitId === line.productUnitId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, {
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        name: line.name,
        unit: line.unit,
        stockBase: line.stockBase,
        price: line.price || "0",
        qty: 1,
      }];
    });
  }
  function setQty(i: number, qty: number) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, qty } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    if (!contactPhone.trim()) { notify.err("هاتف العميل مطلوب"); return; }
    if (lines.length === 0) { notify.err("أضف منتجاً واحداً على الأقل"); return; }
    if (lines.some((l) => !(l.qty > 0))) { notify.err("كل كمية يجب أن تكون موجبة"); return; }
    const hours = Number(expiresInHours);
    create.mutate({
      branchId,
      contactPhone: contactPhone.trim(),
      contactName: contactName.trim() || null,
      customerId,
      channel,
      expiresInHours: Number.isInteger(hours) && hours > 0 && hours <= 72 ? hours : null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        quantity: l.qty,
        quotedUnitPrice: l.price,
      })),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>حجز جديد</DialogTitle>
          <DialogDescription>احجز منتجات لعميل بمدّة انتهاء. الهاتف إلزاميّ لاستدعاء الحجز عند الحضور.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[70vh] overflow-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="res-phone">هاتف العميل *</Label>
              <IntlPhoneInput id="res-phone" value={contactPhone} onChange={setContactPhone} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="res-name">اسم العميل</Label>
              <Input id="res-name" placeholder="اختياري" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
          </div>

          <CustomerPicker customerId={customerId} onCustomerChange={setCustomerId} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="res-channel">طريقة وصول الحجز</Label>
              <select id="res-channel" className={`${selectCls} w-full`} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="res-hours">مدّة الحجز (ساعات، ≤٧٢)</Label>
              <Input id="res-hours" dir="ltr" type="number" min={1} max={72} value={expiresInHours} onChange={(e) => setExpiresInHours(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>المنتجات</Label>
            <ProductSearchBar invoiceType="SALE" branchId={branchId} tier="RETAIL" onAddProduct={addFromSearch} onNotify={(m, k) => (k === "error" ? notify.err(m) : notify.info(m))} />
            {lines.length > 0 && (
              <div className="rounded-md border divide-y">
                {lines.map((l, i) => (
                  <div key={`${l.variantId}-${l.productUnitId}`} className="flex items-center gap-2 p-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{l.name}</div>
                      <div className="text-xs text-muted-foreground">{l.unit} · مخزون {l.stockBase.toLocaleString("en-US")}</div>
                    </div>
                    <Input
                      dir="ltr" type="number" min={1} step="any" className="w-20 h-8"
                      value={l.qty}
                      onChange={(e) => setQty(i, Number(e.target.value))}
                      aria-label="الكمية"
                    />
                    <Button size="sm" variant="ghost" onClick={() => removeLine(i)} aria-label="حذف المنتج"><X aria-hidden className="size-4" /></Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="res-notes">ملاحظات</Label>
            <Input id="res-notes" placeholder="اختياري" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={create.isPending || !contactPhone.trim() || lines.length === 0}>
            {create.isPending ? "جارٍ…" : "إنشاء الحجز"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
