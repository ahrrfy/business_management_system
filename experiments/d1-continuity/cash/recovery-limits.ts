// A complete signed record plus page envelope must fit one bounded recovery page.
export const MAX_PAGE_BYTES = 128 * 1024;
export const RECOVERY_PAGE_OVERHEAD = 513;
