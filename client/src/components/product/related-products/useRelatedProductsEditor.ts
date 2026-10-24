import { useEffect, useMemo, useRef, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import type { ProductRelationType } from "@shared/terms";

type Relation = RouterOutputs["bundles"]["getRelatedProducts"]["items"][number];
export type RelationDraft = Pick<
  Relation,
  "relatedProductId" | "productName" | "sortOrder"
> & { relationType: ProductRelationType };
export const validRelationOrder = (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= 999;

export function useRelatedProductsEditor(productId: number) {
  const { can } = useCatalogPeopleOperationAccess();
  const canRead = can("bundles.getRelatedProducts");
  const canWrite = can("bundles.setRelatedProducts");
  const canSearch = can("bundles.searchComponents");
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<RelationDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    if (!canRead) {
      revision.current++;
      setDraft(null);
      setQuery("");
    }
  }, [canRead]);

  const relationsQ = trpc.bundles.getRelatedProducts.useQuery(
    { sourceProductId: productId },
    { enabled: canRead },
  );
  const searchQ = trpc.bundles.searchComponents.useQuery(
    { q: query.trim(), limit: 20 },
    {
      enabled: canRead && canSearch && query.trim().length > 0,
      staleTime: 30_000,
    },
  );
  const mutation = trpc.bundles.setRelatedProducts.useMutation();
  const loaded = canRead && relationsQ.isSuccess && !relationsQ.isError;
  const editable = loaded && canWrite && !saving;
  const relations: RelationDraft[] = canRead
    ? (draft ?? (loaded ? (relationsQ.data?.items ?? []) : []))
    : [];
  const currentIds = useMemo(
    () => new Set(relations.map((row) => row.relatedProductId)),
    [relations],
  );
  const results =
    canRead && canSearch && query.trim() && !searchQ.isError
      ? Array.from(
          new Map(
            (searchQ.data?.items ?? [])
              .filter(
                (row) =>
                  row.productId !== productId && !currentIds.has(row.productId),
              )
              .map((row) => [row.productId, row]),
          ).values(),
        )
      : [];
  const update = (change: (rows: RelationDraft[]) => RelationDraft[]) => {
    if (!editable || busy.current) return;
    revision.current++;
    setDraft((previous) => change(previous ?? relations));
  };
  const add = (product: { productId: number; productName: string }) => {
    if (!canSearch || relations.length >= 30 || product.productId === productId)
      return;
    update((rows) =>
      rows.some((row) => row.relatedProductId === product.productId)
        ? rows
        : [
            ...rows,
            {
              relatedProductId: product.productId,
              productName: product.productName,
              relationType: "COMPLETE_KIT",
              sortOrder: rows.length,
            },
          ],
    );
    setQuery("");
  };
  const save = async () => {
    if (
      !editable ||
      busy.current ||
      relations.length > 30 ||
      !relations.every((row) => validRelationOrder(row.sortOrder))
    )
      return;
    busy.current = true;
    setSaving(true);
    const submittedRevision = revision.current;
    try {
      const result = await mutation.mutateAsync({
        sourceProductId: productId,
        items: relations.map(
          ({ relatedProductId, relationType, sortOrder }) => ({
            relatedProductId,
            relationType,
            sortOrder,
          }),
        ),
      });
      if (!mounted.current || revision.current !== submittedRevision) {
        void utils.bundles.getRelatedProducts.invalidate({
          sourceProductId: productId,
        });
        return;
      }
      notify.ok(`تم حفظ ${result.count} علاقة ترويجية.`);
      // A failed refresh keeps the submitted draft; a later edit is never overwritten.
      void relationsQ
        .refetch()
        .then((fresh) => {
          if (
            mounted.current &&
            revision.current === submittedRevision &&
            fresh.data &&
            !fresh.isError
          )
            setDraft(null);
        })
        .catch(() => {});
    } catch (error) {
      if (mounted.current && revision.current === submittedRevision)
        notify.err(error);
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return {
    canRead,
    canSearch,
    query,
    setQuery,
    relations,
    relationsQ,
    searchQ,
    results,
    editable,
    saving,
    update,
    add,
    save,
    valid:
      relations.length <= 30 &&
      relations.every((row) => validRelationOrder(row.sortOrder)),
    dirty: draft !== null,
  };
}
