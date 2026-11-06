import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument, parseDate, buildContractView, filterContracts } from '../src/core.mjs';

const names = ['01_contract.txt', '02_amendment_signed.txt', '03_contract.txt', '04_contract.txt', '05_supplier_email.txt', '06_amendment_draft.txt'];
const docs = await Promise.all(names.map(async (name, i) => parseDocument({ name, text: await readFile(new URL(`../PO_Vibecoding_Task/${name}`, import.meta.url), 'utf8') }, `d${i}`)));
test('six originals: classification and extracted facts, not resolved conditions', () => {
  assert.deepEqual(docs.map(d => d.type), ['contract', 'amendment', 'contract', 'contract', 'letter', 'draft']);
  assert.deepEqual(docs.map(d => d.contractNumber.value), ['STN-101', 'STN-101', 'STN-102', 'STN-103', 'STN-102', 'STN-101']);
  assert.deepEqual(docs.map(d => d.amount.value), [1200000, 1380000, 840000, null, null, 1450000]);
  assert.deepEqual(docs.map(d => d.delivery.value), ['2026-04-15', '2026-04-30', '2026-03-20', '2026-04-30', '2026-03-27', '2026-05-10']);
  assert.equal(docs[2].supplier.value, 'ООО «Контур Электро»');
  assert.equal(docs[3].amount.status, 'no-data');
  assert.equal(docs[1].effectiveDate.value, '2026-03-01');
});
test('renaming and changing source values needs no code changes', () => {
  const doc = parseDocument({ name: 'anything.txt', text: docs[0].text.replace('1 200 000', '2 750 000').replace('15.04.2026', '17.06.2026') });
  assert.equal(doc.amount.value, 2750000); assert.equal(doc.delivery.value, '2026-06-17');
});
test('new contract and missing data', () => {
  const doc = parseDocument({ name: 'new.txt', text: 'ДОГОВОР ПОСТАВКИ № ABC-999\n\nПоставщик: ООО «Новый».\n\nОбщая стоимость поставки составляет 99 000 рублей.\n\nПоставщик обязуется поставить товар не позднее 02.12.2026.' });
  assert.equal(doc.contractNumber.value, 'ABC-999'); assert.equal(doc.amount.value, 99000);
  assert.equal(doc.supplier.value, 'ООО «Новый»'); assert.equal(doc.delivery.value, '2026-12-02');
  assert.equal(parseDocument({ name: 'empty.txt', text: '' }).delivery.status, 'no-data');
});
test('conflicting facts and invalid dates require review', () => {
  const doc = parseDocument({ name: 'conflict.txt', text: docs[0].text + '\n\nОбщая стоимость поставки составляет 900 рублей.' });
  assert.equal(doc.amount.status, 'needs-review'); assert.equal(doc.amount.value, null);
  assert.equal(parseDate('31.02.2026'), null);
});
test('negation never becomes a confirmed signature', () => {
  assert.equal(docs[5].signing.status, 'no-data');
  assert.equal(docs[4].signing.status, 'no-data');
  assert.equal(docs[1].signing.value, '2026-03-01');
  const doc = parseDocument({ name: 'x', text: 'Статус: не подписано обеими сторонами 01.03.2026.' });
  assert.equal(doc.signing.value, null);
});
test('every quote and paragraph range matches original text exactly', () => {
  for (const doc of docs) {
    for (const p of doc.paragraphs) assert.equal(doc.text.slice(p.start, p.end), p.text);
    for (const key of ['contractNumber', 'supplier', 'amount', 'delivery', 'signing', 'effectiveDate']) {
      for (const e of doc[key].evidence) {
        const p = doc.paragraphs.find(p => p.id === e.paragraphId);
        assert.ok(p); assert.equal(e.quote, p.text); assert.equal(e.fileName, doc.name);
      }
    }
  }
});
test('BOM and CRLF preserve exact source ranges', () => {
  const text = '\uFEFF' + docs[0].text.replaceAll('\n', '\r\n');
  const doc = parseDocument({ name: 'windows.txt', text });
  assert.equal(doc.type, 'contract'); assert.equal(doc.amount.value, 1200000);
  for (const p of doc.paragraphs) assert.equal(text.slice(p.start, p.end), p.text);
});

const view = (documents = docs, date = '2026-03-10') => buildContractView(documents, date);
let sequence = 0;
const parse = text => parseDocument({ name: `arbitrary-${sequence}.txt`, text }, `test-${sequence++}`);
function amendment(body, effective = '05.03.2026', signed = '02.03.2026') {
  return parse(`ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 7 К ДОГОВОРУ Q-725\nСтатус: подписано обеими сторонами ${signed}.\n\n${body}\n\nСоглашение вступает в силу ${effective}.`);
}
const base = parse('ДОГОВОР ПОСТАВКИ № Q-725\nСтатус: подписан обеими сторонами 01.02.2026.\n\nПоставщик: ООО «Тест».\n\nОбщая стоимость поставки составляет 100 000 рублей.\n\nПоставщик обязуется поставить товар не позднее 20.03.2026.');
const cost = value => `Общая стоимость поставки составляет ${value} рублей.`;
const deadline = date => `Поставщик обязуется поставить товар не позднее ${date}.`;

