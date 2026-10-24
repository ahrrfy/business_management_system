import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  canonicalJson,
  type AiProductDraft,
  type DraftValidation,
  type ProductFacts,
} from "@shared/productContentAi";
import {
  PRODUCT_CONTENT_FIELD_LABELS,
  PRODUCT_CONTENT_FIELD_LIMITS,
  type ProductContentField,
} from "@shared/productContentAiLabels";

type Operation = "generate" | "validate" | "save" | "decide";
type ScopedError = { scope: string; error: unknown };
export type ProductContentAssistantProps = {
  facts: ProductFacts;
  productId?: number;
  onApply: (draft: AiProductDraft) => void;
};
function lengthBlockers(draft: AiProductDraft) {
  return (Object.keys(PRODUCT_CONTENT_FIELD_LIMITS) as ProductContentField[])
    .filter(
      (field) => draft[field].length > PRODUCT_CONTENT_FIELD_LIMITS[field],
    )
    .map(
      (field) =>
        `${PRODUCT_CONTENT_FIELD_LABELS[field]} يتجاوز ${PRODUCT_CONTENT_FIELD_LIMITS[field]} حرفاً؛ اختصره ثم أعد التحقق.`,
    );
}
function contentOf(draft: AiProductDraft) {
  return {
    storeTitle: draft.seoTitle,
    seoTitle: draft.seoTitle,
    shortTitle: draft.shortTitle,
    posLabel: draft.posLabel,
    invoiceLabel: draft.invoiceLabel,
    marketingCopy: draft.marketingCopy,
    description: draft.description,
  };
}

