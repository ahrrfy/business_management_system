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
import { AppSelect } from "@/components/ui/AppSelect";
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
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { buildOperationalContactMessage } from "@/lib/whatsapp";

const EMPTY_CUSTOMER: SmartCustomerValue = { customerId: null, name: "", phone: null, isNew: false };

export default function CustomerNotes() {
  // الـURL مصدر الحقيقة لهوية العميل ⇒ رابط قابل للمشاركة يتبع نمط CustomerStatement.tsx.
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const customerId = useMemo(() => Number(new URLSearchParams(search).get("id")) || 0, [search]);

  const [customer, setCustomer] = useState<SmartCustomerValue>(EMPTY_CUSTOMER);
  const [editing, setEditing] = useState<CustomerNoteRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // إخفاء المحلولة + بحث نصّي + ترقيم صفحات حقيقي (بدل اقتطاع ١٠٠ صامت) — الراوتر يدعمها فعلياً.
  const [hideResolved, setHideResolved] = useState(false);
  const [noteQuery, setNoteQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const NOTES_LIMIT = 20;

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const permsOverride = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  // بوّابتان بمرآة راوتر customerNotes بنفس دالة الخادم moduleAccessAllowed (لا قائمة أدوار حرفية):
  // الكتابة (create/resolve) = customersCashierProcedure(["cashier","manager","sales_rep"], customers, FULL)
  // والإدارة (update/delete/dueToday) = customersManagerProcedure(["manager"], customers, FULL).
  const canWrite =
    !!role && moduleAccessAllowed(role as RoleKey, permsOverride, "customers", "FULL", ["cashier", "manager", "sales_rep"]);
  const canManage = !!role && moduleAccessAllowed(role as RoleKey, permsOverride, "customers", "FULL", ["manager"]);

  // فرع كتابة الملاحظة: customerNoteRouter.create يكتب branchId فعلياً على الصفّ — الأدمن/المدير
  // بلا فرع مُسنَد يختار صراحةً بدل تثبيتٍ صامت (نمط PR #288). كاشير/مندوب مبيعات لهما فرع دائماً
  // (requireOwnBranch يفرضه) فلا تظهر لهما هذه اللافتة أصلاً.
  const [pickedBranch, setPickedBranch] = useState<number | null>(null);
  const needsBranchChoice = me.data != null && me.data.branchId == null && canWrite;
  const branchesQ = trpc.branches.list.useQuery(undefined, { enabled: needsBranchChoice });
  const effectiveNoteBranchId = me.data?.branchId != null ? Number(me.data.branchId) : pickedBranch;

  function selectCustomer(v: SmartCustomerValue) {
    setCustomer(v);
    setEditing(null);
    setOffset(0);
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
    {
      customerId: effectiveCustomerId,
      includeResolved: !hideResolved,
      q: noteQuery.trim() || undefined,
      limit: NOTES_LIMIT,
      offset,
    },
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
    if (effectiveNoteBranchId == null) {
      notify.err("اختر الفرع أولاً قبل إضافة الملاحظة");
      return;
    }
    createMut.mutate({ customerId: effectiveCustomerId, note: v.note, followUpDate: v.followUpDate, branchId: effectiveNoteBranchId });
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

  const notes = (notesQuery.data?.rows ?? []) as CustomerNoteRow[];
  const notesTotal = notesQuery.data?.total ?? 0;
  const notesPages = Math.max(1, Math.ceil(notesTotal / NOTES_LIMIT));
  const dueTodayRows = (dueToday.data ?? []) as Array<{ id: number; customerId: number; customerName: string; customerPhone: string | null; note: string; followUpDate: string }>;

  return (
    <div className="space-y-4">
      <PageHeader
        title="متابعة العملاء"
        description="سجّل ملاحظات المتابعة مع كل عميل (مكالمة، وعد بالدفع، متابعة تسليم) وحدّد تاريخ متابعة."
      />

      {needsBranchChoice && effectiveNoteBranchId == null && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--sem-warn)]/50 bg-[var(--sem-warn-bg)] p-2 text-sm text-[var(--sem-warn)]">
          <span>اختر الفرع لإسناد ملاحظات المتابعة إليه:</span>
          <AppSelect
            className="h-8 w-48"
            value=""
            onValueChange={(v) => setPickedBranch(v ? Number(v) : null)}
            aria-label="فرع الملاحظة"
            placeholder="— اختر الفرع —"
          >
            {(branchesQ.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </AppSelect>
        </div>
      )}

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
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-md border p-2"
              >
                <button
                  type="button"
                  onClick={() => selectCustomer({ customerId: r.customerId, name: r.customerName, phone: r.customerPhone, isNew: false })}
                  className="min-w-0 flex-1 text-right hover:bg-accent rounded p-1 flex flex-col gap-0.5"
                >
                  <span className="text-sm font-medium">{r.customerName}</span>
                  <span className="text-xs text-muted-foreground truncate">{r.note}</span>
                  <span className="text-[11px] text-muted-foreground" dir="ltr">{fmtDate(r.followUpDate)}</span>
                </button>
                <WhatsAppShare
                  phone={r.customerPhone}
                  message={buildOperationalContactMessage({
                    entityLabel: "متابعة عميل",
                    reference: String(r.id),
                    partyName: r.customerName,
                    title: r.note,
                    dueAt: r.followUpDate,
                    nextAction: "نتواصل معكم بخصوص المتابعة المسجلة لدينا.",
                  })}
                  label={`واتساب ${r.customerName}`}
                  size="icon-sm"
                  iconOnly
                />
              </div>
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
          {/* نموذج الإضافة/التعديل — مرآة بوّابة الكتابة الخادمية؛ دور القراءة يرى السجلّ بلا نموذج. */}
          {canWrite && (
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
          )}

          <Card>
            <CardHeader className="space-y-2">
              <CardTitle className="text-base">سجلّ الملاحظات {notesTotal > 0 && <span className="text-muted-foreground font-normal">({notesTotal})</span>}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={noteQuery}
                  onChange={(e) => { setNoteQuery(e.target.value); setOffset(0); }}
                  placeholder="بحث في نص الملاحظات…"
                  className="h-8 min-w-48 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={hideResolved}
                    onChange={(e) => { setHideResolved(e.target.checked); setOffset(0); }}
                  />
                  إخفاء المحلولة
                </label>
              </div>
            </CardHeader>
            <CardContent>
              {notesQuery.isLoading && <LoadingState />}
              {notesQuery.isError && (
                <ErrorState message="تعذّر تحميل ملاحظات هذا العميل." onRetry={() => notesQuery.refetch()} />
              )}
              {!notesQuery.isLoading && !notesQuery.isError && (
                <>
                  <CustomerNotesList
                    notes={notes}
                    onToggleResolved={canWrite ? handleToggleResolved : undefined}
                    onEdit={canManage ? setEditing : undefined}
                    onDelete={canManage ? handleDelete : undefined}
                    busyId={busyId}
                    canManage={canManage}
                  />
                  {notesPages > 1 && (
                    <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 disabled:opacity-40"
                        disabled={offset <= 0}
                        onClick={() => setOffset((o) => Math.max(0, o - NOTES_LIMIT))}
                      >
                        ← السابق
                      </button>
                      <span>صفحة {Math.floor(offset / NOTES_LIMIT) + 1} من {notesPages}</span>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 disabled:opacity-40"
                        disabled={offset + NOTES_LIMIT >= notesTotal}
                        onClick={() => setOffset((o) => o + NOTES_LIMIT)}
                      >
                        التالي →
                      </button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
