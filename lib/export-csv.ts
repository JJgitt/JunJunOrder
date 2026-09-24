// Quoting a CSV field does not stop spreadsheet apps from evaluating formulas.
// Prefix suspicious text with an apostrophe while retaining the original value.
const formulaPrefix=/^[\s\u200b-\u200d\u2060]*[=+\-@]/u;

export function csvCell(value:unknown):string{
  const raw=String(value??"");
  const safe=typeof value==="number"||!formulaPrefix.test(raw)?raw:`'${raw}`;
  return `"${safe.replaceAll('"','""')}"`;
}