test('unchanged amount mention preserves base while delivery changes', () => {
  const a = amendment('Общая стоимость поставки остаётся без изменений.\n\n' + deadline('25.03.2026'));
  const c = view([base, a]).contracts[0];
  assert.equal(c.amount.value, 100000);
  assert.deepEqual(c.amount.evidence, base.amount.evidence);
  assert.equal(c.delivery.value, '2026-03-25');
});

test('explicit unparseable changes require review instead of inheriting either field', () => {
  for (const [key, body] of [
    ['amount', 'Предлагается изменить общую стоимость поставки на сумму из отсутствующей спецификации.'],
    ['delivery', 'Изменить срок поставки на дату из отсутствующего приложения.']
  ]) {
    const a = amendment(body);
    const c = view([base, a]).contracts[0];
    assert.equal(c[key].status, 'needs-review');
    assert.equal(c[key].value, null);
    assert.ok(c[key].evidence.some(e => e.quote.includes(body)));
  }
});

test('resolved originals on verification date; proposals remain separate', () => {
  const { contracts, unlinkedDocuments } = view();
  assert.equal(unlinkedDocuments.length, 0);
  assert.deepEqual(contracts.map(c => [c.number, c.amount.value, c.delivery.value]), [
    ['STN-101', 1380000, '2026-04-30'], ['STN-102', 840000, '2026-03-20'], ['STN-103', null, '2026-04-30']
  ]);
  assert.equal(contracts[2].amount.status, 'no-data');
  assert.equal(contracts[0].notAppliedChanges[0].reason, 'draft');
  assert.equal(contracts[0].notAppliedChanges[0].fields.amount.value, 1450000);
  assert.equal(contracts[1].notAppliedChanges[0].reason, 'letter');
  assert.equal(contracts[1].notAppliedChanges[0].fields.delivery.value, '2026-03-27');
});

test('same original contract before, on and after amendment effective date', () => {
  for (const [date, amount, delivery] of [
    ['28.02.2026', 1200000, '2026-04-15'], ['01.03.2026', 1380000, '2026-04-30'], ['02.03.2026', 1380000, '2026-04-30']
  ]) {
    const c = view(docs, date).contracts[0];
    assert.equal(c.amount.value, amount); assert.equal(c.delivery.value, delivery);
  }
});

test('independent fields, chronology and input order', () => {
  const a = amendment(cost(200000));
  const b = amendment(deadline('25.03.2026'), '06.03.2026');
  const c = view([b, base, a]).contracts[0];
  assert.equal(c.amount.value, 200000); assert.equal(c.delivery.value, '2026-03-25');
  assert.deepEqual(c.amount.evidence, a.amount.evidence);
  assert.deepEqual(c.delivery.evidence, b.delivery.evidence);
  assert.equal(view([base, a]).contracts[0].delivery.value, base.delivery.value);
  assert.equal(view([base, b]).contracts[0].amount.value, base.amount.value);
});

test('future effective date and future signing do not apply, including boundaries', () => {
  const future = amendment(cost(300000), '11.03.2026');
  assert.equal(view([base, future]).contracts[0].amount.value, 100000);
  assert.equal(view([base, future]).contracts[0].notAppliedChanges[0].reason, 'future-effective-date');
  assert.equal(view([base, future], '2026-03-11').contracts[0].amount.value, 300000);
  const lateSigning = amendment(cost(400000), '05.03.2026', '12.03.2026');
  assert.equal(view([base, lateSigning]).contracts[0].amount.value, 100000);
  assert.equal(view([base, lateSigning]).contracts[0].notAppliedChanges[0].reason, 'future-signing');
  assert.equal(view([base, lateSigning], '2026-03-12').contracts[0].amount.value, 400000);
});

test('unsigned amendment is separate; uncertain authority requires review', () => {
  const signed = amendment(cost(500000));
  const unsigned = parse(signed.text.replace('подписано обеими сторонами', 'не подписано обеими сторонами'));
  const c = view([base, unsigned]).contracts[0];
  assert.equal(c.amount.value, 100000); assert.equal(c.notAppliedChanges[0].reason, 'unsigned');
  const noDate = parse(signed.text.replace('вступает в силу 05.03.2026', 'вступает в силу после согласования'));
  assert.equal(view([base, noDate]).contracts[0].amount.status, 'needs-review');
  assert.equal(view([base, noDate]).contracts[0].delivery.value, base.delivery.value);
});

