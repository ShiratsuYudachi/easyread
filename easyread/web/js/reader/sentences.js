/* 句子对齐：paper.json 的段落和列表项可以带 sents（[[英文句尾, 译文句尾], …]，按 JS 字符串位置，最后一项是两边总长）。
   有就把原文和译文都切成一句一个 <span class="snt" data-s="i">，两边同号的句子互相对应；
   没有（旧论文、模型没对上）、或者译文被我改过（“我的修改”），就按整段对应。
   标注同步：一边有划线或笔记，另一边对应的句子（没有句子对应时是整段）标一道虚线或段边色条，点它和点划线一样。 */
(function (PR) {
  "use strict";
  const S = PR.state;

  function objOf(key) {
    const [id, field] = String(key).split("#");
    const b = PR.blockById[id];
    if (!b) return null;
    if (b.type === "para" && field == null) return b;
    if (b.type === "list" && /^\d+$/.test(field || "")) return (Array.isArray(b.items) ? b.items : [])[+field] || null;
    return null;
  }

  /* 这处的句子对齐还对得上文字就返回 sents，否则 null */
  PR.alignOf = function (key) {
    const o = objOf(key);
    const s = o && o.sents;
    if (!Array.isArray(s) || s.length < 2) return null;
    const en = o.en || "", zh = o.zh || "", last = s[s.length - 1];
    if (!Array.isArray(last) || last[0] !== en.length || last[1] !== zh.length) return null;
    for (let i = 0; i < s.length; i++) {
      const prev = i ? s[i - 1] : [0, 0];
      if (!Array.isArray(s[i]) || !(s[i][0] > prev[0]) || !(s[i][1] > prev[1])) return null;
    }
    return s;
  };

  const balanced = (t) => (t.split("**").length % 2 === 1) && ((t.match(/(?<!\\)\$/g) || []).length % 2 === 0);

  /* 正文 HTML：对得上就一句一个 span，否则和原来一样整段 PR.md。side：en 原文 / zh 译文 */
  PR.sentMd = function (key, side, text) {
    const md = (value) => PR.md(value, PR.footnoteOptions ? PR.footnoteOptions(key) : {});
    const s = PR.alignOf(key), o = objOf(key);
    if (!s || !o || (side === "zh" && PR.editOf(key)) || text !== (side === "en" ? o.en : o.zh)) return md(text);
    const col = side === "en" ? 0 : 1;
    const parts = [];
    let prev = 0;
    for (const row of s) { parts.push(text.slice(prev, row[col])); prev = row[col]; }
    if (!parts.every(balanced)) return md(text);  // 句界切在 **粗体** 或公式中间：不切，整段显示
    return parts.map((p, i) => {
      const lead = p.match(/^\s*/)[0];
      return lead + '<span class="snt" data-s="' + i + '">' + md(p.slice(lead.length)) + "</span>";
    }).join("");
  };

  /* ---------- 原文 / 译文两个元素互相找 ---------- */
  const isEnEl = (el) => el.classList.contains("en") || el.classList.contains("en-main");
  PR.isEnEl = isEnEl;
  /* 原文元素对应的 .zh[data-key]（同一层的兄弟；只读原文没译的块，.zh 自己就是原文） */
  PR.zhOfEl = function (el) {
    if (el.classList.contains("zh")) return el;
    return Array.from(el.parentElement ? el.parentElement.children : []).find((n) => n.classList.contains("zh") && n.dataset.key) || null;
  };
  PR.enOfZh = function (zh) {
    if (!zh || zh.classList.contains("en-main")) return null;
    return Array.from(zh.parentElement ? zh.parentElement.children : []).find((n) => n.classList.contains("en")) || null;
  };
  /* 一条标注挂在哪个元素上：side 为 en 找原文，其余（旧标注没有 side）找译文 */
  PR.noteEl = function (zh, side) {
    if (!zh) return null;
    if (side !== "en" || zh.classList.contains("en-main")) return zh;
    return PR.enOfZh(zh);
  };
  const partner = (el) => (isEnEl(el) && !el.classList.contains("en-main") ? PR.zhOfEl(el) : el.classList.contains("zh") && !el.classList.contains("en-main") ? PR.enOfZh(el) : null);

  /* ---------- 标注同步到另一边 ---------- */
  const MIR = ["mir", "mir-para", "c-yellow", "c-green", "c-blue", "c-pink", "mir-q"];
  PR.applyMirrors = function (scope) {
    scope = scope || PR.$("#paper");
    if (!scope) return;
    PR.$$("[data-mirror]", scope).forEach((el) => { el.classList.remove(...MIR); el.removeAttribute("data-mirror"); el.removeAttribute("title"); });
    const byNote = {};  // 一次取出所有划线按笔记分组，不必每条笔记查一遍全文
    PR.$$("mark.hl[data-note]", scope).forEach((m) => (byNote[m.dataset.note] = byNote[m.dataset.note] || []).push(m));
    for (const n of PR.myNotes()) {
      if (!n.quote || !byNote[n.id]) continue;
      const bySrc = new Map();  // 跨段的划线每段各自同步到对应的那段
      byNote[n.id].forEach((m) => { const src = m.closest(".zh, .en"); if (src) bySrc.set(src, (bySrc.get(src) || []).concat(m)); });
      for (const [src, marks] of bySrc) {
        const other = partner(src);
        if (!other) continue;
        const idx = new Set(marks.map((m) => m.closest(".snt")).filter(Boolean).map((sp) => sp.dataset.s));
        const spans = idx.size ? PR.$$(":scope .snt", other).filter((sp) => idx.has(sp.dataset.s)) : [];
        const targets = spans.length ? spans : [other];
        const cls = [spans.length ? "mir" : "mir-para", "c-" + (n.color || "yellow")].concat(n.kind === "question" ? ["mir-q"] : []);
        const tip = isEnEl(src) ? PR.t("对应原文里的标注") : PR.t("对应译文里的标注");
        // 同一处有几条标注时留第一条（按时间排在前面的），颜色不会叠在一起
        targets.filter((t) => !t.dataset.mirror).forEach((t) => { t.classList.add(...cls); t.dataset.mirror = n.id; t.title = tip; });
      }
    }
  };

  /* 点同步标记：和点划线一样（划线弹改色菜单，笔记和问题打开编辑）。
     整段的同步标记只有段边那道色条能点，点段落其余地方照常（出操作条、双击改译文）；正在改这段时不拦 */
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("[data-mirror]");
    if (!el || e.target.closest("mark.hl, a, button, textarea") || el.querySelector("textarea") || getSelection().toString()) return;
    if (el.classList.contains("mir-para")) {
      const r = el.getBoundingClientRect();
      if (e.clientX > r.left + 14) return;
    }
    const n = (S.reader.notes || {})[el.dataset.mirror];
    if (!n || n.deleted) return;
    e.stopPropagation();
    PR.noteMarkClick(el, n);
  }, true);

  /* 双语对照时指着一句，另一边对应的那句也淡淡标出来 */
  let lit = [];
  document.addEventListener("mouseover", (e) => {
    const sp = e.target.closest && e.target.closest("#paper .snt");
    const host = sp && sp.closest(".zh, .en");
    const other = host && partner(host);
    const pair = other && other.offsetParent ? PR.$$(":scope .snt", other).find((x) => x.dataset.s === sp.dataset.s) : null;
    const next = pair ? [sp, pair] : [];
    if (next[0] === lit[0]) return;
    lit.forEach((x) => x.classList.remove("pair"));
    lit = next;
    lit.forEach((x) => x.classList.add("pair"));
  });

  /* ---------- 当前句：原页面板只框这一句 ----------
     点正文里的一句（原文或译文都行），原页上就只框这一句；这一句没有逐句定位（旧论文、没对上），仍框整段。
     layout.json 的 sents 按句存了原页区域：{ 键: [每句的 [{page, box}] 或 null] }，键和阅读页一致。 */
  let sent = null;  // { id: 块 id, key: 这段文字的键（段落是块 id，列表项是“块id#序号”）, i: 第几句 }
  PR.currentSentence = (id) => (sent && (id == null || sent.id === id) ? sent : null);

  /* 点到的元素在哪一句上：不在对得上的句子里就是 null */
  PR.sentenceOf = function (target) {
    const sp = target.closest && target.closest("#paper .snt");
    const host = sp && sp.closest(".zh, .en");
    const zh = host && PR.zhOfEl(host);
    const blk = sp && sp.closest(".blk");
    return zh && zh.dataset.key && blk ? { id: blk.dataset.id, key: zh.dataset.key, i: +sp.dataset.s } : null;
  };

  /* 一句在原页上的区域 [{page, box}]。句数和现在的对齐对不上（layout 还是旧的）、这一句没定位上，都是 null */
  PR.sentenceRegions = function (s) {
    const rows = s && ((S.layout[s.id] || {}).sents || {})[s.key];
    const align = rows && PR.alignOf(s.key);
    return align && rows.length === align.length && rows[s.i] && rows[s.i].length ? rows[s.i] : null;
  };

  /* 原页上点在哪一句里（点中了几句重叠的区域取第一句） */
  PR.sentenceAtPoint = function (id, page, x, y) {
    const sents = (S.layout[id] || {}).sents || {};
    for (const key in sents) {
      for (let i = 0; i < sents[key].length; i++) {
        const regions = PR.sentenceRegions({ id, key, i }) || [];
        if (regions.some((r) => r.page === page && x >= r.box[0] - 0.004 && x <= r.box[2] + 0.004 && y >= r.box[1] - 0.003 && y <= r.box[3] + 0.003)) return { id, key, i };
      }
    }
    return null;
  };

  /* 正文里当前句的标记：原文和译文两边同号的句子都标 */
  function markSentence() {
    PR.$$("#paper .snt.sel").forEach((x) => x.classList.remove("sel"));
    const blk = sent && document.getElementById("b-" + sent.id);
    if (!blk) return;
    PR.$$('.zh[data-key="' + CSS.escape(sent.key) + '"]', blk).forEach((zh) => {
      [zh, PR.enOfZh(zh)].forEach((el) => el && PR.$$(":scope .snt", el).forEach((x) => { if (+x.dataset.s === sent.i) x.classList.add("sel"); }));
    });
  }
  /* 当前句在正文里看得见的那一处（译文和原文都显示时取靠前的），好滚到它 */
  PR.sentenceSpan = () => PR.$$("#paper .snt.sel").find((x) => x.offsetParent) || null;

  /* 换当前句（null 是清掉）。返回有没有变，调用方据此决定要不要重画原页 */
  PR.setSentence = function (next) {
    const same = next ? !!sent && sent.id === next.id && sent.key === next.key && sent.i === next.i : !sent;
    sent = next || null;
    markSentence();
    return !same;
  };
  PR.on("block-rendered", (id) => { if (sent && sent.id === id) markSentence(); });  // 段落重画后补回标记
  PR.on("rendered", markSentence);
})(window.PR);
