import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { ImageStudioUploader } from "@/components/product/ImageStudioUploader";
import { Button } from "@/components/ui/button";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { reconcileStudioDraftAfterReconnect, saveStudioDraft, purgeStudioDraft, type StudioDraftTaskSnapshot } from "@/lib/productStudio/studioDrafts";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type ReactNode } from "react";

type Reservation = RouterOutputs["productStudio"]["reserveImages"];
type Slot = Reservation["tasks"][number] & {
  image?: ImageItem;
  original: string;
  mode: "FLATTEN" | "CUT" | "AI";
  receipt: string | null;
  sent?: boolean;
  conflict?: boolean;
  ownershipLost?: boolean;
  lockedUntil?: number;
  proposedName?: string;
  proposedDescription?: string;
  proposedMarketingCopy?: string;
};
export interface StudioCampaignImageBatchHandle {
  submitAdditional(): Promise<void>;
}
interface Props {
  children?: ReactNode;
  ref?: Ref<StudioCampaignImageBatchHandle>;
  taskId: number;
  userId: number | null;
  productName: string;
  primaryImages: ImageItem[];
  onPrimaryImage: (image: ImageItem) => void;
  adminOverrideReason?: string;
  offline: boolean;
  submitting?: boolean;
  onBusyChange: (busy: boolean) => void;
}

