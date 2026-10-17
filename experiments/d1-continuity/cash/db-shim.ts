export function getDb(): never {
  throw new Error(
    "Global database access forbidden in isolated cash transaction",
  );
}
export function getPool(): never {
  throw new Error("MySQL pool forbidden");
}
export type DB = any;
export type Tx = any;
