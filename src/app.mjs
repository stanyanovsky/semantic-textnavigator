import { parseDocument, buildContractView, filterContracts } from './core.mjs';

const $ = selector => document.querySelector(selector);
const results = $('#results'), sources = $('#sources'), status = $('#status');
const warnings = $('#warnings'), changes = $('#changes');
const asOf = $('#as-of'), before = $('#delivery-before');
const labels = { 'no-data': 'Нет данных', 'needs-review': 'Требует проверки' };
const reasons = {
  draft: 'Проект: не изменяет действующие условия', letter: 'Письмо: предложение не согласовано',
  unsigned: 'Не подписано обеими сторонами', 'uncertain-signing': 'Подписание обеими сторонами не подтверждено',
  'future-signing': 'Дата подписания ещё не наступила', 'uncertain-effective-date': 'Дата вступления в силу не определена',
  'future-effective-date': 'Дата вступления в силу ещё не наступила', 'unknown-document-type': 'Тип документа не распознан',
  'ambiguous-or-missing-contract-number': 'Номер договора отсутствует или неоднозначен',
  'missing-base-contract': 'Основной договор не загружен', 'duplicate-base-contracts': 'Загружено несколько основных договоров с одним номером',
  'base-signing-not-confirmed-as-of-date': 'Подписание основного договора на дату проверки не подтверждено'
};
const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });
const dateLabel = value => value.split('-').reverse().join('.');
function element(tag, text, parent) {
  const node = document.createElement(tag);
  node.textContent = text;
  parent.append(node);
  return node;
}
function showEvidence(evidence, parent) {
  if (!evidence.length) return;
  const details = element('details', '', parent);
  element('summary', 'Основания и точные цитаты', details);
  for (const source of evidence) {
    const link = element('a', source.fileName + ' → к абзацу', details);
    link.href = `#${source.paragraphId}`;
    element('blockquote', source.quote, details);
  }
}
function showFact(fact, key, parent) {
  const value = fact.status !== 'found' ? labels[fact.status]
    : key === 'amount' ? rubles.format(fact.value) : key === 'delivery' ? dateLabel(fact.value) : fact.value;
  element('strong', value, parent);
  if (fact.evidence.length) element('small', 'Источник: ' + [...new Set(fact.evidence.map(e => e.fileName))].join(', '), parent);
  showEvidence(fact.evidence, parent);
}
let documents = [], errors = [], generation = 0, loading = false;
function renderSources() {
  sources.replaceChildren();
  if (!documents.length) return;
  element('h2', 'Исходные документы', sources);
  for (const doc of documents) {
    const details = element('details', '', sources);
    element('summary', doc.name, details);
    for (const paragraph of doc.paragraphs) {
      const node = element('p', paragraph.text, details);
      node.id = paragraph.id; node.className = 'source-paragraph';
    }
  }
}
function render() {
  results.replaceChildren(); warnings.replaceChildren(); changes.replaceChildren();
  for (const error of errors) element('p', error, warnings);
  status.textContent = loading ? 'Чтение файлов…' : `Обработано файлов: ${documents.length}.`;
  if (!documents.length) return;
  try {
    if (!asOf.value) throw new Error('Выберите дату проверки.');
    const { contracts, unlinkedDocuments } = buildContractView(documents, asOf.value);
    const visible = filterContracts(contracts, { deliveryBefore: before.value });
    element('h2', `Условия на ${dateLabel(asOf.value)}`, results);
    element('p', `Показано договоров: ${visible.length} из ${contracts.length}.`, results);
    const wrap = element('div', '', results); wrap.className = 'table-scroll';
    const table = element('table', '', wrap);
    const header = element('tr', '', element('thead', '', table));
    for (const title of ['Договор', 'Поставщик', 'Действующая сумма', 'Срок поставки']) {
      const th = element('th', title, header); th.scope = 'col';
    }
    const body = element('tbody', '', table);
    for (const c of visible) {
      const row = element('tr', '', body);
      for (const key of ['contractNumber', 'supplier', 'amount', 'delivery']) showFact(c[key], key, element('td', '', row));
    }
    if (!visible.length) element('p', 'Нет договоров, соответствующих фильтру.', results);
    for (const c of contracts) {
      for (const reason of c.diagnostics) element('p', `${c.number}: ${reasons[reason]}.`, warnings);
      for (const key of ['supplier', 'amount', 'delivery']) if (c[key].status === 'needs-review') {
        element('p', `${c.number}: ${key === 'amount' ? 'сумма' : key === 'delivery' ? 'срок поставки' : 'поставщик'} — требует проверки.`, warnings);
      }
    }
    if (before.value) {
      const unknown = contracts.filter(c => c.delivery.status !== 'found');
      if (unknown.length) element('p', `Не включены в фильтр из-за неопределённого срока: ${unknown.map(c => c.number).join(', ')}.`, warnings);
    }
    for (const item of unlinkedDocuments) {
      const p = element('p', `Требует проверки — ${item.document.name}: ${reasons[item.reason]}.`, warnings);
      showEvidence(item.document.paragraphs.slice(0, 1).map(p => ({ fileName: item.document.name, paragraphId: p.id, quote: p.text })), p);
    }
    element('h2', 'Несогласованные и другие неприменённые изменения', changes);
    let count = 0;
    for (const c of contracts) for (const item of c.notAppliedChanges) {
      const card = element('article', '', changes);
      element('h3', `${c.number} — ${item.document.name}`, card);
      element('p', reasons[item.reason], card);
      for (const [key, title] of [['amount', 'Предлагаемая сумма'], ['delivery', 'Предлагаемый срок']]) {
        const p = element('div', title + ': ', card); showFact(item.fields[key], key, p);
      }
      count++;
    }
    if (!count) element('p', 'Неприменённых изменений нет.', changes);
  } catch (error) { element('p', error instanceof RangeError ? 'Проверьте корректность выбранных дат.' : error.message, warnings); }
}
$('#files').addEventListener('change', async event => {
  const current = ++generation;
  const files = [...event.target.files];
  documents = []; errors = []; loading = true; renderSources(); render();
  for (const [index, file] of files.entries()) {
    try {
      if (!/\.txt$/i.test(file.name)) throw new Error('ожидается TXT');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (current !== generation) return;
      documents.push(parseDocument({ name: file.name, text }, `load-${current}-doc-${index}`));
    } catch (error) {
      if (current !== generation) return;
      errors.push(`${file.name}: не удалось обработать файл (${error.message}).`);
    }
  }
  if (current !== generation) return;
  loading = false; renderSources(); render();
});
asOf.addEventListener('change', render);
before.addEventListener('change', render);
$('#clear-filter').addEventListener('click', () => { before.value = ''; render(); });
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const target = document.getElementById(link.hash.slice(1));
  if (target) {
    const details = target.closest('details');
    if (details) details.open = true;
    target.scrollIntoView({ block: 'center' });
  }
});