/** Each photograph retains its own immutable source, provider proof and review job. */
export function StudioCampaignImageBatch(props: Props) {
  const reserve = trpc.productStudio.reserveImages.useMutation();
  const submit = trpc.productStudio.submitCandidate.useMutation();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [maxImages, setMaxImages] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [processing, setProcessing] = useState<Record<number, boolean>>({});
  const busy = working || Object.values(processing).some(Boolean);
  const locked = useRef(false);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const busyCallbacks = useRef(new Map<number, (busy: boolean) => void>());
  function onSlotBusy(taskId: number) {
    if (!busyCallbacks.current.has(taskId)) busyCallbacks.current.set(taskId, (value) => {
      setProcessing((current) => current[taskId] === value ? current : { ...current, [taskId]: value });
    });
    return busyCallbacks.current.get(taskId)!;
  }

  useEffect(() => {
    props.onBusyChange(busy);
    return () => props.onBusyChange(false);
  }, [busy, props.onBusyChange]);

  async function hydrate(result: Reservation): Promise<Slot[]> {
    return Promise.all(result.tasks.filter((row) => row.taskId !== props.taskId).map(async (row) => {
      const current = slotsRef.current.find((slot) => slot.taskId === row.taskId);
      if (current && (!current.lockedUntil || current.lockedUntil > Date.now())) {
        return { ...current, ...row };
      }
      const reconciliation = props.userId == null
        ? { kind: "NONE" as const }
        : await reconcileStudioDraftAfterReconnect({
            userId: props.userId,
            taskId: row.taskId,
            taskFound: true,
            revision: String(row.revision),
            editable: row.status === "ASSIGNED" || row.status === "IN_PROGRESS" || row.status === "REJECTED",
          });
      const draft = "draft" in reconciliation ? reconciliation.draft : null;
      return {
        ...row,
        original: draft?.originalDataUrl ?? "",
        image: draft?.imageDataUrl ? { id: `studio-batch-${row.taskId}`, dataUrl: draft.imageDataUrl, isPrimary: false } : undefined,
        mode: draft?.mode ?? "FLATTEN",
        receipt: draft?.processingReceipt ?? null,
        conflict: reconciliation.kind === "CONFLICT",
        ownershipLost: false,
        lockedUntil: reconciliation.kind === "ALREADY_RESUMED" ? reconciliation.retryAt : undefined,
        proposedName: draft?.proposedName,
        proposedDescription: draft?.proposedDescription,
        proposedMarketingCopy: draft?.proposedMarketingCopy,
      };
    }));
  }

  async function initialize() {
    if (props.offline || locked.current) return;
    locked.current = true;
    setWorking(true);
    try {
      const result = await reserve.mutateAsync({ taskId: props.taskId, count: 1, adminOverrideReason: props.adminOverrideReason });
      setSlots(await hydrate(result));
      setMaxImages(result.maxImages);
      setReady(true);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر قراءة سماح صور الحملة");
    } finally {
      locked.current = false;
      setWorking(false);
    }
  }
  useEffect(() => {
    void initialize();
  }, [props.taskId, props.offline]);

  useEffect(() => {
    const retryAt = slots.reduce(
      (earliest, slot) => slot.lockedUntil && slot.lockedUntil > Date.now()
        ? Math.min(earliest, slot.lockedUntil)
        : earliest,
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(retryAt) || props.offline) return;
    const timer = window.setTimeout(() => void initialize(), Math.max(0, retryAt - Date.now()) + 25);
    return () => window.clearTimeout(timer);
  }, [slots, props.offline]);

  function patch(taskId: number, change: Partial<Slot>) {
    setSlots((current) => current.map((slot) => slot.taskId === taskId ? { ...slot, ...change } : slot));
  }

  async function persistSlotDraft(userId: number, slot: Slot): Promise<void> {
    if (!slot.image) return;
    await saveStudioDraft({
      userId, taskId: slot.taskId, revision: String(slot.revision),
      proposedName: slot.proposedName ?? "", proposedDescription: slot.proposedDescription ?? "", proposedMarketingCopy: slot.proposedMarketingCopy ?? "",
      imageDataUrl: slot.image.dataUrl, originalDataUrl: slot.original || null,
      processingReceipt: slot.receipt, mode: slot.mode,
      taskSnapshot: { taskId: slot.taskId, productName: props.productName, currentDescription: null,
        status: slot.status as "ASSIGNED" | "IN_PROGRESS" | "REJECTED",
        hasOriginal: slot.hasOriginal, hasCandidate: slot.hasCandidate, updatedAt: String(slot.updatedAt) },
    });
  }

  useEffect(() => {
    if (!ready || props.userId == null) return;
    const userId = props.userId;
    const timer = window.setTimeout(() => {
      for (const slot of slots.filter((candidate) =>
        !candidate.sent && !candidate.conflict && !candidate.ownershipLost &&
        (!candidate.lockedUntil || candidate.lockedUntil <= Date.now()) && candidate.image,
      )) {
        void persistSlotDraft(userId, slot).catch((cause) => {
          if (cause instanceof Error && cause.message.includes("تبويب آخر")) {
            patch(slot.taskId, { ownershipLost: true });
            return;
          }
          setError("تعذّر حفظ الصورة الإضافية على الجهاز؛ أبقِ الصفحة مفتوحة حتى الإرسال");
        });
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [slots, ready, props.userId, props.productName]);

  async function addImages(images: ImageItem[]) {
    if (!images.length || locked.current || busy || props.offline) return;
    locked.current = true;
    setWorking(true);
    setError("");
    try {
      const occupied = (props.primaryImages.length ? 1 : 0) + slots.filter((slot) => slot.image || slot.sent || slot.hasOriginal).length;
      const result = await reserve.mutateAsync({
        taskId: props.taskId, count: Math.max(1, occupied + images.length),
        adminOverrideReason: props.adminOverrideReason,
      });
      const available = await hydrate(result);
      const incoming = [...images];
      if (!props.primaryImages.length) props.onPrimaryImage(incoming.shift()!);
      for (const item of incoming) {
        const index = available.findIndex((slot) => !slot.image && !slot.sent && !slot.hasOriginal && !slot.conflict);
        if (index < 0) throw new Error("لا توجد فتحة صورة متاحة؛ افتح المهمة الموجودة من مهامّي");
        available[index] = { ...available[index], image: item, original: item.dataUrl, receipt: null, mode: "FLATTEN" };
      }
      setSlots(available);
      setMaxImages(result.maxImages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إضافة صور الحملة");
    } finally {
      locked.current = false;
      setWorking(false);
    }
  }

  useImperativeHandle(props.ref, () => ({
    async submitAdditional() {
      if (locked.current || busy) throw new Error("انتظر انتهاء معالجة الصور");
      const pending = slotsRef.current.filter((slot) => !slot.sent && slot.image);
      if (pending.some((slot) => slot.conflict || slot.ownershipLost || (slot.lockedUntil != null && slot.lockedUntil > Date.now()))) {
        throw new Error("إحدى الصور الإضافية مفتوحة في تبويب آخر أو تغيّرت مهمتها؛ افتحها من مهامّي قبل الإرسال");
      }
      locked.current = true;
      setWorking(true);
      try {
        // Separate requests stay below the HTTP payload cap and permit partial retry.
        for (const slot of pending) {
          if (props.userId != null) {
            try {
              // حفظٌ ذري قبل الشبكة يجدد ملكية هذه الصورة؛ إن استحوذ تبويب آخر عليها
              // نوقف الإرسال ولا نعتمد على علم conflict قديم من لحظة فتح الشاشة.
              await persistSlotDraft(props.userId, slot);
            } catch (cause) {
              if (cause instanceof Error && cause.message.includes("تبويب آخر")) {
                patch(slot.taskId, { ownershipLost: true });
                throw new Error("هذه الصورة الإضافية مفتوحة في تبويب آخر؛ أغلِقه ثم أعد المحاولة");
              }
              throw cause;
            }
          }
          await submit.mutateAsync({
            taskId: slot.taskId, expectedRevision: slot.revision,
            originalDataUrl: slot.original || null, processedDataUrl: slot.image!.dataUrl,
            thumbnailDataUrl: await createProductDisplayThumbnail(slot.image!.dataUrl),
            // AI لا يُقبل كتسميةٍ من العميل: الإيصال المرتبط بهذه المهمة/البايتات
            // هو الذي يرفع الوضع خادمياً إلى AI. يبقى wire mode آمناً ولا يخلط إثباتات الصور.
            mode: slot.mode === "AI" ? "FLATTEN" : slot.mode, processingReceipt: slot.receipt,
            adminOverrideReason: props.adminOverrideReason,
            proposedName: slot.proposedName, proposedDescription: slot.proposedDescription,
            proposedMarketingCopy: slot.proposedMarketingCopy,
          });
          patch(slot.taskId, { sent: true });
          if (props.userId != null) await purgeStudioDraft(props.userId, slot.taskId).catch(() => undefined);
        }
      } finally {
        locked.current = false;
        setWorking(false);
      }
    },
  }));

  const occupied = (props.primaryImages.length ? 1 : 0) + slots.filter((slot) => slot.image || slot.sent || slot.hasOriginal).length;
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <p className="font-medium">التقاط وإرفاق صور الحملة</p>
      <p className="text-sm text-muted-foreground">تُرسل الصور معاً، وتُراجع كل صورة مستقلة. العدد المتاح لهذه الدفعة: {maxImages}.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!ready && !props.offline && <Button type="button" variant="outline" disabled={busy} onClick={() => void initialize()}>تحديث سماح الصور</Button>}
      {ready && occupied < maxImages && (
        <fieldset disabled={busy || props.submitting || props.offline}>
          <ImageUploader value={[]} onChange={(images) => void addImages(images)} maxItems={maxImages - occupied}
            hint="اختر عدة صور من المعرض، أو التقط صورة ثم كرّر زر الكاميرا لإضافة الزوايا الأخرى." />
        </fieldset>
      )}
      <fieldset disabled={busy || props.submitting}>{props.children}</fieldset>
      {slots.map((slot, index) => (
        <fieldset key={slot.taskId} disabled={busy || props.submitting || slot.sent || slot.conflict || slot.ownershipLost || (slot.lockedUntil != null && slot.lockedUntil > Date.now()) || (slot.hasOriginal && !slot.image) || slot.hasCandidate} className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">صورة الحملة {slot.activeSlot ?? index + 2}{slot.sent ? " — أُرسلت للمراجعة" : ""}</p>
          {slot.conflict && <p role="alert" className="text-sm text-destructive">تغيّرت المهمة؛ احتُفظ بالصورة محلياً. افتح المهمة من مهامّي لمراجعتها.</p>}
          {slot.ownershipLost && <p role="alert" className="text-sm text-destructive">فُتحت هذه الصورة في تبويب آخر؛ أغلِقه وافتح المهمة من مهامّي قبل الإرسال.</p>}
          {slot.lockedUntil != null && slot.lockedUntil > Date.now() && <p role="status" className="text-sm text-muted-foreground">هذه الصورة مفتوحة مؤقتاً في تبويب آخر؛ سيُعاد التحقق تلقائياً.</p>}
          {slot.hasOriginal && !slot.image && <p className="text-sm text-muted-foreground">لهذه الصورة أصل محفوظ؛ افتح مهمتها من مهامّي لاستكمالها.</p>}
          {slot.hasCandidate && <p className="text-sm text-muted-foreground">أُرسلت لهذه الصورة نتيجة سابقة؛ افتح مهمتها من مهامّي لمتابعة مراجعتها.</p>}
          <ImageStudioUploader value={slot.image ? [slot.image] : []} maxItems={1} singlePrimary={false}
            studioTaskId={slot.taskId} adminOverrideReason={props.adminOverrideReason} offline={props.offline}
            onChange={(images) => patch(slot.taskId, { image: images[0], original: images[0]?.id === slot.image?.id ? slot.original : images[0]?.dataUrl ?? "", receipt: null })}
            onStudioModeChange={(mode) => patch(slot.taskId, { mode })}
            onProcessingReceiptChange={(receipt) => patch(slot.taskId, { receipt })}
            onBusyChange={onSlotBusy(slot.taskId)} />
        </fieldset>
      ))}
    </div>
  );
}

export function taskSnapshot(task: RouterOutputs["productStudio"]["tasks"]["items"][number]): StudioDraftTaskSnapshot {
  return {
    taskId: Number(task.id),
    productName: task.productName,
    currentDescription: task.currentDescription ?? null,
    status: task.status as StudioDraftTaskSnapshot["status"],
    hasOriginal: task.hasOriginal,
    hasCandidate: task.hasCandidate,
    updatedAt: String(task.revision),
  };
}
