// بطاقة ٣٦٠° لطرف واحد (عميل/مورّد) — مكوّن مساعد لتبويب «جهات الاتصال» في CrmHub.tsx (S3، T3.3).
// يستهلك contacts.contact360 + contacts.persons.{list,create,update,setInactive} +
// contacts.waConsent.set + contacts.findDuplicates (server/routers/contactsRouter.ts).
//
// بلا شاشة مستقلة/route جديد — يُفتح كلوحة جانبية (Sheet) من ContactsBank.tsx. الحجب المالي
// (رصيد/حدّ ائتمان) يُطبَّق خادمياً (maskCustomerSensitive/maskSupplierSensitive) — نعرض القيمة
// كما وصلت بلا افتراض وجود حقول إضافية.
import { useState } from "react";
import { Link } from "wouter";
import {
  Ban,
  ClipboardList,
  MapPin,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Search as SearchIcon,
  Star,
  TriangleAlert,
  Users,
  Wallet,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify, errMsg } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { fmt } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LoadingState, ErrorState } from "@/components/PageState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge as TaskStatusBadge } from "@/pages/TasksHub";

type PartyKind = "customer" | "supplier";
type WaConsentValue = "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
type Contact360Data = RouterOutputs["contacts"]["contact360"];
type PersonRow = RouterOutputs["contacts"]["persons"]["list"][number];

// مرآة CRM_WRITE_ROLES/SUPPLIER_WRITE_ROLES في server/routers/contactsRouter.ts (crmWriteProcedure/
// suppliersManagerProcedure في server/trpc.ts) — للإخفاء البصري فقط، الإنفاذ الحقيقي خادمي.
const CRM_WRITE_ROLES = ["cashier", "manager", "sales_rep"] as const;
const SUPPLIER_WRITE_ROLES = ["manager", "warehouse", "purchasing"] as const;

const TIER_LABEL: Record<string, string> = { RETAIL: "مفرد", WHOLESALE: "جملة", GOVERNMENT: "حكومي" };
const INVOICE_STATUS_LABEL: Record<string, string> = {
  PENDING: "معلّقة",
  CONFIRMED: "مؤكّدة",
  PAID: "مدفوعة",
  PARTIALLY_PAID: "مدفوعة جزئياً",
  CANCELLED: "ملغاة",
  RETURNED: "مرتجعة",
};
const WA_CONSENT_META: Record<WaConsentValue, { label: string; variant: "neutral" | "success" | "danger" }> = {
  UNKNOWN: { label: "غير معروف", variant: "neutral" },
  OPTED_IN: { label: "موافِق", variant: "success" },
  OPTED_OUT: { label: "ملغى", variant: "danger" },
};

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className="text-foreground truncate">{value}</span>
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Icon aria-hidden className="size-4" /> {title}
          </CardTitle>
          {action}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">{children}</CardContent>
    </Card>
  );
}

/* ═══════════ الرأس ═══════════ */

