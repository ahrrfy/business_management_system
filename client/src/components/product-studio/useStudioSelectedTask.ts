import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";

type Task = RouterOutputs["productStudio"]["tasks"]["items"][number];

/** Resolve scanned tasks independently of list pagination and display filters. */
export function useStudioSelectedTask(
  scope: RouterInputs["productStudio"]["tasks"]["scope"],
  selectedId: number | null,
  offline: boolean,
  taskItems: Task[],
  scannedTask: Task | null,
) {
  const selectedTaskQuery = trpc.productStudio.tasks.useQuery(
    { scope, taskId: selectedId ?? 0, limit: 1, hideClosedCampaigns: false },
    { enabled: !offline && Boolean(selectedId) },
  );
  const onlineSelected =
    selectedTaskQuery.data?.items.find((task) => Number(task.id) === selectedId) ??
    taskItems.find((task) => Number(task.id) === selectedId) ??
    (scannedTask && Number(scannedTask.id) === selectedId ? scannedTask : null);
  return { selectedTaskQuery, onlineSelected };
}
