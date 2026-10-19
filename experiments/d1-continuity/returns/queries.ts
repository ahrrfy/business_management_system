import { allowedQueries as original } from "../credit/queries";
import { returnQueries } from "./queries-extra";
export const allowedQueries = new Set([...original, ...returnQueries]);
