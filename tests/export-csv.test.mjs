import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { csvCell } from "../lib/export-csv.ts";

test("CSV export neutralizes spreadsheet formulas, including after invisible prefixes",()=>{
  for(const value of ["=1+1","+SUM(A1:A2)","-1+2","@SUM(A1:A2)"," \t=HYPERLINK(\"https://example.test\")","\r\n+1+2","\u200b@SUM(A1:A2)"]){
    assert.equal(csvCell(value),`"'${value.replaceAll('"','""')}"`);
  }
});

test("CSV export retains ordinary text, numeric values, empty fields, and quote escaping",()=>{
  assert.equal(csvCell("商品\"一号"),'"商品""一号"');
  assert.equal(csvCell("A=1"),'"A=1"');
  assert.equal(csvCell("  普通文本"),'"  普通文本"');
  assert.equal(csvCell("00123"),'"00123"');
  assert.equal(csvCell(12),'"12"');
  assert.equal(csvCell(null),'""');
});

test("full CSV route applies the guarded serializer to all cells",()=>{
  const source=readFileSync(new URL("../app/api/export/route.ts",import.meta.url),"utf8");
  assert.match(source,/row\.map\(csvCell\)/);
});
