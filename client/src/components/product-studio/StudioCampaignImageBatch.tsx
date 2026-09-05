import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { ImageStudioUploader } from "@/components/product/ImageStudioUploader";
import { Button } from "@/components/ui/button";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { loadStudioDraft, saveStudioDraft, purgeStudioDraft, type StudioDraftTaskSnapshot } from "@/lib/productStudio/studioDrafts";
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
      if (current) return current;
      const draft = props.userId == null ? null : await loadStudioDraft(props.userId, row.taskId);
      return {
        ...row,
        original: draft?.originalDataUrl ?? "",
        image: draft?.imageDataUrl ? { id: `studio-batch-${row.taskId}`, dataUrl: draft.imageDataUrl, isPrimary: false } : undefined,
        mode: draft?.mode ?? "FLATTEN",
        receipt: draft?.processingReceipt ?? null,
        conflict: Boolean(draft && draft.revision !== String(row.revision)),
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

  function patch(taskId: number, change: Partial<Slot>) {
    setSlots((current) => current.map((slot) => slot.taskId === taskId ? { ...slot, ...change } : slot));
  }

  useEffect(() => {
    if (!ready || props.userId == null) return;
    const userId = props.userId;
    const timer = window.setTimeout(() => {
      void Promise.all(slots.filter((slot) => !slot.sent && !slot.conflict).map((slot) => slot.image ? saveStudioDraft({
        userId, taskId: slot.taskId, revision: String(slot.revision),
        proposedName: slot.proposedName ?? "", proposedDescription: slot.proposedDescription ?? "", proposedMarketingCopy: slot.proposedMarketingCopy ?? "",
        imageDataUrl: slot.image!.dataUrl, originalDataUrl: slot.original || null,
        processingReceipt: slot.receipt, mode: slot.mode,
        taskSnapshot: { taskId: slot.taskId, productName: props.productName, currentDescription: null,
          status: slot.status as "ASSIGNED" | "IN_PROGRESS" | "REJECTED",
          hasOriginal: slot.hasOriginal, hasCandidate: slot.hasCandidate, updatedAt: String(slot.updatedAt) },
      }) : purgeStudioDraft(userId, slot.taskId))).catch(() => setError("تعذّر حفظ الصور الإضافية على الجهاز؛ أبقِ الصفحة مفتوحة حتى الإرسال"));
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
      if (pending.some((slot) => slot.conflict)) throw new Error("تغيّرت مهمة صورة إضافية؛ افتحها من مهامّي قبل الإرسال");
      locked.current = true;
      setWorking(true);
      try {
        // Separate requests stay below the HTTP payload cap and permit partial retry.
        for (const slot of pending) {
          await submit.mutateAsync({
            taskId: slot.taskId, expectedRevision: slot.revision,
            originalDataUrl: slot.original || null, processedDataUrl: slot.image!.dataUrl,
            thumbnailDataUrl: await createProductDisplayThumbnail(slot.image!.dataUrl),
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
        <fieldset key={slot.taskId} disabled={busy || props.submitting || slot.sent || slot.conflict} className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">صورة إضافية {index + 1}{slot.sent ? " — أُرسلت للمراجعة" : ""}</p>
          {slot.conflict && <p role="alert" className="text-sm text-destructive">تغيّرت المهمة؛ احتُفظ بالصورة محلياً. افتح المهمة من مهامّي لمراجعتها.</p>}
          {slot.hasOriginal && !slot.image && <p className="text-sm text-muted-foreground">لهذه الصورة أصل محفوظ؛ افتح مهمتها من مهامّي لاستكمالها.</p>}
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
