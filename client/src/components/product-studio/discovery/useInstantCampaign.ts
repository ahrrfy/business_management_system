import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { notify } from "@/lib/notify";
import {
  instantCampaignFilter,
  prepareInstantCampaign,
  type CampaignDraft,
  type InstantCampaignProps,
  type InstantCampaignScope,
} from "./instantCampaign";

export function useInstantCampaign(props: InstantCampaignProps) {
  const canReadAssignees = useOperationPermission(
    "productStudio.assignees",
  ).allowed;
  const canReadGapIds = useOperationPermission(
    "productStudio.gapProductIds",
  ).allowed;
  const canCreate = useOperationPermission(
    "productStudio.createCampaign",
  ).allowed;
  const canDrain = useOperationPermission(
    "productStudio.drainCampaignBacklog",
  ).allowed;
  const canDistribute = useOperationPermission(
    "productStudio.distributeCampaignTasks",
  ).allowed;
  const utils = trpc.useUtils();
  const [scope, setScope] = useState<InstantCampaignScope>(
    props.defaultScope ?? "HIGH_VALUE",
  );
  const [name, setName] = useState("");
  const [requiredImages, setRequiredImages] = useState("1");
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [complete, setComplete] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const wasOpen = useRef(false);
  const initializedAssignees = useRef(false);
  const pending = useRef<{ id: number; draft: CampaignDraft } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (props.open && !wasOpen.current && (!pending.current || complete)) {
      setScope(props.defaultScope ?? "HIGH_VALUE");
      setName(
        `حملة تصوير المنتجات - ${new Intl.DateTimeFormat("en-CA").format(new Date())}`,
      );
      setRequiredImages("1");
      setAssigneeIds([]);
      initializedAssignees.current = false;
      pending.current = null;
      setCampaignId(null);
      setComplete(false);
      setMessage("");
      setError("");
    }
    wasOpen.current = props.open;
  }, [props.open, props.defaultScope, complete]);

  const assignees = trpc.productStudio.assignees.useQuery(undefined, {
    enabled: props.open && canReadAssignees,
  });
  const photographers = canReadAssignees
    ? (assignees.data?.filter((user) => user.canStudio) ?? [])
    : [];
  useEffect(() => {
    if (
      props.open &&
      canReadAssignees &&
      assignees.data &&
      !initializedAssignees.current &&
      !pending.current
    ) {
      initializedAssignees.current = true;
      setAssigneeIds(
        assignees.data.filter((user) => user.canStudio).map((user) => user.id),
      );
    }
  }, [props.open, canReadAssignees, assignees.data]);

  const preview = trpc.productStudio.gapProductIds.useQuery(
    instantCampaignFilter(scope, props),
    {
      enabled:
        props.open &&
        scope !== "SELECTED_ROWS" &&
        canReadGapIds &&
        campaignId === null,
      retry: false,
    },
  );
  const ids =
    scope === "SELECTED_ROWS"
      ? Array.from(new Set(props.selectedRowIds ?? []))
      : canReadGapIds && !preview.isError
        ? (preview.data ?? [])
        : [];
  const targetCount =
    pending.current?.draft.scopeProductIds?.length ?? ids.length;
  const previewReady =
    scope === "SELECTED_ROWS" ||
    (canReadGapIds &&
      !preview.isFetching &&
      !preview.isError &&
      preview.data !== undefined);
  const validDraft =
    previewReady &&
    ids.length > 0 &&
    ids.length <= 5000 &&
    name.trim().length >= 3 &&
    assigneeIds.length > 0 &&
    assigneeIds.length <= 50 &&
    Number.isInteger(Number(requiredImages)) &&
    Number(requiredImages) >= 1 &&
    Number(requiredImages) <= 10;
  const canLaunch =
    props.open &&
    canCreate &&
    canDrain &&
    canDistribute &&
    canReadAssignees &&
    !busy &&
    !complete &&
    (campaignId !== null || validDraft);
  const create = trpc.productStudio.createCampaign.useMutation();
  const drain = trpc.productStudio.drainCampaignBacklog.useMutation();
  const distribute = trpc.productStudio.distributeCampaignTasks.useMutation();

  const launch = async () => {
    if (submitting.current || !canLaunch) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const draft = pending.current?.draft ?? {
      name: name.trim(),
      status: "ACTIVE" as const,
      scopeKind: "PRODUCTS" as const,
      scopeProductIds: [...ids],
      requiredImages: Number(requiredImages),
      assigneeIds: [...assigneeIds],
    };
    try {
      setMessage(
        pending.current
          ? "جارٍ استكمال الحملة نفسها…"
          : `جارٍ إنشاء حملة لـ ${ids.length} منتج…`,
      );
      const result = await prepareInstantCampaign({
        campaignId: pending.current?.id ?? null,
        draft,
        create: create.mutateAsync,
        drain: drain.mutateAsync,
        distribute: distribute.mutateAsync,
        onCreated: (id) => {
          pending.current = { id, draft };
          if (mounted.current) {
            setCampaignId(id);
            setMessage("جارٍ تجهيز المهام وإسنادها…");
          }
          void utils.productStudio.campaigns.invalidate();
        },
      });
      void Promise.all([
        utils.productStudio.campaigns.invalidate(),
        utils.productStudio.tasks.invalidate(),
        utils.productStudio.imageHealthCounts.invalidate(),
        utils.productStudio.discoverImageGaps.invalidate(),
        utils.productStudio.dashboard.invalidate(),
      ]);
      if (!mounted.current) return;
      setMessage(
        `أُنشئت ${result.totalCreated} مهمة وأُسندت ${result.distributedCount} مهمة في هذه المحاولة. المتبقي للتوليد: ${result.remaining}.`,
      );
      if (result.remaining === 0) {
        setComplete(true);
        notify.ok("اكتمل تجهيز الحملة وإسناد مهامها.");
        props.onSuccess?.(result.campaignId);
      }
    } catch (reason) {
      if (mounted.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : "تعذر تجهيز الحملة. أعد المحاولة.",
        );
        setMessage(
          pending.current
            ? `الحملة رقم ${pending.current.id} محفوظة؛ المحاولة التالية تستكملها.`
            : "",
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    scope,
    setScope,
    name,
    setName,
    requiredImages,
    setRequiredImages,
    assigneeIds,
    setAssigneeIds,
    photographers,
    assignees,
    preview,
    previewReady,
    targetCount,
    busy,
    campaignId,
    complete,
    message,
    error,
    canLaunch,
    launch,
    locked: busy || campaignId !== null,
    onOpenChange: (open: boolean) => {
      if (!submitting.current) props.onOpenChange(open);
    },
  };
}
