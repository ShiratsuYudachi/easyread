const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

/* 句子对齐的渲染：有 sents 一句一个 span；旧数据、译文改过、对不上的都按整段 */
function load(blocks, edits = {}, layout = {}) {
  const PR = {
    state: { reader: { edits, notes: {} }, paper: { blocks }, layout },
    on() {}, emit() {}, esc: String, md: (t) => '<' + t + '>', t: (s) => s, imageUrl: (s) => s, hashText: (s) => s,
    $: () => null, $$: () => [],
  };
  const ctx = { window: { PR }, document: { getElementById: () => null, addEventListener() {} }, CSS: { escape: String }, getSelection: () => ({ toString: () => '' }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/render.js'), 'utf8'), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/js/reader/sentences.js'), 'utf8'), ctx);
  blocks.forEach((b) => (PR.blockById[b.id] = b));
  return PR;
}

const para = { id: 'p1', type: 'para', en: 'A b. C d.', zh: '甲。乙。', sents: [[4, 2], [9, 4]] };

test('aligned paragraph renders one span per sentence on both sides', () => {
  const PR = load([para]);
  assert.equal(PR.sentMd('p1', 'en', para.en), '<span class="snt" data-s="0"><A b.></span> <span class="snt" data-s="1"><C d.></span>');
  assert.equal(PR.sentMd('p1', 'zh', para.zh), '<span class="snt" data-s="0"><甲。></span><span class="snt" data-s="1"><乙。></span>');
});

test('old paragraphs without sents render as a whole', () => {
  const PR = load([{ id: 'p1', type: 'para', en: 'A b. C d.', zh: '甲。乙。' }]);
  assert.equal(PR.alignOf('p1'), null);
  assert.equal(PR.sentMd('p1', 'en', 'A b. C d.'), '<A b. C d.>');
});

test('my edit drops sentence spans on the translation only', () => {
  const PR = load([para], { p1: { zh: '我的译文' } });
  assert.equal(PR.sentMd('p1', 'zh', '我的译文'), '<我的译文>');
  assert.match(PR.sentMd('p1', 'en', para.en), /data-s="1"/);
});

test('stale or broken sents fall back', () => {
  const PR = load([{ ...para, zh: '甲。乙丙。' }, { ...para, id: 'p2', sents: [[4, 2], [3, 4]] }, { ...para, id: 'p3', en: '**A b. C** d.', sents: [[6, 2], [13, 4]] }]);
  assert.equal(PR.alignOf('p1'), null);
  assert.equal(PR.alignOf('p2'), null);
  assert.equal(PR.sentMd('p3', 'en', '**A b. C** d.'), '<**A b. C** d.>');  // 句界切在粗体中间
});

test('list items align per item; captions never', () => {
  const PR = load([{ id: 'l', type: 'list', items: [{ en: 'X. Y.', zh: '一。二。', sents: [[2, 2], [5, 4]] }] },
    { id: 'f', type: 'figure', caption_en: 'A. B.', caption_zh: '甲。乙。', sents: [[2, 2], [5, 4]] }]);
  assert.ok(PR.alignOf('l#0'));
  assert.equal(PR.alignOf('f#caption'), null);
});

/* 点一句，原页只框这一句：layout.sents 按句存原页区域 */
const rows = [[{ page: 1, box: [0.1, 0.1, 0.5, 0.12] }], [{ page: 2, box: [0.1, 0.2, 0.9, 0.3] }, { page: 2, box: [0.1, 0.3, 0.4, 0.32] }]];
const located = () => ({ p1: { page: 1, box: [0.1, 0.1, 0.9, 0.32], sents: { p1: rows } } });

test('a sentence maps to its page regions only while layout and alignment agree', () => {
  const PR = load([para], {}, located());
  assert.deepEqual(PR.sentenceRegions({ id: 'p1', key: 'p1', i: 1 }), rows[1]);
  PR.state.layout.p1.sents.p1 = [rows[0]];  // layout from before the translation was re-aligned
  assert.equal(PR.sentenceRegions({ id: 'p1', key: 'p1', i: 0 }), null);
  PR.state.layout.p1.sents.p1 = [rows[0], null];  // this sentence never matched the page
  assert.equal(PR.sentenceRegions({ id: 'p1', key: 'p1', i: 1 }), null);
  delete PR.state.layout.p1.sents;  // older layout without sentences
  assert.equal(PR.sentenceRegions({ id: 'p1', key: 'p1', i: 0 }), null);
});

test('a point on the original page finds the sentence under it', () => {
  const PR = load([para], {}, located());
  const plain = (v) => JSON.parse(JSON.stringify(v));  // objects built inside the vm have another Object prototype
  assert.deepEqual(plain(PR.sentenceAtPoint('p1', 1, 0.3, 0.11)), { id: 'p1', key: 'p1', i: 0 });
  assert.deepEqual(plain(PR.sentenceAtPoint('p1', 2, 0.2, 0.31)), { id: 'p1', key: 'p1', i: 1 });
  assert.equal(PR.sentenceAtPoint('p1', 1, 0.3, 0.5), null);
  assert.equal(PR.sentenceAtPoint('p1', 2, 0.3, 0.11), null);  // right place, wrong page
});

test('the current sentence belongs to one block and reports whether it changed', () => {
  const PR = load([para], {}, located());
  const first = { id: 'p1', key: 'p1', i: 0 };
  assert.equal(PR.setSentence(first), true);
  assert.equal(PR.setSentence({ ...first }), false);
  assert.equal(PR.currentSentence('p1').i, 0);
  assert.equal(PR.currentSentence('other'), null);
  assert.equal(PR.setSentence({ ...first, i: 1 }), true);
  assert.equal(PR.setSentence(null), true);
  assert.equal(PR.setSentence(null), false);
  assert.equal(PR.currentSentence('p1'), null);
});
