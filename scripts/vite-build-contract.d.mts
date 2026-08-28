export const VITE_DISABLE_DOTENV_ENV_KEY: "ERP_VITE_DISABLE_DOTENV";
export const VITE_DISABLE_DOTENV_ENV_VALUE: "1";

export const DEFAULT_CHUNK_BUDGET_BYTES: 500_000;
export const EXCEL_CHUNK_NAME: "exceljs";
export const EXCEL_CHUNK_BUDGET_BYTES: 950_000;
export const CHUNK_SIZE_WARNING_LIMIT_KB: number;

export function resolveViteEnvDir(
  environment: Readonly<Record<string, string | undefined>>,
  projectRoot: string,
): false | string;

export function chunkBudgetViolation(
  output:
    | { type: "chunk"; name: string; fileName: string; code: string }
    | { type: "asset" }
    | null
    | undefined,
): string | null;
