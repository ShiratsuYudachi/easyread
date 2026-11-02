const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

/* 重译后“译者稿有更新”：全篇一起换成译者稿或一起保留我的，并能撤销 */
function load(texts, edits) {
  const blocks = Object.keys(texts).map((id) => ({ id, type: "para" }));
  const hash = (s) => "h:" + s;
  const PR = {
    state: { paper: { blocks } },
    blockKeys: (b) => [b.id],
    agentText: (key) => texts[key],
    editOf: (key) => edits[key] || null,
    textFor: (key) => (edits[key] ? edits[key].zh : texts[key]),
    isStale: (key) => !!(edits[key] && edits[key].base && edits[key].base !== hash(texts[key])),
    hashText: hash,
    commit: (op) => { if (op.zh == null) delete edits[op.block]; else edits[op.block] = { zh: op.zh, base: op.base }; },
    rerenderKeepingPlace() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/editor.js"), "utf8"), {
    window: { PR }, document: { addEventListener() {} },
  });
  return PR;
}

// a、b 是重译后译者稿变了的段；c 我改过但译者稿没变；d 没改过
const texts = { a: "新译 A", b: "新译 B", c: "原译 C", d: "原译 D" };
const fresh = () => ({ a: { zh: "我的 A", base: "h:旧译 A" }, b: { zh: "我的 B", base: "h:旧译 B" }, c: { zh: "我的 C", base: "h:原译 C" } });

test("all stale paragraphs switch to the translator's version; other edits stay", () => {
  const edits = fresh(), PR = load(texts, edits);
  const undo = PR.resolveStale("agent");
  assert.deepEqual(Array.from(undo, (u) => u.key), ["a", "b"]);  // arrays made inside the vm have another prototype
  assert.deepEqual(Object.keys(edits), ["c"]);
  PR.undoResolveStale(undo);
  assert.deepEqual(edits, fresh());
});

test("keeping mine for all clears the update marks without changing my text", () => {
  const edits = fresh(), PR = load(texts, edits);
  const undo = PR.resolveStale("mine");
  assert.deepEqual([edits.a.zh, edits.b.zh, edits.c.zh], ["我的 A", "我的 B", "我的 C"]);
  assert.ok(!PR.isStale("a") && !PR.isStale("b"));
  PR.undoResolveStale(undo);
  assert.ok(PR.isStale("a") && PR.isStale("b"));
});
