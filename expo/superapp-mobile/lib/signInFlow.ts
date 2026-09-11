import type {
  WorkspaceRefreshOptions,
  WorkspaceSnapshot,
} from "./workspaceAccess";

export type NativeTwoFactorInput = Readonly<{
  ticket: string;
  code?: string;
  recoveryCode?: string;
}>;

type CompleteTwoFactorDependencies = Readonly<{
  completeNativeTwoFactor(input: NativeTwoFactorInput): Promise<unknown>;
  refreshWorkspace(
    options?: WorkspaceRefreshOptions,
  ): Promise<WorkspaceSnapshot>;
  unlockLocalSession(): Promise<void>;
}>;

/**
 * One visible local confirmation authorizes both session creation and the first
 * protected workspace read. A second prompt here is redundant and can make a
 * successful server login appear to fail when the user closes it.
 */
export async function completeTwoFactorSignIn(
  input: NativeTwoFactorInput,
  dependencies: CompleteTwoFactorDependencies,
): Promise<WorkspaceSnapshot> {
  await dependencies.unlockLocalSession();
  await dependencies.completeNativeTwoFactor(input);
  return dependencies.refreshWorkspace({
    localProtectionAlreadyConfirmed: true,
  });
}
