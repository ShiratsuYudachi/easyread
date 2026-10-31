const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

/* 术语抽屉里的“全部术语显示原文”：术语表里的中文译法在正文里换回英文，写成我的修改 */
function load(glossary, texts, edits = {}) {
  const blocks = Object.keys(texts).map((id) => ({ id, type: "para" }));
  const commits = [];
  const PR = {
    state: { paper: { glossary, blocks } },
    blockKeys: (b) => [b.id],
    textFor: (key) => (edits[key] ? edits[key].zh : texts[key]),
    agentText: (key) => texts[key],
    editOf: (key) => edits[key] || null,
    hashText: (s) => "h:" + s,
    commit: (op) => { commits.push(op); if (op.zh == null) delete edits[op.block]; else edits[op.block] = { zh: op.zh }; },
    rerenderKeepingPlace() { PR.rerendered = (PR.rerendered || 0) + 1; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/terms-original.js"), "utf8"), { window: { PR } });
  return { PR, commits, edits };
}

const GL = [{ en: "agent", zh: "智能体" }, { en: "standard error", zh: "标准误差" }, { en: "standard", zh: "标准" }, { en: "policy", zh: "策略（policy）" }];

test("every glossary term goes back to its original and the text is saved as my edit", () => {
  const { PR, commits, edits } = load(GL, { a: "每个智能体学习一个策略，标准误差很小。", b: "没有术语的一段。" });
  const r = PR.termsToOriginal(false);
  assert.equal(r.n, 3);
  assert.equal(edits.a.zh, "每个 agent 学习一个 policy，standard error 很小。");  // 中文紧挨英文时补空格，标点旁不补
  assert.equal(commits.length, 1);
  assert.equal(commits[0].base, "h:每个智能体学习一个策略，标准误差很小。");
  assert.equal(PR.rerendered, 1);
});

test("a first mention written as translation(English) does not become a doubled term", () => {
  const { PR, edits } = load(GL, { a: "策略（policy）是核心。之后只写策略。又见智能体（agent）与智能体。" });
  assert.equal(PR.termsToOriginal(false).n, 4);
  assert.equal(edits.a.zh, "policy 是核心。之后只写 policy。又见 agent 与 agent。");
});

test("longer renderings are swapped first so a short one cannot cut into them", () => {
  const { PR, edits } = load(GL, { a: "标准误差不是标准。" });
  PR.termsToOriginal(false);
  assert.equal(edits.a.zh, "standard error 不是 standard。");
});

test("math and code are left alone", () => {
  const { PR, edits } = load(GL, { a: "智能体 $智能体 + 1$ 与 `智能体()` 和\n```\nagent = 智能体\n```\n还有智能体。" });
  PR.termsToOriginal(false);
  assert.equal(edits.a.zh, "agent $智能体 + 1$ 与 `智能体()` 和\n```\nagent = 智能体\n```\n还有 agent。");
});

test("dry run counts without writing, and terms already in the original are skipped", () => {
  const gl = [...GL, { en: "token", zh: "token" }, { en: "x", zh: "" }];
  const { PR, commits } = load(gl, { a: "智能体和token。" });
  assert.equal(PR.termsToOriginal(true).n, 1);
  assert.equal(commits.length, 0);
  assert.equal(load([], { a: "智能体" }).PR.termsToOriginal(true).n, 0);
});

test("a paragraph I had already edited is rewritten from my version and undo restores it", () => {
  const { PR, edits } = load(GL, { a: "译者稿里的智能体。", b: "另一段的智能体。" }, { a: { zh: "我改过的智能体。" } });
  const r = PR.termsToOriginal(false);
  assert.equal(edits.a.zh, "我改过的 agent。");
  assert.equal(edits.b.zh, "另一段的 agent。");
  PR.undoTermsToOriginal(r.undo);
  assert.equal(edits.a.zh, "我改过的智能体。");  // back to my earlier edit
  assert.equal(edits.b, undefined);  // no edit before, so the translator's text is back
});

test("Latin renderings only match whole words", () => {
  const gl = [{ en: "agent", zh: "agente" }];
  const { PR, edits } = load(gl, { a: "El agente actúa; los agentes no. Un agente." });
  assert.equal(PR.termsToOriginal(false).n, 2);
  assert.equal(edits.a.zh, "El agent actúa; los agentes no. Un agent.");
});
