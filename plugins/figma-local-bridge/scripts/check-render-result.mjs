import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkRenderResult } from '../src/render-result-check.mjs';

try {
  const { values } = parseArgs({ options: {
    spec: { type: 'string' }, read: { type: 'string' }, 'root-id': { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.spec || !values.read || !values['root-id']) throw new Error(
    'Usage: node scripts/check-render-result.mjs --spec render-args.json --read full-read.json --root-id 1:3 [--output report.json]');
  const report = checkRenderResult({
    renderArgs: JSON.parse(await readFile(values.spec, 'utf8')),
    readback: JSON.parse(await readFile(values.read, 'utf8')), rootId: values['root-id'],
  });
  const json = JSON.stringify(report, null, 2) + '\n';
  // Exclusive creation protects input files, symlinks and previous reports.
  if (values.output) await writeFile(values.output, json, { flag: 'wx' });
  console.log(values.output ? JSON.stringify({ report: values.output, automatedStatus: report.automated.status,
    checkedFields: report.automated.checked.length, differences: report.automated.differences,
    uncheckedFields: report.unchecked.length, overallStatus: report.overallStatus, visual: report.visual }) : json);
  if (report.automated.status === 'mismatch') process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error.message, overallStatus: 'incomplete' }));
  process.exitCode = 1;
}
