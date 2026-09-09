// حوار تعديل تفاصيل أمر الشغل — مستخرج من WorkOrders.tsx لخفض حجم الصفحة.
import { useEffect, useRef, useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/form/MoneyInput";
import CustomerPicker from "@/components/CustomerPicker";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { D, fmtAr, round2 } from "@/lib/money";
import { canCancelWorkOrder } from "@/lib/workOrderRefundPolicy";
import { newClientRequestId } from "@/lib/countQueue";
import { ACTION_LABELS } from "@shared/actionLabels";
import { WORK_ORDER_CHANNELS, receptionChannelOptions } from "@shared/receptionChannel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** ثابت تنسيق حقل الإدخال — مُكرَّر من WorkOrders.tsx بدل التصدير لتجنّب الارتباط الدوريّ. */
const dlgInput = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** خيارات الأولوية — نسخة خفيفة للتعديل فقط (الأصل في WorkOrders.tsx يحمل `cls` و`rank` أيضاً). */
const PRIORITIES: Record<string, { label: string }> = {
  LOW: { label: "منخفضة" },
  NORMAL: { label: "عادية" },
  URGENT: { label: "عاجلة" },
};

// ─────────────── تعديل تفاصيل الطلب (مديرٌ فأعلى — يقفل بعد DELIVERED/CANCELLED) ───────────────
type EditForm = {
  title: string;
  customizationText: string;
  salePrice: string;
  dueDate: string;
  priority: "LOW" | "NORMAL" | "URGENT";
  customerId: number | null;
  contactName: string;
  contactPhone: string;
  receptionChannel: "WALK_IN" | "WHATSAPP" | "INSTAGRAM" | "TIKTOK" | "PHONE" | "OTHER";
  channelHandle: string;
};

export function EditWorkOrderDialog({ workOrderId, onClose, onSaved }: { workOrderId: number | null; onClose: () => void; onSaved: () => void }) {
  const detail = trpc.workOrders.get.useQuery({ workOrderId: workOrderId ?? 0 }, { enabled: workOrderId != null });
  const preflight = trpc.workOrders.controlPreflight.useQuery(
    { workOrderId: workOrderId ?? 0 },
    { enabled: workOrderId != null },
  );
  const me = trpc.auth.me.useQuery();
  const [form, setForm] = useState<EditForm | null>(null);
  const [reason, setReason] = useState("");
  const requestKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const hasDirectAuthority = canCancelWorkOrder(me.data?.role, me.data?.permissionsOverride ?? null);

  // يعبّئ النموذج من بيانات الخادم عند فتح طلبٍ جديد — لا يُعيد الكتابة فوق تعديلات المستخدم
  // الجارية إن أُعيد جلب نفس الطلب (invalidate) أثناء الفتح.
  useEffect(() => {
    const d = detail.data;
    setForm(
      d
        ? {
            title: d.title,
            customizationText: d.customizationText ?? "",
            salePrice: d.salePrice,
            dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : "",
            priority: (d.priority as EditForm["priority"]) ?? "NORMAL",
            customerId: d.customerId ?? null,
            contactName: d.contactName ?? "",
            contactPhone: d.contactPhone ?? "",
            receptionChannel: d.receptionChannel ?? "WALK_IN",
            channelHandle: d.channelHandle ?? "",
          }
        : null,
    );
  }, [detail.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = trpc.workOrders.update.useMutation({
    onSuccess: () => { notify.ok("حُفظ التعديل"); onSaved(); },
    onError: (e) => notify.err(e),
  });
  const requestControl = trpc.workOrders.requestControl.useMutation({
    onSuccess: (result) => {
      notify.ok(result.replayed
        ? "أُعيد تحميل طلب التعديل السابق — ما زال بانتظار مراجع مستقل."
        : "أُرسل طلب التعديل بلا تغيير فوري؛ ينتظر اعتماد مدير مستقل.");
      requestKeyRef.current = null;
      onSaved();
    },
    onError: (e) => notify.err(e),
  });

  if (workOrderId == null) return null;
  const d = detail.data;
  const locked = !!d && (d.status === "DELIVERED" || d.status === "CANCELLED");
  const deposit = D(d?.deposit ?? 0);
  const canDirect =
    hasDirectAuthority &&
    preflight.data?.controlRequired.commercial === false;

  function submit() {
    if (!form) return;
    const title = form.title.trim();
    if (!title) { notify.err("عنوان الطلب مطلوب"); return; }
    const priceD = D(form.salePrice);
    if (priceD.lte(0)) { notify.err("السعر يجب أن يكون أكبر من صفر"); return; }
    if (priceD.lt(deposit)) { notify.err(`السعر أقلّ من العربون المقبوض سلفاً (${fmtAr(deposit.toFixed(2))} د.ع)`); return; }
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 3) { notify.err("سبب التعديل مطلوب من 3 محارف على الأقل"); return; }
    const payload = {
      title,
      customizationText: form.customizationText.trim() || null,
      salePrice: round2(priceD).toFixed(2),
      dueDate: form.dueDate || null,
      priority: form.priority,
      customerId: form.customerId,
      contactName: form.contactName.trim() || null,
      contactPhone: form.contactPhone.trim() || null,
      receptionChannel: form.receptionChannel,
      channelHandle: form.channelHandle.trim() || null,
    };
    if (canDirect) {
      update.mutate({ workOrderId: workOrderId!, expectedVersion: Number(d?.version), reason: normalizedReason, ...payload });
      return;
    }
    const fingerprint = JSON.stringify({ workOrderId, version: d?.version, normalizedReason, payload });
    const existing = requestKeyRef.current;
    const requestKey = existing?.fingerprint === fingerprint ? existing.key : newClientRequestId();
    requestKeyRef.current = { fingerprint, key: requestKey };
    requestControl.mutate({
      requestType: "COMMERCIAL_EDIT",
      requestKey,
      workOrderId: workOrderId!,
      baseVersion: Number(d?.version),
      reason: normalizedReason,
      payload,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>تعديل طلب الخدمة{d ? ` — ${d.orderNumber}` : ""}</DialogTitle>
          <DialogDescription>
            {locked
              ? "هذا الطلب مُسلَّم أو مُلغى — لا يمكن تعديله بعد الآن."
              : canDirect
                ? "يسري التعديل فوراً لأن الأمر لم يبدأ ولم يُقبض عليه شيء. الكمية والمواد لا تُعدَّلان من هنا."
                : "سيُرسل التعديل بلا أثر فوري إلى مراجع مستقل لأن الأمر بدأ أو قُبض عليه مبلغ."}
          </DialogDescription>
        </DialogHeader>
        {!d || !form ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{detail.isLoading ? ACTION_LABELS.loading : "تعذّر العثور على الطلب."}</div>
        ) : locked ? (
          <DialogFooter><button className="wob-btn wob-btn-ghost" onClick={onClose}>إغلاق</button></DialogFooter>
        ) : (
          <>
            <div className="grid gap-3 py-1 max-h-[65vh] overflow-y-auto pe-1">
              <div className="space-y-1">
                <Label>عنوان الطلب</Label>
                <input className={dlgInput} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>التخصيص/الملاحظات</Label>
                <Textarea value={form.customizationText} onChange={(e) => setForm({ ...form, customizationText: e.target.value })} rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>سعر البيع</Label>
                  <MoneyInput value={form.salePrice} onChange={(v) => setForm({ ...form, salePrice: v })} className={dlgInput} />
                  {deposit.gt(0) && <p className="text-xs text-muted-foreground">لا يقلّ عن العربون المقبوض: {fmtAr(deposit.toFixed(2))} د.ع</p>}
                </div>
                <div className="space-y-1">
                  <Label>موعد الاستحقاق</Label>
                  <input type="date" className={dlgInput} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="wo-edit-priority">الأولوية</Label>
                  <AppSelect id="wo-edit-priority" value={form.priority} onValueChange={(value) => setForm({ ...form, priority: value as EditForm["priority"] })}>
                    {Object.entries(PRIORITIES).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                  </AppSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wo-edit-channel">قناة الاستلام</Label>
                  <AppSelect id="wo-edit-channel" value={form.receptionChannel} onValueChange={(value) => setForm({ ...form, receptionChannel: value as EditForm["receptionChannel"] })}>
                    {receptionChannelOptions(WORK_ORDER_CHANNELS).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </AppSelect>
                </div>
              </div>
              {form.receptionChannel !== "WALK_IN" && (
                <div className="space-y-1">
                  <Label>معرّف القناة (رقم/حساب)</Label>
                  <input className={dlgInput} value={form.channelHandle} onChange={(e) => setForm({ ...form, channelHandle: e.target.value })} />
                </div>
              )}
              <CustomerPicker customerId={form.customerId} onCustomerChange={(id) => setForm({ ...form, customerId: id })} />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>اسم مرجعي (زبون عابر بلا سجلّ)</Label>
                  <input className={dlgInput} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>هاتف مرجعي</Label>
                  <IntlPhoneInput value={form.contactPhone} onChange={(v) => setForm({ ...form, contactPhone: v })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label>سبب التعديل</Label>
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} placeholder="ما الذي تغيّر ولماذا؟" />
              </div>
            </div>
            <DialogFooter>
              <button className="wob-btn wob-btn-ghost" onClick={onClose} disabled={update.isPending || requestControl.isPending}>إلغاء</button>
              <button className="wob-btn wob-btn-primary" disabled={update.isPending || requestControl.isPending || reason.trim().length < 3} onClick={submit}>
                {update.isPending || requestControl.isPending ? ACTION_LABELS.saving : canDirect ? "حفظ التعديل" : "إرسال طلب التعديل"}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
