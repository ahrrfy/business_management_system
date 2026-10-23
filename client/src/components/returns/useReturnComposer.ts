import { useReturnComposerState } from "./useReturnComposerState";
import { useReturnComposerSettlement } from "./useReturnComposerSettlement";
import { useReturnComposerMutations } from "./useReturnComposerMutations";
import { useReturnComposerQuantity } from "./useReturnComposerQuantity";
import { useReturnComposerGuard } from "./useReturnComposerGuard";
import { useReturnComposerSubmission } from "./useReturnComposerSubmission";
import type { ReturnComposerProps } from "./returnComposerTypes";
export function useReturnComposer(props: ReturnComposerProps) {
  const state = useReturnComposerState(props);
  const settlement = useReturnComposerSettlement({ ...state });
  const mutations = useReturnComposerMutations({ ...state, ...settlement });
  const quantity = useReturnComposerQuantity({ ...state, ...settlement, ...mutations });
  const guard = useReturnComposerGuard({
    ...state,
    ...settlement,
    ...mutations,
    ...quantity,
  });
  const submission = useReturnComposerSubmission({
    ...state,
    ...settlement,
    ...mutations,
    ...quantity,
    ...guard,
  });
  return { ...state, ...settlement, ...mutations, ...quantity, ...guard, ...submission };
}
export type ReturnComposerModel = ReturnType<typeof useReturnComposer>;
