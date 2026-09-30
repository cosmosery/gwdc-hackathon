import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomic, decimal, parseCsv, sampleCsv, payable, reviewRows, exportCsv, validAddress, SENDER, sum } from '../src/domain';
import { assertQuote } from '../src/api';
test('amount precision and invalid formats', () => {
  assert.equal(atomic('9007199254740993.123456'), '9007199254740993123456');
  assert.equal(decimal('1000001', false), '1.000001');
  for (const v of ['0', '-1', '1e3', '1,000', '0.0000001', 'NaN', '+1', '01']) assert.equal(atomic(v), null);
});
test('address checksum rejects one-character change', async () => {
  assert.equal(await validAddress(SENDER), true);
  assert.equal(await validAddress(SENDER.slice(0, -1) + '1'), false);
});
test('warnings need confirmation and errors cannot be bypassed', async () => {
  let rows = await parseCsv(sampleCsv());
  assert.equal(payable(rows).length, 3);
  assert.equal(sum(payable(rows)), '60000');
  rows = await reviewRows(rows.map(r => r.id === 'row-2' ? { ...r, amount: '0.025', metadata: {...r.metadata, amount: '0.025'} } : r.id === 'row-3' ? { ...r, address: 'invalid', metadata: {...r.metadata, recipient_address: 'invalid'} } : r));
  assert.equal(payable(rows).length, 1);
  rows = await reviewRows(rows.map(r => r.id === 'row-2' ? { ...r, acknowledged: true } : r));
  assert.equal(payable(rows).length, 2);
  rows = await reviewRows(rows.map(r => r.id === 'row-3' ? { ...r, acknowledged: true } : r));
  assert.equal(payable(rows).length, 2);
  rows = await reviewRows(rows.map(r => r.id === 'row-1' ? { ...r, excluded: true } : r));
  assert.equal(payable(rows)[0].sourceRow, 2);
  assert.equal(payable(rows)[0].id, 'row-2');
});
test('bad headers reject entire import', async () => {
  await assert.rejects(parseCsv('amount,amount\n1,2'), /Duplicate/);
  await assert.rejects(parseCsv('recipient_name,amount\nAlex,10'), /Missing/);
  await assert.rejects(parseCsv(sampleCsv().replace('memo', 'unknown_column')), /Unknown/);
});
test('CSV export escapes spreadsheet formula cells', () => {
  assert.ok(exportCsv([{name:'=HYPERLINK("bad")',amount:'1.000000'}]).includes("'=HYPERLINK"));
});
test('wire quote cannot silently accept decimal units or null fee', () => {
  const q = {recipientCount:1,totalAmount:'1000000',estimatedGasFreeFee:'300000',estimatedTotal:'1300000',estimatedRelayerFeeTrx:'35.0',transactionCount:3};
  assert.equal(assertQuote(q).estimatedTotal, '1300000');
  assert.throws(() => assertQuote({...q,totalAmount:'1.000000'}));
  assert.throws(() => assertQuote({...q,estimatedGasFreeFee:null}));
});
