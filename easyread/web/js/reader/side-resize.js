/* 两侧面板宽度：左边原页拖右边缘，右边笔记 / 问 AI 拖左边缘；双击恢复默认，各自记在本机。
   两边同时开时合起来给正文至少留 420px，放不下就按比例收窄（不改记下的宽度）。
   把手单独挂在 body 上，面板内容重绘不会把它冲掉。 */
(function (PR) {
  "use strict";
  const body = document.body;
  const MIN = 320, TEXT_MIN = 420;  // 面板至少 320px，正文至少留 420px
  const right = { key: "easyread-panel-w", prop: "--side-w", cls: "side-open", grip: "right",
    panel: () => PR.$(PR.side === "notes" ? "#notespanel" : "#chatpanel"), width: (x) => window.innerWidth - x };
  const left = { key: "easyread-pv-w", prop: "--pv-w", cls: "pv-open", grip: "left",
    panel: () => PR.$("#pageview"), width: (x) => x };
  const sides = [left, right];
  sides.forEach(s => { s.saved = PR.ls.get(s.key, 0); });
  const shown = (s) => body.classList.contains(s.cls) ? s.panel().offsetWidth : 0;

  /* 先按记下的（或默认的）宽度摆，挤到正文就一起收：每边保住 MIN，多出来的部分按比例让 */
  PR.fitPanels = function () {
    sides.forEach(s => s.saved ? body.style.setProperty(s.prop, s.saved + "px") : body.style.removeProperty(s.prop));
    // 窗口变窄：面板会盖住正文，只留右边那个
    if (PR.pagesOpen && PR.side && !window.matchMedia("(min-width: 1180px)").matches) return PR.togglePages(false);
    const widths = sides.map(shown), open = widths.filter(Boolean).length;
    const total = widths[0] + widths[1], room = window.innerWidth - TEXT_MIN, spare = total - open * MIN;
    if (total <= room || spare <= 0) return;  // 都已经是最窄了就不再收
    const k = Math.max(0, room - open * MIN) / spare;
    sides.forEach((s, i) => { if (widths[i]) body.style.setProperty(s.prop, Math.floor(MIN + Math.max(0, widths[i] - MIN) * k) + "px"); });
  };

  function relayout(s) {
    PR.reflow(() => {});
    if (s === left && PR.pagesOpen) PR.refreshPages();  // 原页按新宽度换合适清晰度的图
  }

  sides.forEach(s => {
    const grip = PR.el("div", { class: "panel-grip " + s.grip, title: PR.t("拖动调整面板宽度（双击恢复）") });
    body.appendChild(grip);
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      body.classList.add("resizing");
      const other = shown(s === left ? right : left);
      const clamp = (w) => Math.round(Math.max(MIN, Math.min(window.innerWidth - TEXT_MIN - other, w)));
      const move = (ev) => { s.saved = clamp(s.width(ev.clientX)); body.style.setProperty(s.prop, s.saved + "px"); };
      const up = () => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        body.classList.remove("resizing");
        PR.ls.set(s.key, s.saved);
        relayout(s);
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
    grip.addEventListener("dblclick", () => { s.saved = 0; PR.ls.set(s.key, 0); relayout(s); });
  });
  PR.fitPanels();
  /* 窗口变窄时别让面板把正文挤没；同步改，main.js 里防抖后的重排就用上新宽度 */
  window.addEventListener("resize", () => PR.fitPanels());
})(window.PR);
