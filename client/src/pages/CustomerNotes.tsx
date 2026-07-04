// CustomerNotes — تبويب «متابعة العملاء» داخل hub العملاء (CustomersHub.tsx، ?tab=notes).
// اختيار عميل (SmartCustomerInput المشترك) ثم عرض/إضافة/تعديل/إغلاق ملاحظات متابعته
// (مكالمة، وعد بالدفع، متابعة تسليم) مع تاريخ متابعة اختياري وتمييز المتأخرة/اليوم بصرياً.
//
// العقد: خادم customerNotes.{list,dueToday,create,resolve,update,delete} (راوتر منفصل
// customerNoteRouter.ts يُركَّبه القائد في server/routers.ts). هذه الصفحة مبنيّة بالكامل
// على الشكل المتّفق عليه في العقد فتتكامل بلا إعادة عمل فور دمج الخلفية.
import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { SmartCustomerInput, type SmartCustomerValue } from "@/components/form/SmartCustomerInput";
import { CustomerNotesList, type CustomerNoteRow } from "@/components/customers/CustomerNotesList";
import { CustomerNoteForm, type CustomerNoteFormValue } from "@/components/customers/CustomerNoteForm";
import { confirmDelete } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtDate } from "@/lib/date";
import { trpc } from "@/lib/trpc";

const EMPTY_CUSTOMER: SmartCustomerValue = { customerId: null, name: "", phone: null, isNew: false };

