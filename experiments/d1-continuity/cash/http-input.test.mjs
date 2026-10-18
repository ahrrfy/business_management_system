import test from 'node:test';
import assert from 'node:assert/strict';
import {cashHttpInput} from './http-input.ts';
import {fixtureInput} from './fixture.ts';
import {invoices} from '../../../drizzle/schema.ts';

test('cash request keys fit the original invoice source key without truncation',()=>{
 const match=/^varchar\((\d+)\)$/.exec(invoices.sourceId.getSQLType());assert.ok(match);
 const limit=Number(match[1]);
 assert.equal(cashHttpInput.safeParse({...fixtureInput,clientRequestId:'x'.repeat(limit)}).success,true);
 assert.equal(cashHttpInput.safeParse({...fixtureInput,clientRequestId:'x'.repeat(limit+1)}).success,false);
});
