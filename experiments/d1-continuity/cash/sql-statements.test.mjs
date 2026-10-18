import test from'node:test';import assert from'node:assert/strict';import{sqlStatements}from'./sql-statements.mjs';
test('trigger splitting retains CASE END statements and quoted terminators',()=>{
 const source="CREATE TABLE a(id INTEGER);CREATE TRIGGER t BEFORE INSERT ON a BEGIN SELECT CASE WHEN NEW.id=1 THEN 'END;CASE' ELSE RAISE(ABORT,'bad') END; SELECT 1; END;INSERT INTO a VALUES(1);";
 const statements=sqlStatements(source);assert.equal(statements.length,3);assert.match(statements[1],/END; SELECT 1; END$/);assert.equal(statements[2],'INSERT INTO a VALUES(1)');
});