export default function CustomerNotes() {
  // الـURL مصدر الحقيقة لهوية العميل ⇒ رابط قابل للمشاركة يتبع نمط CustomerStatement.tsx.
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const customerId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);

  const [customer, setCustomer] = useState<SmartCustomerValue>(EMPTY_CUSTOMER);
  const [editing, setEditing] = useState<CustomerNoteRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const canManage = role === "admin" || role === "manager";

  function selectCustomer(v: SmartCustomerValue) {
    setCustomer(v);
    setEditing(null);
    const p = new URLSearchParams(search);
    if (v.customerId) p.set("id", String(v.customerId)); else p.delete("id");
    const qs = p.toString();
    navigate(qs ? `${loc}?${qs}` : loc, { replace: true });
  }

  // إن أعاد تحميل الصفحة بـ?id= معروف بلا اختيار محلي — نُبقي customerId من الرابط فقط
  // لعرض القائمة (لا حاجة لاسم العميل لعرض الملاحظات، فقط للـUI التوضيحي أعلى القائمة).
  const effectiveCustomerId = customer.customerId ?? customerId;

  const utils = trpc.useUtils();
  const notesQuery = trpc.customerNotes.list.useQuery(
    { customerId: effectiveCustomerId, includeResolved: true, limit: 100 },
    { enabled: !!effectiveCustomerId }
  );
  const dueToday = trpc.customerNotes.dueToday.useQuery(undefined, { enabled: canManage });

  const invalidateList = () => utils.customerNotes.list.invalidate({ customerId: effectiveCustomerId });

  const createMut = trpc.customerNotes.create.useMutation({
    onSuccess: async () => {
      await invalidateList();
      await utils.customerNotes.dueToday.invalidate();
      notify.ok("تمت إضافة الملاحظة");
    },
    onError: (e) => notify.err(e),
  });

  const updateMut = trpc.customerNotes.update.useMutation({
    onSuccess: async () => {
      await invalidateList();
      setEditing(null);
      notify.ok("تم تعديل الملاحظة");
    },
    onError: (e) => notify.err(e),
  });

  const resolveMut = trpc.customerNotes.resolve.useMutation({
    onSuccess: async () => {
      await invalidateList();
      await utils.customerNotes.dueToday.invalidate();
    },
    onError: (e) => notify.err(e),
    onSettled: () => setBusyId(null),
  });

  const deleteMut = trpc.customerNotes.delete.useMutation({
    onSuccess: async () => {
      await invalidateList();
      await utils.customerNotes.dueToday.invalidate();
      notify.ok("تم حذف الملاحظة");
    },
    onError: (e) => notify.err(e),
    onSettled: () => setBusyId(null),
  });

  function handleCreate(v: CustomerNoteFormValue) {
    if (!effectiveCustomerId) return;
    createMut.mutate({ customerId: effectiveCustomerId, note: v.note, followUpDate: v.followUpDate });
  }

  function handleUpdate(v: CustomerNoteFormValue) {
    if (!editing) return;
    updateMut.mutate({ noteId: editing.id, note: v.note, followUpDate: v.followUpDate });
  }

  function handleToggleResolved(n: CustomerNoteRow) {
    setBusyId(n.id);
    resolveMut.mutate({ noteId: n.id, isResolved: !n.isResolved });
  }

  async function handleDelete(n: CustomerNoteRow) {
    const ok = await confirmDelete({
      description: `حذف هذه الملاحظة نهائياً؟ لا يمكن التراجع عن الحذف.`,
    });
    if (!ok) return;
    setBusyId(n.id);
    deleteMut.mutate({ noteId: n.id });
  }

  const notes = (notesQuery.data ?? []) as CustomerNoteRow[];
  const dueTodayRows = (dueToday.data ?? []) as Array<{ id: number; customerId: number; customerName: string; note: string; followUpDate: string }>;

  return (
    <div className="space-y-4">
      <PageHeader
        title="متابعة العملاء"
        description="سجّل ملاحظات المتابعة مع كل عميل (مكالمة، وعد بالدفع، متابعة تسليم) وحدّد تاريخ متابعة."
      />

      {/* لوحة تذكيرات اليوم — لكل العملاء، مدير فأعلى فقط (رؤية شاملة عبر عملاء متعددين). */}
      {canManage && dueTodayRows.length > 0 && (
        <Card className="border-[var(--status-pending)]/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              تذكيرات اليوم والمتأخرة
              <Badge variant="warning">{dueTodayRows.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {dueTodayRows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectCustomer({ customerId: r.customerId, name: r.customerName, phone: null, isNew: false })}
                className="w-full text-right rounded-md border p-2 hover:bg-accent flex flex-col gap-0.5"
              >
                <span className="text-sm font-medium">{r.customerName}</span>
                <span className="text-xs text-muted-foreground truncate">{r.note}</span>
                <span className="text-[11px] text-muted-foreground" dir="ltr">{fmtDate(r.followUpDate)}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">اختر العميل</CardTitle></CardHeader>
        <CardContent>
          <SmartCustomerInput value={customer} onChange={selectCustomer} placeholder="ابحث بالاسم أو الرقم…" />
        </CardContent>
      </Card>

      {!effectiveCustomerId && (
        <p className="text-sm text-muted-foreground text-center py-6">اختر عميلاً أعلاه لعرض ملاحظات المتابعة الخاصة به.</p>
      )}

      {!!effectiveCustomerId && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">{editing ? "تعديل الملاحظة" : "ملاحظة جديدة"}</CardTitle></CardHeader>
            <CardContent>
              <CustomerNoteForm
                key={editing?.id ?? "new"}
                initial={editing ? { note: editing.note, followUpDate: editing.followUpDate } : undefined}
                onSubmit={editing ? handleUpdate : handleCreate}
                onCancel={editing ? () => setEditing(null) : undefined}
                submitting={editing ? updateMut.isPending : createMut.isPending}
                submitLabel={editing ? "حفظ التعديل" : "إضافة الملاحظة"}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">سجلّ الملاحظات</CardTitle></CardHeader>
            <CardContent>
              {notesQuery.isLoading && <LoadingState />}
              {notesQuery.isError && (
                <ErrorState message="تعذّر تحميل ملاحظات هذا العميل." onRetry={() => notesQuery.refetch()} />
              )}
              {!notesQuery.isLoading && !notesQuery.isError && (
                <CustomerNotesList
                  notes={notes}
                  onToggleResolved={handleToggleResolved}
                  onEdit={canManage ? setEditing : undefined}
                  onDelete={canManage ? handleDelete : undefined}
                  busyId={busyId}
                  canManage={canManage}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
