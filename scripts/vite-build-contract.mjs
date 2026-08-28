export const VITE_DISABLE_DOTENV_ENV_KEY = "ERP_VITE_DISABLE_DOTENV";
export const VITE_DISABLE_DOTENV_ENV_VALUE = "1";

export const DEFAULT_CHUNK_BUDGET_BYTES = 500_000;
export const EXCEL_CHUNK_NAME = "exceljs";
export const EXCEL_CHUNK_BUDGET_BYTES = 950_000;
export const CHUNK_SIZE_WARNING_LIMIT_KB = EXCEL_CHUNK_BUDGET_BYTES / 1_000;

export function resolveViteEnvDir(environment, projectRoot) {
  return environment?.[VITE_DISABLE_DOTENV_ENV_KEY] ===
    VITE_DISABLE_DOTENV_ENV_VALUE
    ? false
    : projectRoot;
}

export function chunkBudgetViolation(output) {
  if (output?.type !== "chunk") return null;
  const bytes = Buffer.byteLength(output.code);
  const budget =
    output.name === EXCEL_CHUNK_NAME
      ? EXCEL_CHUNK_BUDGET_BYTES
      : DEFAULT_CHUNK_BUDGET_BYTES;
  return bytes > budget
    ? `CHUNK_BUDGET_EXCEEDED ${output.fileName}: ${bytes} > ${budget}`
    : null;
}
