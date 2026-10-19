// Read-only reuse of the reviewed fixed process/datadir/UTC/schema guard and
// the SAME s5 :accounting advisory lock. Do not use a separate digital lock.
export {
  connectAccountingOracle as connectDigitalOracle,
  oracleDatabase,
  oracleEnv,
  parentLab,
} from "../accounting/mysql-lab.mjs";