export function useProductContentDraft({
  facts,
  productId,
  onApply,
  can,
}: ProductContentAssistantProps & { can: (path: string) => boolean }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<AiProductDraft | null>(null);
  const [edited, setEdited] = useState<
    Partial<Record<ProductContentField, string>>
  >({});
  const [checked, setChecked] = useState<{
    key: string;
    result: DraftValidation;
  } | null>(null);
  const [sourceFingerprint, setSourceFingerprint] = useState<string | null>(
    null,
  );
  const [cacheHit, setCacheHit] = useState(false);
  const [imagesUsed, setImagesUsed] = useState(0);
  const [savedDraftId, setSavedDraftId] = useState<number | null>(null);
  const [pending, setPending] = useState<Record<Operation, boolean>>({
    generate: false,
    validate: false,
    save: false,
    decide: false,
  });
  const [errors, setErrors] = useState<Partial<Record<Operation, ScopedError>>>(
    {},
  );
  const locks = useRef({ generate: false, validate: false, decide: false });
  const mounted = useRef(true),
    revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  const factsFingerprint = canonicalJson(facts);
  const visibleDraft = draft ? { ...draft, ...edited } : null;
  const draftKey = visibleDraft ? canonicalJson([facts, visibleDraft]) : "";
  const latest = useRef({ factsFingerprint, draftKey, can });
  latest.current = { factsFingerprint, draftKey, can };
  const active = (token: number, fingerprint: string) =>
    mounted.current &&
    revision.current === token &&
    latest.current.factsFingerprint === fingerprint;
  const setBusy = (operation: Operation, value: boolean) => {
    if (mounted.current)
      setPending((current) => ({ ...current, [operation]: value }));
  };
  const setError = (operation: Operation, error: unknown, scope: string) => {
    if (mounted.current)
      setErrors((current) => ({ ...current, [operation]: { error, scope } }));
  };
  const generate = trpc.catalog.generateContentDraft.useMutation();
  const validate = trpc.catalog.validateContentDraft.useMutation();
  const save = trpc.catalog.saveContentDraft.useMutation();
  const decide = trpc.catalog.decideContentDraft.useMutation();
  const canReadHistory = !!productId && can("catalog.listContentDrafts");
  const historyScope = String(productId ?? "new");
  const history = trpc.catalog.listContentDrafts.useQuery(
    { productId: productId ?? 0, limit: 10 },
    { enabled: canReadHistory },
  );

  async function generateDraft(forceRefresh = false) {
    if (
      locks.current.generate ||
      !latest.current.can("catalog.generateContentDraft")
    )
      return;
    locks.current.generate = true;
    setBusy("generate", true);
    setError("generate", null, factsFingerprint);
    const token = ++revision.current;
    const fingerprint = factsFingerprint;
    try {
      const result = await generate.mutateAsync({
        facts,
        productId,
        forceRefresh,
      });
      if (!active(token, fingerprint)) return;
      const key = canonicalJson([facts, result.draft]);
      setDraft(result.draft);
      setEdited({});
      setChecked({ key, result: result.validation });
      setSourceFingerprint(fingerprint);
      setCacheHit(result.cacheHit);
      setImagesUsed(result.imagesUsed ?? 0);
      setSavedDraftId(null);
      if (
        productId &&
        result.validation.ok &&
        lengthBlockers(result.draft).length === 0 &&
        latest.current.can("catalog.saveContentDraft")
      ) {
        setBusy("save", true);
        setError("save", null, key);
        try {
          // All persisted fields belong to the submitted product/facts, never the latest render.
          const saved = await save.mutateAsync({
            productId,
            sourceFacts: facts,
            sourceFactsHash: result.cacheKey,
            content: contentOf(result.draft),
            validation: result.validation,
            promptVersion: result.promptVersion,
            model: result.model,
          });
          void utils.catalog.listContentDrafts.invalidate({ productId });
          if (active(token, fingerprint)) setSavedDraftId(saved.draftId);
        } catch (error) {
          if (active(token, fingerprint)) setError("save", error, key);
        } finally {
          setBusy("save", false);
        }
      }
    } catch (error) {
      if (active(token, fingerprint)) setError("generate", error, fingerprint);
    } finally {
      locks.current.generate = false;
      setBusy("generate", false);
    }
  }
  function updateField(field: ProductContentField, value: string) {
    revision.current++;
    setEdited((current) => ({ ...current, [field]: value }));
    setChecked(null);
    setSavedDraftId(null);
  }
  async function validateDraft() {
    if (
      !visibleDraft ||
      locks.current.validate ||
      !latest.current.can("catalog.validateContentDraft")
    )
      return;
    locks.current.validate = true;
    setBusy("validate", true);
    setError("validate", null, draftKey);
    const token = revision.current,
      key = draftKey,
      fingerprint = factsFingerprint;
    try {
      const result = await validate.mutateAsync({ facts, draft: visibleDraft });
      if (active(token, fingerprint) && latest.current.draftKey === key)
        setChecked({ key, result });
    } catch (error) {
      if (active(token, fingerprint) && latest.current.draftKey === key)
        setError("validate", error, key);
    } finally {
      locks.current.validate = false;
      setBusy("validate", false);
    }
  }
  async function decideDraft(
    draftId: number,
    decision: "APPROVED" | "REJECTED",
  ) {
    if (
      !canReadHistory ||
      locks.current.decide ||
      !latest.current.can("catalog.decideContentDraft")
    )
      return;
    locks.current.decide = true;
    setBusy("decide", true);
    setError("decide", null, historyScope);
    try {
      await decide.mutateAsync({
        draftId,
        decision,
        note:
          decision === "APPROVED"
            ? "اعتماد مسودة من شاشة مراجعة المنتج."
            : "رُفضت من شاشة مراجعة المنتج.",
      });
      void utils.catalog.listContentDrafts.invalidate({ productId });
    } catch (error) {
      setError("decide", error, historyScope);
    } finally {
      locks.current.decide = false;
      setBusy("decide", false);
    }
  }
  const draftIsStale = !!draft && sourceFingerprint !== factsFingerprint;
  const needsValidation = !!draft && checked?.key !== draftKey;
  const localBlockers = visibleDraft ? lengthBlockers(visibleDraft) : [];
  const checkedResult = checked?.key === draftKey ? checked.result : null;
  const validation =
    checkedResult || localBlockers.length
      ? {
          ok: !!checkedResult?.ok && localBlockers.length === 0,
          blockers: [...(checkedResult?.blockers ?? []), ...localBlockers],
          warnings: checkedResult?.warnings ?? [],
        }
      : null;
  const canApply =
    !!visibleDraft &&
    !draftIsStale &&
    !needsValidation &&
    validation?.ok === true;
  function applyDraft() {
    if (canApply && visibleDraft) onApply(visibleDraft);
  }
  const errorFor = (operation: Operation, scope: string) =>
    errors[operation]?.scope === scope ? errors[operation]?.error : null;
  return {
    draft,
    visibleDraft,
    edited,
    validation,
    needsValidation,
    draftIsStale,
    canApply,
    cacheHit,
    imagesUsed,
    savedDraftId: !draftIsStale ? savedDraftId : null,
    pending,
    history,
    canReadHistory,
    generateDraft,
    updateField,
    validateDraft,
    decideDraft,
    applyDraft,
    generateError: errorFor("generate", factsFingerprint),
    validateError: errorFor("validate", draftKey),
    saveDraftError: errorFor("save", draftKey),
    decideDraftError: errorFor("decide", historyScope),
  };
}
export type ProductContentDraftEditor = ReturnType<
  typeof useProductContentDraft
>;
