import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const queryString = require("query-string");

assert.equal(typeof queryString.parse, "function");
assert.equal(typeof queryString.stringify, "function");

const parsed = queryString.parse("name=%D8%B9%D9%84%D9%8A&branch=main");
assert.equal(parsed.name, "علي");
assert.equal(parsed.branch, "main");
assert.equal(queryString.stringify({ name: parsed.name }), "name=%D8%B9%D9%84%D9%8A");

console.log("[query-string security compatibility] OK");