function HeaderCard({ data }: { data: Contact360Data }) {
  if (data.kind === "customer") {
    const c = data.customer;
    return (
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="info">عميل</Badge>
            <span className="font-bold text-lg truncate">{c.name}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <InfoRow icon={Phone} label="الهاتف" value={c.phone ? <span dir="ltr">{c.phone}</span> : "—"} />
            <InfoRow icon={MapPin} label="المدينة" value={c.city || "—"} />
            <InfoRow icon={Users} label="نوع العميل" value={c.customerType || "—"} />
            <InfoRow label="فئة السعر" value={TIER_LABEL[c.defaultPriceTier] ?? c.defaultPriceTier} />
            <InfoRow
              icon={Wallet}
              label="الرصيد الحالي"
              value={<span className="tabular-nums" dir="ltr">{fmt(c.currentBalance)}</span>}
            />
            <InfoRow
              label="حدّ الائتمان"
              value={c.creditLimit == null ? "بلا حدّ / محجوب" : <span className="tabular-nums" dir="ltr">{fmt(c.creditLimit)}</span>}
            />
          </div>
        </CardContent>
      </Card>
    );
  }
  const s = data.supplier;
  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="warning">مورّد</Badge>
          <span className="font-bold text-lg truncate">{s.name}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <InfoRow icon={Phone} label="الهاتف" value={s.phone ? <span dir="ltr">{s.phone}</span> : "—"} />
          <InfoRow icon={MapPin} label="المدينة" value={s.city || "—"} />
          <InfoRow label="التصنيف" value={s.supplierCategory || "—"} />
          <InfoRow label="شروط الدفع" value={s.paymentTerms || "—"} />
          <InfoRow
            icon={Wallet}
            label="الرصيد الحالي"
            value={<span className="tabular-nums" dir="ltr">{fmt(s.currentBalance)}</span>}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/* ═══════════ الموافقة التسويقية (عميل فقط) ═══════════ */

function WaConsentCard({
  customerId,
  consent,
  canWrite,
  onChanged,
}: {
  customerId: number;
  consent: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const setConsent = trpc.contacts.waConsent.set.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الموافقة التسويقية");
      onChanged();
    },
    onError: (e) => notify.err(e),
  });
  const current = (WA_CONSENT_META[consent as WaConsentValue] ? consent : "UNKNOWN") as WaConsentValue;

  return (
    <SectionCard icon={MessageSquare} title="الموافقة التسويقية (واتساب)">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={WA_CONSENT_META[current].variant}>{WA_CONSENT_META[current].label}</Badge>
        {canWrite && (
          <div className="flex gap-1 flex-wrap">
            {(Object.keys(WA_CONSENT_META) as WaConsentValue[]).map((v) => (
              <Button
                key={v}
                type="button"
                size="sm"
                variant={v === current ? "default" : "outline"}
                disabled={setConsent.isPending || v === current}
                onClick={() => setConsent.mutate({ customerId, consent: v })}
              >
                {WA_CONSENT_META[v].label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/* ═══════════ آخر الفواتير (عميل فقط) ═══════════ */

function InvoicesCard({ invoices }: { invoices: Extract<Contact360Data, { kind: "customer" }>["invoices"] }) {
  return (
    <SectionCard icon={Receipt} title="آخر الفواتير">
      {invoices.length === 0 ? (
        <p className="text-xs text-muted-foreground">لا فواتير.</p>
      ) : (
        <ul className="space-y-1">
          {invoices.map((inv) => (
            <li key={inv.id}>
              <Link
                href={`/invoices/${inv.id}`}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <span className="font-mono text-xs shrink-0" dir="ltr">{inv.invoiceNumber}</span>
                <span className="text-xs text-muted-foreground shrink-0">{fmtDate(inv.invoiceDate)}</span>
                <span className="tabular-nums shrink-0" dir="ltr">{fmt(inv.total)}</span>
                <Badge variant="neutral" className="shrink-0">{INVOICE_STATUS_LABEL[inv.status] ?? inv.status}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ═══════════ المهام المفتوحة (عميل فقط) ═══════════ */

function OpenTasksCard({ tasks }: { tasks: Extract<Contact360Data, { kind: "customer" }>["openTasks"] }) {
  return (
    <SectionCard icon={ClipboardList} title="المهام المفتوحة">
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">لا مهام مفتوحة.</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tasks/${t.id}`}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <span className="font-mono text-xs shrink-0" dir="ltr">{t.taskNumber}</span>
                <span className="truncate flex-1">{t.title}</span>
                <TaskStatusBadge status={t.taskStatus} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ═══════════ المحادثات ═══════════ */

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "واتساب",
  INSTAGRAM: "انستغرام",
  TIKTOK: "تيك توك",
  STORE: "المتجر",
  PHONE: "اتصال",
  WALK_IN: "حُضوري",
  OTHER: "أخرى",
};

function ConversationsCard({ conversations }: { conversations: Contact360Data["conversations"] }) {
  return (
    <SectionCard icon={MessageSquare} title="المحادثات">
      {conversations.length === 0 ? (
        <p className="text-xs text-muted-foreground">لا محادثات.</p>
      ) : (
        <ul className="space-y-1">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href="/crm?tab=inbox"
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <span className="shrink-0">{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                <span className="truncate flex-1 text-xs text-muted-foreground">{c.lastMessagePreview ?? "—"}</span>
                <span className="text-xs text-muted-foreground shrink-0" dir="ltr">{fmtDateTime(c.lastMessageAt)}</span>
                {c.unreadCount > 0 && (
                  <Badge variant="destructive" className="shrink-0">{c.unreadCount}</Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ═══════════ أشخاص الاتصال (B2B) ═══════════ */

function PersonFormDialog({
  partyKind,
  partyId,
  person,
  onClose,
  onSaved,
}: {
  partyKind: PartyKind;
  partyId: number;
  person: PersonRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(person?.name ?? "");
  const [phone, setPhone] = useState(person?.phone ?? "");
  const [role, setRole] = useState(person?.role ?? "");
  const [isPrimary, setIsPrimary] = useState(person?.isPrimary ?? false);
  const [notes, setNotes] = useState(person?.notes ?? "");

  const create = trpc.contacts.persons.create.useMutation({
    onSuccess: () => { notify.ok("أُضيف شخص الاتصال"); onSaved(); },
    onError: (e) => notify.err(e),
  });
  const update = trpc.contacts.persons.update.useMutation({
    onSuccess: () => { notify.ok("تم حفظ التعديل"); onSaved(); },
    onError: (e) => notify.err(e),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) { notify.err("اسم شخص الاتصال مطلوب"); return; }
    if (person) {
      update.mutate({
        id: person.id,
        name: trimmedName,
        phone: phone.trim() || null,
        role: role.trim() || null,
        isPrimary,
        notes: notes.trim() || null,
      });
    } else {
      create.mutate({
        customerId: partyKind === "customer" ? partyId : undefined,
        supplierId: partyKind === "supplier" ? partyId : undefined,
        name: trimmedName,
        phone: phone.trim() || undefined,
        role: role.trim() || undefined,
        isPrimary,
        notes: notes.trim() || undefined,
      });
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person ? "تعديل شخص اتصال" : "شخص اتصال جديد"}</DialogTitle>
          <DialogDescription>
            {partyKind === "customer" ? "جهة اتصال إضافية لدى هذا العميل." : "جهة اتصال إضافية لدى هذا المورّد."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cp-name" className="text-xs text-muted-foreground">
              الاسم<span className="text-destructive"> *</span>
            </Label>
            <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="cp-phone" className="text-xs text-muted-foreground">الهاتف</Label>
              <Input id="cp-phone" dir="ltr" value={phone ?? ""} onChange={(e) => setPhone(e.target.value)} maxLength={25} placeholder="07XXXXXXXXX" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-role" className="text-xs text-muted-foreground">الصفة</Label>
              <Input id="cp-role" value={role ?? ""} onChange={(e) => setRole(e.target.value)} maxLength={60} placeholder="مثلاً: مدير مشتريات" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-notes" className="text-xs text-muted-foreground">ملاحظات</Label>
            <Textarea id="cp-notes" value={notes ?? ""} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={255} />
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            جهة الاتصال الأساسية
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContactPersonsCard({
  partyKind,
  partyId,
  canWrite,
}: {
  partyKind: PartyKind;
  partyId: number;
  canWrite: boolean;
}) {
  const utils = trpc.useUtils();
  const input = partyKind === "customer" ? { customerId: partyId } : { supplierId: partyId };
  const list = trpc.contacts.persons.list.useQuery(input);
  const [dialogPerson, setDialogPerson] = useState<PersonRow | "new" | null>(null);

  const setInactive = trpc.contacts.persons.setInactive.useMutation({
    onSuccess: () => {
      notify.ok("تم تعطيل شخص الاتصال");
      utils.contacts.persons.list.invalidate(input);
    },
    onError: (e) => notify.err(e),
  });

  async function deactivate(p: PersonRow) {
    const ok = await confirm({
      variant: "warning",
      title: "تعطيل شخص الاتصال",
      description: `تعطيل «${p.name}»؟ يبقى في السجلّ التاريخي (بلا حذف نهائي).`,
      confirmText: "تعطيل",
    });
    if (!ok) return;
    setInactive.mutate({ id: p.id });
  }

  const rows = list.data ?? [];

  return (
    <SectionCard
      icon={Users}
      title="أشخاص الاتصال"
      action={
        canWrite && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDialogPerson("new")}>
            <Plus aria-hidden className="size-3.5" /> إضافة
          </Button>
        )
      }
    >
      {list.isLoading && <LoadingState className="p-4" />}
      {list.isError && <ErrorState message="تعذّر تحميل أشخاص الاتصال." onRetry={() => list.refetch()} className="p-4" />}
      {!list.isLoading && !list.isError && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">لا أشخاص اتصال مسجَّلون.</p>
      )}
      {rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm ${p.isActive ? "" : "opacity-60"}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium truncate">{p.name}</span>
                  {p.isPrimary && <Star aria-hidden className="size-3.5 text-amber-500 fill-amber-500 shrink-0" />}
                  {!p.isActive && <Badge variant="neutral" className="text-[10px] shrink-0">معطَّل</Badge>}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  {p.role && <span>{p.role}</span>}
                  {p.phone && <span dir="ltr">{p.phone}</span>}
                </div>
              </div>
              {canWrite && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="تعديل شخص الاتصال" onClick={() => setDialogPerson(p)}>
                    <Pencil aria-hidden className="size-3.5" />
                  </Button>
                  {p.isActive && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="تعطيل شخص الاتصال"
                      onClick={() => deactivate(p)}
                      disabled={setInactive.isPending}
                    >
                      <Ban aria-hidden className="size-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {dialogPerson != null && (
        <PersonFormDialog
          partyKind={partyKind}
          partyId={partyId}
          person={dialogPerson === "new" ? null : dialogPerson}
          onClose={() => setDialogPerson(null)}
          onSaved={() => { setDialogPerson(null); utils.contacts.persons.list.invalidate(input); }}
        />
      )}
    </SectionCard>
  );
}

/* ═══════════ كشف الازدواج (v1 — قراءة فقط، بلا دمج) ═══════════ */

function DuplicatesCard({
  kind,
  id,
  onOpenContact,
}: {
  kind: PartyKind;
  id: number;
  onOpenContact: (kind: PartyKind, id: number) => void;
}) {
  const [checked, setChecked] = useState(false);
  const dup = trpc.contacts.findDuplicates.useQuery({ kind, id }, { enabled: false });
  const rows = dup.data ?? [];

  return (
    <SectionCard
      icon={SearchIcon}
      title="كشف الازدواج"
      action={
        <Button type="button" size="sm" variant="outline" onClick={() => { setChecked(true); dup.refetch(); }} disabled={dup.isFetching}>
          {dup.isFetching ? "جارٍ البحث…" : "بحث عن مكرر"}
        </Button>
      }
    >
      {dup.isError && <p className="text-xs text-destructive">{errMsg(dup.error)}</p>}
      {checked && !dup.isFetching && !dup.isError && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">لا نظائر مشابهة.</p>
      )}
      {rows.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 space-y-1.5 dark:bg-amber-950/20">
          <p className="flex items-center gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-400">
            <TriangleAlert aria-hidden className="size-3.5" /> نظائر مرشّحة — للمراجعة اليدوية فقط (بلا دمج تلقائي)
          </p>
          {rows.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">{m.name}</span>
              {m.phone && <span dir="ltr" className="text-xs text-muted-foreground">{m.phone}</span>}
              <Badge variant="neutral" className="text-[10px]">
                {m.matchedOn === "phone" ? "تطابق هاتف" : m.matchedOn === "both" ? "تطابق اسم وهاتف" : "تشابه اسم"}
              </Badge>
              {!m.isActive && <Badge variant="neutral" className="text-[10px]">معطَّل</Badge>}
              <button type="button" className="text-xs text-primary underline" onClick={() => onOpenContact(kind, Number(m.id))}>
                فتح البطاقة
              </button>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/* ═══════════ اللوحة الجانبية الكاملة ═══════════ */

export function Contact360Panel({
  kind,
  id,
  onClose,
  onOpenContact,
}: {
  kind: PartyKind;
  id: number;
  onClose: () => void;
  onOpenContact: (kind: PartyKind, id: number) => void;
}) {
  const me = trpc.auth.me.useQuery();
  const role = (me.data?.role ?? "") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const canWriteCrm = !!role && moduleAccessAllowed(role, override, "crm", "FULL", CRM_WRITE_ROLES);
  const canWriteSuppliers = !!role && moduleAccessAllowed(role, override, "suppliers", "FULL", SUPPLIER_WRITE_ROLES);
  const canWritePersons = kind === "customer" ? canWriteCrm : canWriteCrm && canWriteSuppliers;

  const q = trpc.contacts.contact360.useQuery({ kind, id });

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" dir="rtl" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {q.data?.kind === "customer" ? q.data.customer.name : q.data?.kind === "supplier" ? q.data.supplier.name : "بطاقة ٣٦٠°"}
          </SheetTitle>
          <SheetDescription>{kind === "customer" ? "بطاقة عميل موحّدة" : "بطاقة مورّد موحّدة"}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6 space-y-4">
          {q.isLoading && <LoadingState />}
          {q.isError && <ErrorState message={errMsg(q.error)} onRetry={() => q.refetch()} />}
          {q.data && (
            <>
              <HeaderCard data={q.data} />
              {q.data.kind === "customer" && (
                <WaConsentCard
                  customerId={id}
                  consent={q.data.customer.waConsent}
                  canWrite={canWriteCrm}
                  onChanged={() => q.refetch()}
                />
              )}
              {q.data.kind === "customer" && <InvoicesCard invoices={q.data.invoices} />}
              {q.data.kind === "customer" && <OpenTasksCard tasks={q.data.openTasks} />}
              <ConversationsCard conversations={q.data.conversations} />
              <ContactPersonsCard partyKind={kind} partyId={id} canWrite={canWritePersons} />
              <DuplicatesCard kind={kind} id={id} onOpenContact={onOpenContact} />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
