// Deterministic rules for the supplied general format. No filename-based rules.
export function parseDate(value) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!m) return null;
  const [, day, month, year] = m;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseDocument({ name, text }, documentId = 'document') {
  const paragraphs = [];
  const blocks = /[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/g;
  for (const match of text.matchAll(blocks)) {
    paragraphs.push({ id: `${documentId}-p${paragraphs.length}`, start: match.index,
      end: match.index + match[0].length, text: match[0] });
  }
  const heading = text.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/)[0] || '';
  const type = /ПРОЕКТ.*ДОПОЛНИТЕЛЬНОГО/i.test(heading) ? 'draft'
    : /ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ/i.test(heading) ? 'amendment'
    : /ДОГОВОР ПОСТАВКИ/i.test(heading) ? 'contract'
    : /ПИСЬМО/i.test(heading) ? 'letter' : 'unknown';
  const evidence = p => ({ fileName: name, paragraphId: p.id, quote: p.text });
  const collect = regex => paragraphs.flatMap(p => [...p.text.matchAll(regex)].map(m => ({ raw: m[1], source: evidence(p) })));
  const field = (candidates, convert = s => s.trim()) => {
    const values = candidates.map(c => ({ value: convert(c.raw), source: c.source }));
    const unique = new Set(values.map(c => c.value));
    const status = !values.length ? 'no-data' : unique.size > 1 || unique.has(null) ? 'needs-review' : 'found';
    return { status, value: status === 'found' ? values[0].value : null, evidence: values.map(c => c.source) };
  };
  const numbers = collect(/договор(?:у|а|ом)?(?:\s+поставки)?\s+(?:№\s*)?((?=[A-ZА-ЯЁ0-9/-]*\d)[A-ZА-ЯЁ0-9]+(?:[-/][A-ZА-ЯЁ0-9]+)*)/giu);
  const contractNumber = field(numbers, s => s.toUpperCase());
  const supplier = field(collect(/Поставщик:\s*([^\r\n]+?)(?=\.\s|\r?\n|$)/giu), s => s.trim().replace(/\.$/, ''));
  const amountCandidates = collect(/общ(?:ая|ую) стоимость(?:\s+поставки)?\s+(?:составляет|на)\s+([\d][\d \u00a0\u202f]*(?:[,.]\d{1,2})?)/giu);
  const amount = field(amountCandidates, s => {
    const n = Number(s.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  });
  const delivery = field(collect(/(?:обязуется поставить[^\r\n]*?не позднее|(?:изменить|перенести)\s+срок поставки\s+(?:с\s+\d{2}\.\d{2}\.\d{4}\s+)?на)\s+(\d{2}\.\d{2}\.\d{4})/giu), parseDate);
  const signing = field(collect(/^Статус:\s*подписан[оа]? обеими сторонами\s+(\d{2}\.\d{2}\.\d{4})/gimu), parseDate);
  const effectiveDate = field(collect(/(?:соглашение\s+)?вступает в силу\s+(\d{2}\.\d{2}\.\d{4})/giu), parseDate);
  // Preserve the paragraph explaining an explicitly missing amount.
  if (amount.status === 'no-data') {
    amount.evidence = paragraphs.filter(p => /общая стоимость/i.test(p.text)).map(evidence);
  }
  return { id: documentId, name, text, paragraphs, type, contractNumber,
    supplier, amount, delivery, signing, effectiveDate };
}

// Public date arguments accept either UI ISO dates or the document DD.MM.YYYY format.
function requireDate(value) {
  const iso = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? parseDate(`${value.slice(8)}.${value.slice(5, 7)}.${value.slice(0, 4)}`)
    : parseDate(value);
  if (!iso) throw new RangeError('Expected a valid YYYY-MM-DD or DD.MM.YYYY date');
  return iso;
}

function combineFacts(facts) {
  const evidence = facts.flatMap(f => f.evidence);
  const first = facts[0];
  const agrees = facts.every(f => f.status === first.status && f.value === first.value);
  return { status: agrees ? first.status : 'needs-review',
    value: agrees ? first.value : null, evidence };
}

function reviewFact(facts) {
  return { status: 'needs-review', value: null, evidence: facts.flatMap(f => f.evidence) };
}

function explicitlyUnsigned(doc) {
  return /^Статус:[^\r\n]*не подписан/imu.test(doc.text);
}

// A mention is not an edit. Only supported explicit replacement wording blocks inheritance.
function changedFact(doc, key) {
  if (doc[key].status !== 'no-data') return doc[key];
  const topic = key === 'amount' ? /общ(?:ая|ую) стоимость/i : /срок поставки/i;
  const edits = doc.paragraphs.filter(p => p.text.split(/\r?\n|\.\s+/).some(sentence =>
    topic.test(sentence) && !/(?:оста[её]тся|оставить|остаются).*без изменений/i.test(sentence)
    && /изменить|перенести|изложить|составляет|установить/i.test(sentence)));
  return edits.length ? { status: 'needs-review', value: null, evidence: edits.map(p => ({
    fileName: doc.name, paragraphId: p.id, quote: p.text
  })) } : null;
}

/** Returns { contracts, unlinkedDocuments }. Inputs are never mutated.
 * Each contract retains parsed document references and per-field evidence.
 * notAppliedChanges items contain { document, reason, fields }.
 */
export function buildContractView(documents, asOfDate) {
  const date = requireDate(asOfDate);
  const groups = new Map();
  const unlinkedDocuments = [];
  for (const doc of documents) {
    if (doc.contractNumber.status !== 'found') {
      unlinkedDocuments.push({ document: doc, status: 'needs-review', reason: 'ambiguous-or-missing-contract-number' });
      continue;
    }
    const number = doc.contractNumber.value;
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push(doc);
  }
  const contracts = [];
  for (const [number, linked] of groups) {
    const bases = linked.filter(d => d.type === 'contract');
    if (!bases.length) {
      unlinkedDocuments.push(...linked.map(document => ({ document, status: 'needs-review', reason: 'missing-base-contract' })));
      continue;
    }
    const contract = { number, contractNumber: combineFacts(bases.map(d => d.contractNumber)),
      supplier: combineFacts(bases.map(d => d.supplier)), documents: [...linked],
      notAppliedChanges: [], diagnostics: [] };
    if (bases.length > 1) contract.diagnostics.push('duplicate-base-contracts');
    const usableBases = bases.filter(d => d.signing.status === 'found' && d.signing.value <= date);
    const baseUncertain = usableBases.length !== bases.length;
    const applicable = [];
    const uncertain = [];
    for (const doc of linked.filter(d => d.type !== 'contract')) {
      let reason = null;
      if (doc.type !== 'amendment') reason = doc.type === 'draft' ? 'draft' : doc.type === 'letter' ? 'letter' : 'unknown-document-type';
      else if (explicitlyUnsigned(doc)) reason = 'unsigned';
      else if (doc.signing.status !== 'found') reason = 'uncertain-signing';
      else if (doc.signing.value > date) reason = 'future-signing';
      else if (doc.effectiveDate.status !== 'found') reason = 'uncertain-effective-date';
      else if (doc.effectiveDate.value > date) reason = 'future-effective-date';
      if (reason) {
        contract.notAppliedChanges.push({ document: doc, reason, fields: { amount: doc.amount, delivery: doc.delivery } });
        if (['uncertain-signing', 'uncertain-effective-date', 'unknown-document-type'].includes(reason)) uncertain.push(doc);
      } else applicable.push(doc);
    }
    for (const key of ['amount', 'delivery']) {
      let fact = combineFacts(bases.map(d => d[key]));
      if (baseUncertain) fact = reviewFact([fact, ...bases.map(d => d.signing)]);
      const touches = doc => changedFact(doc, key) !== null;
      const changes = applicable.filter(touches);
      if (changes.length) {
        const latest = changes.reduce((max, d) => d.effectiveDate.value > max ? d.effectiveDate.value : max, '');
        fact = combineFacts(changes.filter(d => d.effectiveDate.value === latest).map(d => changedFact(d, key)));
        if (baseUncertain) fact = reviewFact([fact, ...bases.map(d => d.signing)]);
      }
      const blockers = uncertain.filter(touches);
      if (blockers.length) fact = reviewFact([fact, ...blockers.map(d => changedFact(d, key))]);
      contract[key] = fact;
    }
    if (baseUncertain) contract.diagnostics.push('base-signing-not-confirmed-as-of-date');
    contracts.push(contract);
  }
  return { contracts, unlinkedDocuments };
}

/** Unknown/ambiguous deadlines are excluded; callers can display them separately. */
export function filterContracts(contracts, { deliveryBefore } = {}) {
  if (deliveryBefore == null || deliveryBefore === '') return [...contracts];
  const before = requireDate(deliveryBefore);
  return contracts.filter(c => c.delivery.status === 'found' && c.delivery.value < before);
}
