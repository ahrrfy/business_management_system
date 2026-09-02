import { workOrderStatusBadgeCls, workOrderStatusLabel } from "@shared/workOrderStatus";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Package, Store, Truck, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/PageState";
import { RowActions, type RowAction } from "@/components/list";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { MoneyInput } from "@/components/form/MoneyInput";
import { DispatchDialog, type DispatchParty } from "@/components/delivery/DispatchDialog";
import { MarkPickedUpDialog } from "@/components/delivery/MarkPickedUpDialog";
import { ManagerApprovalDialog } from "@/components/reception/ManagerApprovalDialog";
import { ReclassifyDeliveryDialog } from "@/components/workorder/ReclassifyDeliveryDialog";
import { printDeliverySlip, printReadyOrderLabel } from "@/lib/printing/deliveryDocs";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import { D, fmt, round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { playReadyBeep } from "@/lib/notifyBeep";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { deriveWoDeliveryState, woDeliveryStateLabel, WO_DELIVERY_STATE_CLS } from "@shared/workOrderDeliveryState";
import { isPartialDispatchRejection } from "@shared/partialDispatch";
import { computeStateAgeMinutes, formatAgeShort, slaLevel, slaLevelChipClass } from "@shared/orderSla";
import { cn } from "@/lib/utils";
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";

type QueueRow = RouterOutputs["workOrders"]["list"][number];
type PickupPayment = NonNullable<RouterInputs["workOrders"]["deliver"]["payment"]>;
type PartialPickup = { row: QueueRow; payment?: PickupPayment; message: string; clientRequestId: string };

// مرآة بوّابتي الخادم بالضبط (لا مفتاح وحدة صلاحيات منفصل لـ"delivery" — راجع server/trpc.ts):
//   workOrders.deliver / workOrders.setDeliveryMethod ⇐ workordersCashierProcedure (كاشير/مدير + وحدة workorders=FULL).
//   delivery.dispatch ⇐ cashierProcedure الخام (كاشير/مدير بلا مفتاح وحدة).
const FULFILL_GATE: RoleGate = { roles: ["cashier", "manager"], module: "workorders", level: "FULL" };
const DISPATCH_GATE: RoleGate = { roles: ["cashier", "manager"] };

// صافرة الجاهزيّة استُخرجت إلى @/lib/notifyBeep — تُستعمل هنا وفي DeliveryHub معاً (Slice A، ٢٩/٨/٢٦).

/**
 * اِستقبال (تكامل التوصيل، ٤/٨): طابور طلبات الاستقبال — الفجوة التي أبلغ عنها المالك («بعد إكمال
 * الطلب كيف نحوّله للتوصيل؟ لا يظهر جدول طلبات ولا إسناد لمندوب»). ثلاثة أقسام (جاهزة/قيد التنفيذ/
 * سُلِّمت اليوم)، وكل صفٍّ يحمل إجراءات ديناميكية بحسب حالته وطريقة تسليمه: استلام مباشر، إسناد
 * لمندوب، أو إعادة تصنيف الطريقة (السيناريو الثالث: زبونٌ غيّر رأيه بين الاستلام والتوصيل).
 */
export default function ReceptionOrderQueue({ branchId }: { branchId: number }) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role as RoleKey | undefined;
  const permissions = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const canFulfill = !!role && moduleAccessAllowed(
    role,
    permissions,
    "workorders",
    "FULL",
    ["cashier", "manager"],
  );
  // dispatch لا يزال خلف cashierProcedure الخام، لكن بناء حواره يحتاج listParties المحروس بـstore:READ.
  // نجمع العقدين كي لا نعرض إجراءً يتوقف دائماً عند استعلام جهاتٍ سيرفضه الخادم بـ403.
  const canDispatch = canFulfill
    && canSeeGate(DISPATCH_GATE, role, permissions)
    && hasModuleAccess(role ?? "", permissions, "store", "READ");
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Polling كل ١٥ث + على استعادة التركيز: بلاغ المالك ٢٨/٨/٢٦ («الطلب يتيه — الاستقبال لا يرى»).
  // كان `useQuery` بلا refetchInterval إطلاقاً — لا يحدَّث الطابور إلا بإعادة تحميلٍ يدويٍّ أو
  // بـinvalidate من إجراءِ هذه الشاشة نفسها. إشعارُ «طلبك جاهز» يذهب للعميل بواتساب، والموظّف
  // لا يعلم حتى يفتح الشاشة (T4 من تدقيق ٢٨/٨). refetchInterval ثابتٌ لا يتغيّر بتغيّر البيانات
  // (كي لا تُتَخذ الشاشة نفسها ذريعةً لتوقّف polling حين تصفر النتائج).
  const active = trpc.workOrders.list.useQuery(
    { branchId, statuses: ["RECEIVED", "IN_PROGRESS", "READY"], limit: 200 },
    { refetchInterval: 15_000, refetchOnWindowFocus: true },
  );
  // مُتَسلَّم اليوم بصرف النظر عن تاريخ إنشاء الأمر (قد يكون أمس) — deliveredFrom/deliveredTo
  // يفلتران على workOrders.deliveredAt، لا from/to (تاريخ الإنشاء، يُخفي أوامر أُنشئت أمس وسُلِّمت اليوم).
  const deliveredToday = trpc.workOrders.list.useQuery(
    { branchId, statuses: ["DELIVERED"], deliveredFrom: todayStr, deliveredTo: todayStr, limit: 100 },
    { refetchInterval: 30_000, refetchOnWindowFocus: true },
  );
  const parties = trpc.delivery.listParties.useQuery({ activeOnly: true }, { enabled: canDispatch });

  // كشف READY الجدد بين استعلامَين متتاليَين — يُشعِر الموظّف بجاهزيّة أمر شغل خرج من المطبعة
  // للتوّ (بلاغ ٢٨/٨/٢٦). يقارن Set<workOrderId> بالسابق: النقلة تفلترها ورشة الطلب لا الاستعلام
  // (طلبٌ نُقل من IN_PROGRESS إلى READY على الخادم ⇒ يظهر في القائمة نفسها بحالةٍ جديدة).
  // firstLoad: تحميلٌ أوّل (أو تحديثٌ بعد mutation) لا يُطلق toast — نسجّل الأسسَ فقط. سباق الطلبات
  // بين تبويبَين: كلٌّ يشتغل بـSet خاصّ (state محلّيّ لمكوّن)، فتنبيهُ الأخيرِ لا يُلغي الأوّل.
  const knownReadyRef = useRef<Set<number>>(new Set());
  const firstLoadRef = useRef<boolean>(true);
  useEffect(() => {
    const rows = active.data;
    if (!rows) return;
    const currentReady = new Set<number>();
    for (const r of rows) {
      if (r.status === "READY") currentReady.add(Number(r.id));
    }
    if (firstLoadRef.current) {
      knownReadyRef.current = currentReady;
      firstLoadRef.current = false;
      return;
    }
    const freshIds: number[] = [];
    Array.from(currentReady).forEach((id) => {
      if (!knownReadyRef.current.has(id)) freshIds.push(id);
    });
    knownReadyRef.current = currentReady;
    if (freshIds.length > 0) {
      const freshRows = rows.filter((r) => freshIds.includes(Number(r.id)));
      const first = freshRows[0]!;
      const suffix = freshRows.length > 1 ? ` (و${freshRows.length - 1} طلب/طلبات أخرى)` : "";
      notify.info(
        `طلب جاهز للتسليم: ${first.orderNumber}${suffix}`,
        first.customerName ? `العميل: ${first.customerName}` : undefined,
      );
      playReadyBeep();
    }
  }, [active.data]);

  const [dispatchTarget, setDispatchTarget] = useState<QueueRow | null>(null);
  const [pickupTarget, setPickupTarget] = useState<QueueRow | null>(null);
  // مفتاحُ تكرارِ التسليم المباشر (Tier-1 #4، ٢٥/٨) — يُولَّد مرّةً لكلّ (pickupTarget × محاولة)،
  // فنقرٌ مضاعفٌ قبل عودة الاستجابة الأولى يُرسل نفس المفتاح ⇒ الخادم يُعيد النتيجة الأولى بدل
  // إنشاء محاولةِ تسليمٍ ثانية. يُصفَّر في `onSuccess`/`onClose` لدورةٍ جديدة. `partialPickup`
  // يستعيره من `vars.clientRequestId` كي تبقى محاولةُ الاعتراف الجزئيّ ضمن نفس بصمة الأصل.
  const pickupKeyRef = useRef<string | null>(null);
  function ensurePickupKey(): string {
    if (!pickupKeyRef.current) {
      pickupKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `pickup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return pickupKeyRef.current;
  }
  const [partialPickup, setPartialPickup] = useState<PartialPickup | null>(null);
  const [reclassifyTarget, setReclassifyTarget] = useState<QueueRow | null>(null);
  // ردّ أمانة أجرة توصيلٍ عبر ورديةٍ غير وردية القبض ⇒ الخادم يرفض (FORBIDDEN «اعتماد مدير»):
  // نلتقط بيانات المحاولة ونطلب اعتماد مدير ثم نعيدها معه (نمط DraftPaymentsDialog حرفياً).
  const [reclassifyMgrAsk, setReclassifyMgrAsk] = useState<RouterInputs["workOrders"]["setDeliveryMethod"] | null>(null);

  const invalidateAll = () => {
    void utils.workOrders.list.invalidate();
    void utils.workOrders.counts.invalidate();
  };

  const dispatch = trpc.delivery.dispatch.useMutation({
    onSuccess: (r) => {
      notify.ok("أُرسل عبر المندوب", `إرسالية ${r.consignmentNumber} — COD ${fmt(r.codAmount)} د.ع`);
      setDispatchTarget(null);
      invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const deliver = trpc.workOrders.deliver.useMutation({
    onSuccess: (r) => {
      notify.ok("تم التسليم", `فاتورة ${r.invoiceNumber}`);
      pickupKeyRef.current = null; // rotate for next attempt
      setPickupTarget(null);
      setPartialPickup(null);
      invalidateAll();
    },
    onError: (e, vars) => {
      if (isPartialDispatchRejection(e) && pickupTarget) {
        // يعيد استخدام نفس المفتاح كي تبقى محاولةُ الاعتراف الجزئيّ داخل بصمة الأصل الواحدة.
        setPartialPickup({ row: pickupTarget, payment: vars.payment, message: e.message, clientRequestId: vars.clientRequestId ?? ensurePickupKey() });
        return;
      }
      notify.err(e);
    },
  });
  const setDeliveryMethod = trpc.workOrders.setDeliveryMethod.useMutation({
    onSuccess: (r) => {
      notify.ok("حُدِّثت طريقة التسليم", Number(r.refundedFee) > 0 ? `رُدّت أمانة الأجرة ${fmt(r.refundedFee)} د.ع نقداً للزبون` : undefined);
      setReclassifyTarget(null);
      setReclassifyMgrAsk(null);
      invalidateAll();
    },
    onError: (e, vars) => {
      // ردّ أمانةٍ نقديّة عبر ورديةٍ أخرى/بعد الإغلاق يلزمه مدير: نطلب اعتماده ونعيد المحاولة
      // بدل رسالة خطأ عابرة (نميّزه عن FORBIDDEN عزل الفرع بوسم الرسالة «اعتماد مدير»).
      const code = (e as { data?: { code?: string } }).data?.code;
      if (code === "FORBIDDEN" && /اعتماد مدير/.test(e.message)) {
        setReclassifyMgrAsk(vars);
        return;
      }
      notify.err(e);
    },
  });

  if (me.isLoading) return <LoadingState message="جارٍ التحقق من صلاحيات طابور الطلبات…" />;
  if (me.isError) {
    return <ErrorState message="تعذّر التحقق من صلاحيات طابور الطلبات." onRetry={() => { void me.refetch(); }} />;
  }
  if (active.isError) {
    return (
      <ErrorState
        message="تعذّر تحميل الطلبات النشطة. لا يمكن افتراض أن الطابور فارغ."
        onRetry={() => { void active.refetch(); }}
      />
    );
  }

  const rows = active.data ?? [];
  const readyRows = rows.filter((r) => r.status === "READY");
  const inProgressRows = rows.filter((r) => r.status !== "READY");
  const deliveredRows = deliveredToday.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <div className="mb-1 rounded-xl border bg-card p-3">
        <h1 className="font-extrabold">طابور الطلبات والتوصيل</h1>
        <p className="text-xs text-muted-foreground">من الاستلام حتى التسليم — استلام مباشر أو إسناد لمندوب/شركة توصيل.</p>
      </div>

      {canDispatch && parties.isLoading && (
        <LoadingState message="جارٍ تحميل جهات التوصيل…" className="rounded-xl border p-4" />
      )}
      {canDispatch && parties.isError && (
        <ErrorState
          message="تعذّر تحميل جهات التوصيل؛ أُوقف الإسناد للمندوب حتى نجاح التحميل."
          onRetry={() => { void parties.refetch(); }}
          className="rounded-xl border p-4"
        />
      )}

      {active.isLoading ? (
        <LoadingState message="جارٍ تحميل الطلبات النشطة…" className="p-8" />
      ) : (
        <>
          <QueueSection
            title="جاهزة للتسليم/الإرسال"
            icon={Truck}
            rows={readyRows}
            emptyLabel="لا طلبات جاهزة حالياً."
            canFulfill={canFulfill}
            canDispatch={canDispatch}
            partiesReady={parties.isSuccess}
            onDispatch={setDispatchTarget}
            onPickup={setPickupTarget}
            onReclassify={setReclassifyTarget}
          />
          <QueueSection
            title="قيد الاستلام/التنفيذ"
            icon={Package}
            rows={inProgressRows}
            emptyLabel="لا طلبات قيد التنفيذ حالياً."
            canFulfill={canFulfill}
            onReclassify={setReclassifyTarget}
          />
          {/* ش١ (٥/٨): طابور الفواتير صار **ورشةً مستقلّة** بتبويبها الخاص في المحطة (فلاتر
              وترقيم وتسديد وإعادة طباعة) — لم يعد مضمَّناً هنا؛ هذا التبويب للطلبات (أوامر الشغل). */}
          <QueueSection
            title="سُلِّمت اليوم"
            icon={Check}
            rows={deliveredRows}
            emptyLabel="لا طلبات مُسلَّمة اليوم بعد."
            canFulfill={false}
            loading={deliveredToday.isLoading}
            error={deliveredToday.isError}
            onRetry={() => { void deliveredToday.refetch(); }}
          />
        </>
      )}

      <DispatchDialog
        order={dispatchTarget}
        parties={(parties.data ?? []) as DispatchParty[]}
        pending={dispatch.isPending}
        onClose={() => setDispatchTarget(null)}
        onConfirm={async ({ partyId, fee, recipientName, recipientPhone, assignedUserId }) => {
          const ord = dispatchTarget!;
          const party = (parties.data ?? []).find((p) => p.id === partyId);
          // نافذة الملصق تُفتح متزامنةً مع نقرة التأكيد (قبل await الإرسال) — نمط DeliveryHub بالضبط.
          const labelWin = preopenShippingLabelWindow();
          try {
            const r = await dispatch.mutateAsync({
              workOrderId: ord.id,
              partyId,
              deliveryFee: fee,
              recipientName: recipientName || undefined,
              recipientPhone: recipientPhone || undefined,
              deliveryAddress: ord.deliveryAddress ?? undefined,
              clientRequestId: crypto.randomUUID(),
              assignedUserId,
            });
            void printReadyOrderLabel(ord, { partyName: party?.name ?? null, trackingNumber: r.consignmentNumber, cod: r.codAmount, into: labelWin });
            printDeliverySlip(ord, party, r);
          } catch {
            labelWin?.close();
          }
        }}
      />

      <MarkPickedUpDialog
        order={pickupTarget}
        pending={deliver.isPending}
        onClose={() => {
          pickupKeyRef.current = null; // إغلاق قبل المحاولة = دورةٌ جديدة عند فتحٍ لاحق
          setPickupTarget(null);
        }}
        onConfirm={(payment) => {
          const ord = pickupTarget!;
          deliver.mutate({ workOrderId: ord.id, payment, clientRequestId: ensurePickupKey(), partialDispatchConfirmed: false });
        }}
      />
      <PartialPickupConfirmDialog
        state={partialPickup}
        pending={deliver.isPending}
        onClose={() => { setPartialPickup(null); setPickupTarget(null); }}
        onConfirm={() => {
          if (!partialPickup) return;
          deliver.mutate({
            workOrderId: partialPickup.row.id,
            payment: partialPickup.payment,
            clientRequestId: partialPickup.clientRequestId,
            partialDispatchConfirmed: true,
          });
        }}
      />

      <ReclassifyDeliveryDialog
        order={reclassifyTarget}
        pending={setDeliveryMethod.isPending}
        onClose={() => setReclassifyTarget(null)}
        onConfirm={(payload) => {
          const ord = reclassifyTarget!;
          setDeliveryMethod.mutate({ workOrderId: ord.id, ...payload });
        }}
      />

      {reclassifyMgrAsk && (
        <ManagerApprovalDialog
          title="اعتماد مدير — ردّ أمانة أجرة التوصيل"
          description="ردّ أمانة الأجرة النقديّة عبر ورديةٍ أخرى أو بعد إغلاق وردية القبض يحتاج مديراً (تُفحص بياناته على الخادم وتُسجَّل باسمه)."
          onCancel={() => setReclassifyMgrAsk(null)}
          onApprove={(email, password) => {
            const vars = reclassifyMgrAsk;
            setReclassifyMgrAsk(null);
            setDeliveryMethod.mutate({ ...vars, managerApproval: { email, password } });
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── قسم القائمة ─────────────────────────
function QueueSection({ title, icon: Icon, rows, emptyLabel, canFulfill, canDispatch = false, partiesReady = true, loading = false, error = false, onRetry, onDispatch, onPickup, onReclassify }: {
  title: string;
  icon: LucideIcon;
  rows: QueueRow[];
  emptyLabel: string;
  canFulfill: boolean;
  canDispatch?: boolean;
  partiesReady?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  onDispatch?: (r: QueueRow) => void;
  onPickup?: (r: QueueRow) => void;
  onReclassify?: (r: QueueRow) => void;
}) {
  const groups = groupQueueRows(rows);
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-bold">{title}</h2>
        <Badge variant="secondary" className="ms-1">{loading || error ? "—" : rows.length}</Badge>
      </div>
      {loading ? (
        <LoadingState message={`جارٍ تحميل ${title}…`} className="p-6" />
      ) : error ? (
        <ErrorState message={`تعذّر تحميل ${title}. لا يمكن افتراض عدم وجود طلبات.`} onRetry={onRetry} className="p-6" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Icon} title="لا شيء هنا" description={emptyLabel} />
      ) : (
        <ul className="divide-y">
          {groups.map((group) => group.draftId == null ? (
            <QueueRowItem key={group.rows[0]!.id} row={group.rows[0]!} canFulfill={canFulfill} canDispatch={canDispatch} partiesReady={partiesReady} onDispatch={onDispatch} onPickup={onPickup} onReclassify={onReclassify} />
          ) : (
            <li key={`draft-${group.draftId}`}>
              <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-4 py-2 text-xs">
                <span className="font-bold">طلب {group.draftNumber ?? `#${group.draftId}`}</span>
                <span className={cn("rounded px-1.5 py-0.5 font-bold", group.readyCount === group.totalCount ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]")}>
                  {group.readyCount}/{group.totalCount} جاهزة
                </span>
                {group.readyCount < group.totalCount && <span className="text-muted-foreground">لا يُسلَّم الجزء الجاهز إلا بإقرار صريح</span>}
              </div>
              <ul className="divide-y">
                {group.rows.map((r: QueueRow) => <QueueRowItem key={r.id} row={r} canFulfill={canFulfill} canDispatch={canDispatch} partiesReady={partiesReady} onDispatch={onDispatch} onPickup={onPickup} onReclassify={onReclassify} />)}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function groupQueueRows(rows: QueueRow[]) {
  const groups = new Map<string, { draftId: number | null; draftNumber: string | null; totalCount: number; readyCount: number; rows: QueueRow[] }>();
  for (const row of rows) {
    const draftId = row.draftId == null ? null : Number(row.draftId);
    const key = draftId == null ? `single-${row.id}` : `draft-${draftId}`;
    const group = groups.get(key) ?? {
      draftId,
      draftNumber: row.draftNumber ?? null,
      totalCount: draftId == null ? 1 : Math.max(1, Number(row.draftTotalCount ?? 1)),
      readyCount: draftId == null ? (row.status === "READY" || row.status === "DELIVERED" ? 1 : 0) : Number(row.draftReadyCount ?? 0),
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function QueueRowItem({ row: r, canFulfill, canDispatch, partiesReady, onDispatch, onPickup, onReclassify }: {
  row: QueueRow;
  canFulfill: boolean;
  canDispatch: boolean;
  partiesReady: boolean;
  onDispatch?: (r: QueueRow) => void;
  onPickup?: (r: QueueRow) => void;
  onReclassify?: (r: QueueRow) => void;
}) {
  const isReady = r.status === "READY";
  const isFinal = r.status === "DELIVERED" || r.status === "CANCELLED";
  // Slice 5 (٢٨/٨/٢٦): عمرُ الحالة الحاليّة — يظهر شارةً بجانب الحالة. Polling كل ١٥ث في هذا
  // الطابور يُحدِّث القيمة تلقائياً بلا حاجة لـsetInterval محلّيّ. الحقول تأتي من workOrders.list
  // (workStartedAt/workSeconds مُضافان في Slice 5). الحسابُ على العميل (لا استعلام إضافيّ).
  const ageMin = computeStateAgeMinutes(r as never);
  const ageLevel = slaLevel(r.status, ageMin);
  const deliveryState = deriveWoDeliveryState(r.consignmentStatus, r.parcelStatus);
  const hasLiveConsignment = deliveryState !== "NONE";
  const actions: RowAction[] = [];
  // زرّ الإسناد كان يظهر لأيّ READY+توصيل **بلا فحص إرسالية قائمة** ⇒ النقر على طلبٍ مُسنَد
  // أصلاً يصطدم بقيدٍ فريد برسالةٍ غامضة. الآن تحلّ محلّه شارةُ حالته (أدناه).
  if (isReady && r.hasDelivery && !hasLiveConsignment && onDispatch) {
    actions.push({
      key: "dispatch",
      kind: "approve",
      label: "إسناد لمندوب",
      icon: Truck,
      hidden: !canDispatch,
      disabled: !partiesReady,
      disabledReason: "جهات التوصيل لم تُحمّل بعد — أعد المحاولة أولاً",
      onSelect: () => onDispatch(r),
      gate: DISPATCH_GATE,
    });
  }
  if (isReady && !r.hasDelivery && onPickup) {
    actions.push({ key: "pickup", kind: "approve", label: "تسليم مباشر", icon: Store, hidden: !canFulfill, onSelect: () => onPickup(r), gate: FULFILL_GATE });
  }
  if (!isFinal && onReclassify) {
    actions.push({ key: "reclassify", kind: "edit", label: "تغيير الطريقة", hidden: !canFulfill, onSelect: () => onReclassify(r), gate: FULFILL_GATE });
  }
  actions.push({ key: "open", kind: "view", label: "فتح", onSelect: () => window.open(`/work-orders/${r.id}`, "_blank", "noopener") });

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", workOrderStatusBadgeCls(r.status))}>{workOrderStatusLabel(r.status)}</span>
          {ageLevel !== "UNKNOWN" && ageMin != null && (
            <span
              className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold", slaLevelChipClass(ageLevel))}
              title={ageLevel === "BREACHED" ? "تجاوز عتبة الـSLA — يحتاج تحرّكاً فورياً" : ageLevel === "WARNING" ? "اقترب من عتبة الـSLA" : "ضمن الوقت المتوقّع"}
            >
              <Clock aria-hidden className="size-3" />
              {formatAgeShort(ageMin)}
            </span>
          )}
          {r.hasDelivery ? (
            <span className="inline-flex items-center gap-1 rounded bg-[var(--sem-info-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-info)]">
              <Truck aria-hidden className="size-3" /> توصيل
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
              <Store aria-hidden className="size-3" /> استلام مباشر
            </span>
          )}
          {/* حالة الطرد صراحةً بدل «قيد التوصيل» العامّة: «مُسنَد لم يخرج» ≠ «بالطريق» ≠ «تعذّر». */}
          {hasLiveConsignment ? (
            <a
              href="/delivery?tab=transit"
              className={cn("rounded border px-1.5 py-0.5 text-[11px] font-extrabold", WO_DELIVERY_STATE_CLS[deliveryState])}
              title="افتح تبويب «قيد التوصيل» لمتابعة الطرد"
            >
              {woDeliveryStateLabel(deliveryState)}{r.deliveryPartyName ? ` · ${r.deliveryPartyName}` : ""}
            </a>
          ) : r.consignmentNumber ? (
            <span className="text-[11px] text-muted-foreground">
              {r.deliveryPartyName ? `${r.deliveryPartyName} — ` : ""}
              {r.consignmentStatus === "DELIVERED" ? "سُلِّمت" : r.consignmentStatus === "RETURNED" ? "أُرجعت" : "أُلغي الإسناد"}
            </span>
          ) : null}
          <span className="font-bold">{r.orderNumber}</span>
        </div>
        <p className="mt-0.5 truncate text-sm">{r.title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {r.customerName ?? "عميل نقدي"}
          {r.customerPhone ? ` · ${r.customerPhone}` : ""}
          {r.hasDelivery && r.deliveryAddress ? ` · ${r.deliveryAddress}` : ""}
        </p>
      </div>
      {/* إصلاح (٧/٨، طلب مالك): العربون المقبوض عند إنشاء الطلب كان يُجلَب في الاستعلام
          (workOrders.deposit) ولا يُعرَض — الموظّف يفتح تفاصيل الطلب ليعرف كم دُفع/تبقّى.
          الحقل ثابتٌ منذ الإنشاء (لا مسارَ تعديلٍ لاحقٍ عليه في الكود — التحقّق قبل العرض)،
          فعرضه هنا مباشرةً آمنٌ ودقيق. */}
      <div className="text-left shrink-0 text-xs" dir="ltr">
        <div className="text-sm font-bold tabular-nums">{fmt(r.salePrice)} د.ع</div>
        {D(r.deposit ?? "0").gt(0) && (
          <div className="mt-0.5 space-y-0.5 text-[10px] font-semibold">
            <div className="text-money-positive">عربون: {fmt(r.deposit ?? "0")}</div>
            <div className="text-[var(--sem-warn)]">
              متبقّي: {fmt(round2(D(r.salePrice).minus(D(r.deposit ?? "0"))).toFixed(2))}
            </div>
          </div>
        )}
      </div>
      <RowActions actions={actions} />
    </li>
  );
}

function PartialPickupConfirmDialog({ state, pending, onClose, onConfirm }: { state: PartialPickup | null; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  if (!state) return null;
  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/70 p-4" dir="rtl" role="dialog" aria-modal="true" aria-label="إقرار التسليم الجزئي">
      <div className="w-full max-w-lg rounded-2xl bg-card p-6 shadow-2xl">
        <h3 className="mb-2 text-lg font-extrabold">تأكيد تسليم جزء من الطلب</h3>
        <p className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">{state.message}</p>
        <p className="mt-3 text-xs text-muted-foreground">سيُسجّل هذا الإقرار باسم المستخدم الحالي، ويبقى باقي الطلب في الطابور حتى يجهز.</p>
        <div className="mt-5 flex gap-2">
          <Button variant="outline" className="flex-1" disabled={pending} onClick={onClose}>تراجع</Button>
          <Button variant="destructive" className="flex-1" disabled={pending} onClick={onConfirm}>{pending ? "جارٍ…" : "أقرّ التسليم الجزئي"}</Button>
        </div>
      </div>
    </div>
  );
}

// حوار إعادة التصنيف استُخرِج إلى @/components/workorder/ReclassifyDeliveryDialog (Slice C، ٢٩/٨/٢٦)
// — يُستعمَل هنا وفي WorkOrderDetail معاً.
