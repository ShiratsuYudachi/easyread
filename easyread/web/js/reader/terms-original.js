/* 一键所有术语显示原文：术语表里每条中文译法在正文里换回英文术语，写成我的修改（译者稿不动，公式和代码里不换）。
   和“替换”按钮同一套机制：随时可以在段落右键“恢复译者稿”；刚做完还可以从提示里撤销。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const CJK = /[぀-ヿ㐀-鿿가-힯]/;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (s, latin) => (latin ? "(?<![\\p{L}\\p{N}_])" + esc(s) + "(?![\\p{L}\\p{N}_])" : esc(s));

  /* 术语表里能换的条目：译法去掉括注（“策略（policy）”只取“策略”），和英文一样的不换。长的先换，免得“标准误”抢在“标准误差”前面 */
  function rulesOf() {
    const out = [];
    for (const g of (S.paper && S.paper.glossary) || []) {
      const en = String((g && g.en) || "").trim();
      const bare = String((g && g.zh) || "").replace(/[（(][^）)]*[）)]/g, "").trim();
      if (!en || !bare || bare.toLowerCase() === en.toLowerCase()) continue;
      out.push({ en, bare, latin: !CJK.test(bare) });
    }
    return out.sort((a, b) => b.bare.length - a.bare.length);
  }

  /* 一段文字里换完所有术语，返回 [新文字, 换了几处]。中文紧挨着英文时补一个空格（“每个 agent 学习”） */
  function swapTerms(text, rules) {
    let hits = 0;
    const put = (en) => (m, off, str) => {
      hits++;
      const before = str[off - 1], after = str[off + m.length];
      return (before && CJK.test(before) ? " " : "") + en + (after && CJK.test(after) ? " " : "");
    };
    for (const r of rules) {
      // 首次出现写成“译法（English）”：整个换成英文，不留“agent（agent）”
      text = text.replace(new RegExp(word(r.bare, r.latin) + "\\s*[（(]\\s*" + esc(r.en) + "\\s*[)）]", "giu"), put(r.en));  // i18n-ok 匹配译文里的括注，不是界面文字
      text = text.replace(new RegExp(word(r.bare, r.latin), "gu"), put(r.en));
    }
    return [text, hits];
  }

  /* dryRun 只数不改。返回 { n: 换了几处, undo: 每段原来的状态 } */
  PR.termsToOriginal = function (dryRun) {
    const rules = rulesOf();
    const undo = [];
    let n = 0;
    if (!rules.length) return { n, undo };
    for (const b of S.paper.blocks || []) {
      for (const key of PR.blockKeys(b)) {
        const cur = PR.textFor(key);
        let hits = 0;
        const next = cur.split(/(```[\s\S]*?```|`[^`\n]*`|\$[^$]*\$)/).map((part, i) => {  // 代码和公式在奇数位，不碰
          if (i % 2) return part;
          const [text, h] = swapTerms(part, rules);
          hits += h;
          return text;
        }).join("");
        if (!hits || next === cur) continue;
        n += hits;
        if (dryRun) continue;
        const prev = PR.editOf(key);
        undo.push({ key, prev: prev ? prev.zh : null });
        PR.commit({ op: "edit", block: key, zh: next, base: PR.hashText(PR.agentText(key)) });
      }
    }
    if (!dryRun && n) PR.rerenderKeepingPlace();
    return { n, undo };
  };

  PR.undoTermsToOriginal = function (undo) {
    for (const { key, prev } of undo || []) {
      PR.commit(prev == null ? { op: "edit", block: key, zh: null } : { op: "edit", block: key, zh: prev, base: PR.hashText(PR.agentText(key)) });
    }
    if (undo && undo.length) PR.rerenderKeepingPlace();
  };
})(window.PR);