test('same-date conflicts affect only the changed field, later replacement resolves them', () => {
  const a = amendment(cost(200000)); const b = amendment(cost(300000));
  const c = view([base, a, b]).contracts[0];
  assert.equal(c.amount.status, 'needs-review'); assert.equal(c.amount.value, null);
  assert.equal(c.amount.evidence.length, 2); assert.equal(c.delivery.value, base.delivery.value);
  assert.equal(view([base, a, b, amendment(cost(400000), '07.03.2026')]).contracts[0].amount.value, 400000);
  const both = view([base, a, amendment(deadline('27.03.2026'))]).contracts[0];
  assert.equal(both.amount.value, 200000); assert.equal(both.delivery.value, '2026-03-27');
});

test('duplicate bases and identical changes preserve agreement, conflicting bases require review', () => {
  const duplicate = parse(base.text);
  const c = view([base, duplicate]).contracts[0];
  assert.equal(c.amount.value, 100000); assert.equal(c.amount.evidence.length, 2);
  assert.deepEqual(c.diagnostics, ['duplicate-base-contracts']);
  const conflict = parse(base.text.replace('100 000', '900 000'));
  assert.equal(view([base, conflict]).contracts[0].amount.status, 'needs-review');
  const a = amendment(cost(200000));
  assert.equal(view([base, a, parse(a.text)]).contracts[0].amount.value, 200000);
});

test('missing and ambiguous links are diagnosed, never attached by supplier or filename', () => {
  const orphan = amendment(cost(200000));
  assert.equal(view([orphan]).unlinkedDocuments[0].reason, 'missing-base-contract');
  const ambiguous = parse(orphan.text + '\nПо договору OTHER-12 изменить условия.');
  const c = view([base, ambiguous]);
  assert.equal(c.contracts[0].amount.value, 100000);
  assert.equal(c.unlinkedDocuments[0].status, 'needs-review');
});

test('strict delivery filter excludes equal and unknown dates and retains proposals', () => {
  const { contracts } = view();
  const filtered = filterContracts(contracts, { deliveryBefore: '01.04.2026' });
  assert.deepEqual(filtered.map(c => c.number), ['STN-102']);
  assert.equal(filtered[0].notAppliedChanges[0].fields.delivery.value, '2026-03-27');
  assert.equal(filterContracts(contracts, { deliveryBefore: '2026-03-20' }).length, 0);
  const unknown = { delivery: { status: 'no-data', value: null } };
  assert.equal(filterContracts([unknown], { deliveryBefore: '2026-04-01' }).length, 0);
  assert.equal(filterContracts(contracts).length, 3);
  assert.throws(() => filterContracts(contracts, { deliveryBefore: '2026-02-31' }), RangeError);
  assert.throws(() => view(docs, 'invalid'), RangeError);
});

test('resolved source references are exact and resolution does not mutate parsed documents', () => {
  const snapshot = JSON.stringify(docs);
  const { contracts } = view();
  assert.deepEqual(contracts[0].amount.evidence, docs[1].amount.evidence);
  assert.deepEqual(contracts[1].delivery.evidence, docs[2].delivery.evidence);
  for (const c of contracts) for (const key of ['amount', 'delivery', 'supplier']) {
    for (const e of c[key].evidence) {
      const doc = docs.find(d => d.paragraphs.some(p => p.id === e.paragraphId));
      const p = doc.paragraphs.find(p => p.id === e.paragraphId);
      assert.equal(e.fileName, doc.name); assert.equal(e.quote, doc.text.slice(p.start, p.end));
    }
  }
  assert.equal(JSON.stringify(docs), snapshot);
});

test('resolution uses changed content and new identifiers, not fixture names', () => {
  const renamed = [base, amendment(cost(777777))].map(d => parseDocument({
    name: 'same-name.txt', text: d.text.replaceAll('Q-725', 'NEW-808')
  }, `renamed-${d.id}`));
  const c = view(renamed).contracts[0];
  assert.equal(c.number, 'NEW-808'); assert.equal(c.amount.value, 777777);
  assert.equal(c.delivery.value, '2026-03-20');
});

test('ambiguous extracted amendment field and unconfirmed base are not silently trusted', () => {
  const a = amendment(`${cost(200000)}\n\n${cost(300000)}`);
  assert.equal(view([base, a]).contracts[0].amount.status, 'needs-review');
  const unsignedBase = parse(base.text.replace('подписан обеими сторонами', 'не подписан обеими сторонами'));
  assert.equal(view([unsignedBase]).contracts[0].delivery.status, 'needs-review');
  assert.equal(view([base], '2026-01-31').contracts[0].amount.status, 'needs-review');
});
