/* IWC Team dashboard. Plain JavaScript, no build step, no libraries.
 * Talks to Supabase's REST and Auth APIs directly with fetch (setup.sql makes the tables and functions). */
(() => {
  "use strict";

  const CFG = window.IWC_TEAM || {};
  const BASE = String(CFG.supabaseUrl || "").replace(/\/+$/, "");
  const KEY = CFG.supabaseKey || "";
  const SESSION_KEY = "iwc-team-session";
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /* ------------------------------------------------------------------ backend: Supabase over fetch */

  function realBackend() {
    let session = null;
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { session = null; }
    let refreshing = null;

    const save = (s) => {
      session = s;
      try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
    };

    async function token(grant, body) {
      const res = await fetch(`${BASE}/auth/v1/token?grant_type=${grant}`, {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error_description || data.msg || "Sign-in failed"), { status: res.status });
      const expiresAt = data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
      save({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt });
    }

    async function fresh(force = false) {
      if (!session) throw Object.assign(new Error("Signed out"), { status: 401 });
      if (!force && session.expires_at * 1000 - Date.now() > 60_000) return;
      refreshing ||= token("refresh_token", { refresh_token: session.refresh_token })
        .catch((e) => { save(null); throw Object.assign(e, { status: 401 }); })
        .finally(() => { refreshing = null; });
      await refreshing;
    }

    async function call(path, { method = "GET", body, prefer } = {}, retried = false) {
      await fresh();
      const headers = { apikey: KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
      if (prefer) headers.Prefer = prefer;
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 401 && !retried) { await fresh(true); return call(path, { method, body, prefer }, true); }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { status: res.status });
      }
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    return {
      hasSession: () => !!session,
      signIn: (email, password) => token("password", { email, password }),
      async signOut() {
        const s = session;
        save(null);
        if (s) fetch(`${BASE}/auth/v1/logout`, { method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
      },
      me: () => call("/rest/v1/rpc/team_me", { method: "POST", body: {} }),
      members: () => call("/rest/v1/team_members?select=name,sort&order=sort.asc,name.asc"),
      tasks: () => call("/rest/v1/team_tasks?select=id,member,title,done,due_on,created_at,done_at&order=created_at.asc"),
      addTask: (t) => call("/rest/v1/team_tasks?select=id,member,title,done,due_on,created_at,done_at", { method: "POST", body: t, prefer: "return=representation" }).then((r) => r[0]),
      updateTask: (id, patch) => call(`/rest/v1/team_tasks?id=eq.${encodeURIComponent(id)}&select=id,member,title,done,due_on,created_at,done_at`, { method: "PATCH", body: patch, prefer: "return=representation" }).then((r) => r[0]),
      deleteTask: (id) => call(`/rest/v1/team_tasks?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" }),
      analytics: (days) => call("/rest/v1/rpc/team_analytics", { method: "POST", body: { p_days: days, p_tz: TZ } }),
    };
  }

  /* ------------------------------------------------------------------ state */

  let api;
  const state = {
    me: null,
    members: [],
    tasks: [],
    openDone: new Set(),
    days: 30,
    analytics: null,
    analyticsAt: 0,
    editing: false,
  };

  /* ------------------------------------------------------------------ helpers */

  const today = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const daysFromToday = (s) => Math.round((parseDay(s) - today()) / 86_400_000);
  const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  function dueLabel(s) {
    if (!s) return { text: "Date", cls: "empty" };
    const n = daysFromToday(s);
    if (n < 0) return { text: `${-n}d late`, cls: "late" };
    if (n === 0) return { text: "Today", cls: "today" };
    if (n === 1) return { text: "Tomorrow", cls: "" };
    if (n < 7) return { text: parseDay(s).toLocaleDateString("en-US", { weekday: "short" }), cls: "" };
    return { text: fmtShort(parseDay(s)), cls: "" };
  }

  const money = (cents, exact = false) => {
    const v = (cents || 0) / 100;
    const whole = !exact && Math.abs(v) >= 1000;
    return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  };
  const int = (n) => (n || 0).toLocaleString("en-US");
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const plural = (n, one, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

  let toastTimer;
  function toast(msg, action) {
    const el = $("#toast");
    el.innerHTML = esc(msg) + (action ? ` <button type="button" class="link" style="color:inherit;text-decoration:underline;pointer-events:auto;margin-left:8px">${esc(action.label)}</button>` : "");
    if (action) el.querySelector("button").onclick = () => { el.classList.remove("show"); action.run(); };
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), action ? 5000 : 3000);
  }
  const failed = (e) => { console.error(e); if (e.status === 401) return showSignIn("Your session ended. Sign in again."); toast("Couldn't save. Check the connection and try again."); };

  /* ------------------------------------------------------------------ sign in */

  function showSignIn(msg = "") {
    $("#app").hidden = true;
    $("#signin").hidden = false;
    $("#signin-error").textContent = msg;
    $("#signin-form [name=email]").focus();
  }

  $("#signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector("button");
    btn.disabled = true;
    $("#signin-error").textContent = "";
    try {
      await api.signIn(f.email.value.trim(), f.password.value);
      f.password.value = "";
      await start();
    } catch (err) {
      $("#signin-error").textContent = err.status === 400 ? "Wrong email or password." : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("#signout").addEventListener("click", async () => { await api.signOut(); showSignIn(); });

  async function start() {
    let me;
    try { me = await api.me(); } catch (e) { return showSignIn(e.status === 401 ? "" : e.message); }
    if (!me) { await api.signOut(); return showSignIn("This account isn't on the team list."); }
    state.me = me;
    $("#signin").hidden = true;
    $("#app").hidden = false;
    $("#me").textContent = me;
    $("#today").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    await Promise.all([loadTasks(), loadAnalytics()]);
  }

  /* ------------------------------------------------------------------ tasks */

  async function loadTasks() {
    try {
      const [members, tasks] = await Promise.all([api.members(), api.tasks()]);
      state.members = members.map((m) => m.name);
      state.tasks = tasks;
      renderBoard();
    } catch (e) {
      if (e.status === 401) return showSignIn("Your session ended. Sign in again.");
      $("#board").innerHTML = `<p class="muted">Couldn't load tasks: ${esc(e.message)}</p>`;
    }
  }

  function sortOpen(a, b) {
    if (a.due_on && b.due_on && a.due_on !== b.due_on) return a.due_on < b.due_on ? -1 : 1;
    if (!!a.due_on !== !!b.due_on) return a.due_on ? -1 : 1;
    return a.created_at < b.created_at ? -1 : 1;
  }

  function taskHTML(t) {
    const due = dueLabel(t.due_on);
    return `<li class="task${t.done ? " done" : ""}" data-id="${esc(t.id)}">
      <button class="check" type="button" data-act="toggle" aria-label="${t.done ? "Mark as not done" : "Mark as done"}"></button>
      <span class="title" data-act="edit">${esc(t.title)}</span>
      <span style="position:relative">
        <button class="due ${due.cls}" type="button" data-act="date" aria-label="Due date">${esc(due.text)}</button>
        <input class="date-in" type="date" value="${esc(t.due_on || "")}" tabindex="-1" aria-hidden="true"
          style="position:absolute;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none">
      </span>
      <button class="del" type="button" data-act="delete" aria-label="Delete task">×</button>
    </li>`;
  }

  function renderBoard() {
    // keep what someone is typing in an "Add a task" box across re-renders
    const active = document.activeElement;
    const typing = active && active.matches(".add input") ? { member: active.dataset.member, value: active.value, pos: active.selectionStart } : null;
    const drafts = {};
    document.querySelectorAll(".add input").forEach((i) => { if (i.value) drafts[i.dataset.member] = i.value; });

    $("#board").innerHTML = state.members.map((m) => {
      const mine = state.tasks.filter((t) => t.member === m);
      const open = mine.filter((t) => !t.done).sort(sortOpen);
      const done = mine.filter((t) => t.done).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || ""));
      const late = open.filter((t) => t.due_on && daysFromToday(t.due_on) < 0).length;
      const showDone = state.openDone.has(m);
      return `<article class="col" data-member="${esc(m)}">
        <div class="col-head">
          <h3>${esc(m)}${m === state.me ? '<span class="you">you</span>' : ""}</h3>
          <span class="count num${late ? " late" : ""}">${open.length ? `${open.length} open${late ? ` · ${late} late` : ""}` : ""}</span>
        </div>
        ${open.length ? `<ul class="tasks">${open.map(taskHTML).join("")}</ul>` : `<p class="empty-note">Nothing open.</p>`}
        <form class="add" data-member="${esc(m)}"><input data-member="${esc(m)}" placeholder="Add a task" maxlength="300" aria-label="Add a task for ${esc(m)}"></form>
        ${showDone && done.length ? `<ul class="tasks">${done.slice(0, 30).map(taskHTML).join("")}</ul>` : ""}
        ${done.length ? `<button class="done-toggle" type="button" data-act="done-toggle">${showDone ? "Hide done" : `Done · ${done.length}`}</button>` : ""}
      </article>`;
    }).join("");

    document.querySelectorAll(".add input").forEach((i) => { if (drafts[i.dataset.member]) i.value = drafts[i.dataset.member]; });
    if (state.analytics) renderAnalytics();
    if (typing) {
      const el = document.querySelector(`.add input[data-member="${CSS.escape(typing.member)}"]`);
      if (el) { el.value = typing.value; el.focus(); el.setSelectionRange(typing.pos, typing.pos); }
    }
  }

  const findTask = (id) => state.tasks.find((t) => t.id === id);

  // Optimistic change: show it at once, roll back if the database refuses.
  async function changeTask(id, patch) {
    const t = findTask(id);
    if (!t) return;
    const before = { ...t };
    Object.assign(t, patch, "done" in patch ? { done_at: patch.done ? new Date().toISOString() : null } : {});
    renderBoard();
    try {
      const saved = await api.updateTask(id, patch);
      if (saved) Object.assign(t, saved);
    } catch (e) {
      Object.assign(t, before);
      renderBoard();
      failed(e);
    }
  }

  async function addTask(member, title, extra = {}) {
    const temp = { id: `tmp-${Date.now()}-${Math.random()}`, member, title, done: false, due_on: null, created_at: new Date().toISOString(), done_at: null, ...extra };
    state.tasks.push(temp);
    renderBoard();
    try {
      const saved = await api.addTask({ member, title, due_on: temp.due_on, done: temp.done });
      Object.assign(temp, saved);
      renderBoard();
    } catch (e) {
      state.tasks = state.tasks.filter((t) => t !== temp);
      renderBoard();
      failed(e);
    }
  }

  async function deleteTask(id) {
    const t = findTask(id);
    if (!t) return;
    state.tasks = state.tasks.filter((x) => x !== t);
    renderBoard();
    try {
      await api.deleteTask(id);
      toast("Task deleted", { label: "Undo", run: () => addTask(t.member, t.title, { due_on: t.due_on, done: t.done }) });
    } catch (e) {
      state.tasks.push(t);
      renderBoard();
      failed(e);
    }
  }

  function startEdit(span) {
    const id = span.closest(".task").dataset.id;
    const t = findTask(id);
    if (!t || id.startsWith("tmp-")) return;
    state.editing = true;
    span.contentEditable = "true";
    span.focus();
    const r = document.createRange();
    r.selectNodeContents(span);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      state.editing = false;
      span.contentEditable = "false";
      const title = span.textContent.replace(/\s+/g, " ").trim().slice(0, 300);
      if (save && title && title !== t.title) changeTask(id, { title });
      else span.textContent = t.title;
    };
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); span.blur(); }
      if (e.key === "Escape") { finish(false); span.blur(); }
    });
    span.addEventListener("blur", () => finish(true), { once: true });
  }

  $("#board").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const li = el.closest(".task");
    const id = li && li.dataset.id;
    if (id && id.startsWith("tmp-")) return; // still saving
    if (act === "toggle") changeTask(id, { done: !findTask(id).done });
    else if (act === "delete") deleteTask(id);
    else if (act === "edit" && el.contentEditable !== "true") startEdit(el);
    else if (act === "date") {
      const input = li.querySelector(".date-in");
      try { input.showPicker(); } catch { input.style.pointerEvents = "auto"; input.focus(); input.click(); }
    } else if (act === "done-toggle") {
      const m = el.closest(".col").dataset.member;
      state.openDone.has(m) ? state.openDone.delete(m) : state.openDone.add(m);
      renderBoard();
    }
  });

  $("#board").addEventListener("change", (e) => {
    if (!e.target.matches(".date-in")) return;
    const id = e.target.closest(".task").dataset.id;
    changeTask(id, { due_on: e.target.value || null });
  });

  $("#board").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const title = input.value.replace(/\s+/g, " ").trim();
    if (!title) return;
    input.value = "";
    addTask(e.target.dataset.member, title.slice(0, 300));
  });

  /* ------------------------------------------------------------------ analytics */

  const TYPE = {
    clothing: { label: "Clothing", color: "var(--t-clothing)" },
    food: { label: "Food", color: "var(--t-food)" },
    home: { label: "Home & gifts", color: "var(--t-home)" },
    other: { label: "Other", color: "var(--t-other)" },
  };
  const STATUS = {
    confirmed: "Confirmed", collecting: "Collecting", packed: "Packed", in_transit: "In transit", arrived: "Arrived in the US", shipped: "Shipped to customer",
  };

  async function loadAnalytics() {
    const days = state.days;
    try {
      const data = await api.analytics(days);
      if (days !== state.days) return; // the period changed while this was loading
      state.analytics = data;
      state.analyticsAt = Date.now();
      renderAnalytics();
    } catch (e) {
      if (e.status === 401) return showSignIn("Your session ended. Sign in again.");
      $("#analytics").innerHTML = `<p class="muted">Couldn't load analytics: ${esc(e.message)}</p>`;
    }
  }

  $("#period").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-days]");
    if (!b) return;
    state.days = Number(b.dataset.days);
    document.querySelectorAll("#period button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#analytics").style.opacity = ".5";
    loadAnalytics().finally(() => { $("#analytics").style.opacity = ""; });
  });

  function change(now, before) {
    if (!before) return now ? null : 0;
    return Math.round(((now - before) / before) * 100);
  }

  function deltaHTML(now, before, days) {
    const c = change(now, before);
    if (c === null) return `<span>none in the ${days} days before</span>`;
    if (c === 0) return `<span>same as the ${days} days before</span>`;
    return `<span class="${c > 0 ? "up" : "down"}">${c > 0 ? "↑" : "↓"} ${Math.abs(c)}%</span> vs the ${days} days before`;
  }

  function summaryHTML(a) {
    const n = a.now, b = a.before, days = a.days;
    const out = [];
    if (!n.orders) {
      out.push(`No paid orders in the last ${days} days.`);
    } else {
      let s = `${money(n.sales_cents)} in sales from ${plural(n.orders, "order")} in the last ${days} days`;
      const c = change(n.sales_cents, b.sales_cents);
      if (c === null) s += ", the first in this window";
      else if (c !== 0) s += `, ${c > 0 ? "up" : "down"} ${Math.abs(c)}% on the ${days} days before`;
      out.push(`${s}.`);
      const lead = a.top_regions[0];
      const type = a.by_type[0];
      const parts = [];
      if (lead && a.top_regions.length > 1) parts.push(`${esc(lead.name)} sells most (${pct(lead.sales_cents, n.sales_cents)}% of sales)`);
      if (type && a.by_type.length > 1) parts.push(`${TYPE[type.type]?.label || esc(type.type)} is ${pct(type.sales_cents, n.sales_cents)}% of sales`);
      if (parts.length) out.push(`${parts.join(", and ").replace(/^./, (c) => c.toUpperCase())}.`);
    }
    const warn = [];
    if (a.late) warn.push(`${plural(a.late, "order")} past ${a.late === 1 ? "its" : "their"} delivery date`);
    const overdue = teamStats(a.from).reduce((s, t) => s + t.overdue, 0);
    if (overdue) warn.push(`${plural(overdue, "overdue task")}`);
    if (warn.length) out.push(`<span class="warn">Needs attention: ${warn.join(" and ")}.</span>`);
    return out.join(" ");
  }

  function kpiHTML(label, value, delta) {
    return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="delta">${delta}</div></div>`;
  }

  function rowsHTML(items, empty, cls = "") {
    return items.length ? `<ul class="rows ${cls}">${items.join("")}</ul>` : `<p class="none">${empty}</p>`;
  }

  // Task numbers come from the board itself, so they follow every tick at once.
  function teamStats(fromDay) {
    const from = parseDay(fromDay).getTime();
    return state.members.map((m) => {
      const mine = state.tasks.filter((t) => t.member === m);
      return {
        member: m,
        open: mine.filter((t) => !t.done).length,
        overdue: mine.filter((t) => !t.done && t.due_on && daysFromToday(t.due_on) < 0).length,
        done: mine.filter((t) => t.done && t.done_at && new Date(t.done_at).getTime() >= from).length,
      };
    });
  }

  function renderAnalytics() {
    const a = state.analytics;
    const n = a.now, b = a.before, d = a.days;
    const avg = n.orders ? n.sales_cents / n.orders : 0;
    const avgBefore = b.orders ? b.sales_cents / b.orders : 0;
    const openOrders = a.pipeline.reduce((s, p) => s + p.orders, 0);
    const topSales = a.top_regions[0]?.sales_cents || 0;
    const typeTotal = a.by_type.reduce((s, t) => s + t.sales_cents, 0);
    const cat = a.catalogue;
    const team = teamStats(a.from);

    $("#analytics").innerHTML = `
      <p class="summary">${summaryHTML(a)}</p>
      <div class="kpis">
        ${kpiHTML("Sales", money(n.sales_cents), deltaHTML(n.sales_cents, b.sales_cents, d))}
        ${kpiHTML("Orders", int(n.orders), deltaHTML(n.orders, b.orders, d))}
        ${kpiHTML("Average order", money(avg, true), deltaHTML(avg, avgBefore, d))}
        ${kpiHTML("Customers", int(n.customers), `${int(n.new_customers)} new · ${int(Math.max(n.customers - n.new_customers, 0))} returning`)}
      </div>

      <div class="card chart-card">
        <div class="card-h"><h3>Sales per day</h3><span>${fmtShort(parseDay(a.from))} – ${fmtShort(parseDay(a.to))}</span></div>
        <div class="chart" id="chart"></div>
      </div>

      <div class="grid3">
        <div class="card">
          <div class="card-h"><h3>Open orders</h3><span class="num">${int(openOrders)}</span></div>
          ${rowsHTML([
            ...a.pipeline.map((p) => `<li><span class="name">${esc(STATUS[p.status] || p.status)}</span><span class="v">${int(p.orders)}</span></li>`),
            ...(a.late ? [`<li class="late"><span class="name">Past delivery date</span><span class="v">${int(a.late)}</span></li>`] : []),
          ], "No open orders.")}
        </div>
        <div class="card">
          <div class="card-h"><h3>Top states</h3><span>by sales</span></div>
          ${rowsHTML(a.top_regions.map((r) => `<li><span class="name">${esc(r.name)}</span><span class="v">${money(r.sales_cents)}</span><span class="meter"><i style="width:${pct(r.sales_cents, topSales)}%"></i></span></li>`), "No sales yet.", "metered")}
        </div>
        <div class="card">
          <div class="card-h"><h3>Top products</h3><span>by pieces</span></div>
          ${rowsHTML(a.top_products.map((p) => `<li><span class="name" title="${esc(p.name)}">${esc(p.name)}</span><span class="v">${int(p.pieces)}</span></li>`), "No sales yet.")}
        </div>
      </div>

      <div class="grid3">
        <div class="card">
          <div class="card-h"><h3>Sales by type</h3><span>${money(typeTotal)}</span></div>
          ${typeTotal ? `<div class="stack" role="img" aria-label="${esc(a.by_type.map((t) => `${TYPE[t.type]?.label || t.type} ${pct(t.sales_cents, typeTotal)}%`).join(", "))}">
            ${a.by_type.map((t) => `<i style="flex:${t.sales_cents};background:${(TYPE[t.type] || TYPE.other).color}"></i>`).join("")}
          </div>` : ""}
          ${rowsHTML(a.by_type.map((t) => `<li><span class="name"><span class="dot" style="background:${(TYPE[t.type] || TYPE.other).color}"></span>${esc(TYPE[t.type]?.label || t.type)}</span><span class="v">${pct(t.sales_cents, typeTotal)}% · ${money(t.sales_cents)}</span></li>`), "No sales yet.")}
        </div>
        <div class="card">
          <div class="card-h"><h3>Catalogue</h3><span class="num">${int(cat.live)} live</span></div>
          ${rowsHTML([
            ...["clothing", "food", "home"].map((k) => `<li><span class="name"><span class="dot" style="background:${TYPE[k].color}"></span>${TYPE[k].label}</span><span class="v">${int(cat.live_by_type[k])}</span></li>`),
            `<li><span class="name">Published in these ${d} days</span><span class="v">${int(cat.listed_in_period)}</span></li>`,
            `<li><span class="name">Drafts</span><span class="v">${int(cat.drafts)}</span></li>`,
          ], "")}
        </div>
        <div class="card">
          <div class="card-h"><h3>Team</h3><span>done · open · late</span></div>
          ${rowsHTML(team.map((t) => `<li class="team-row"><span class="name">${esc(t.member)}</span><span class="v">${int(t.done)}</span><span class="v">${int(t.open)}</span><span class="v" style="${t.overdue ? "color:var(--bad)" : ""}">${int(t.overdue)}</span></li>`), "")}
        </div>
      </div>

      <p class="foot">Sales are the goods' prices on paid orders (before shipping, tax and discounts), not counting cancelled or refunded ones. Days in ${esc(a.tz)}. Updated ${new Date(a.generated_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.</p>
    `;
    drawChart();
  }

  function niceMax(v) {
    if (v <= 0) return 100; // $1 when there are no sales, so the axis still reads
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function drawChart() {
    const box = $("#chart");
    const a = state.analytics;
    if (!box || !a) return;
    const data = a.daily;
    const W = Math.max(box.clientWidth, 280), H = 200, L = 52, R = 4, T = 8, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const max = niceMax(Math.max(...data.map((x) => x.sales_cents)));
    const band = pw / data.length;
    const gap = band > 8 ? 2 : band > 3 ? 1 : 0;
    const bw = Math.max(band - gap, 1);
    const rad = Math.min(4, bw / 2);
    const y = (v) => T + ph - (v / max) * ph;
    const yLab = (v) => money(v).replace(/\.00$/, "");

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales per day, ${esc(fmtShort(parseDay(a.from)))} to ${esc(fmtShort(parseDay(a.to)))}">`;
    for (const f of [0.5, 1]) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="ylab" x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end">${yLab(max * f)}</text>`;
    svg += `<text class="ylab" x="${L - 8}" y="${y(0) + 4}" text-anchor="end">$0</text>`;

    // x labels: every day for a week, otherwise the first, middle and last day
    const labelAt = data.length <= 7 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1];
    for (const i of labelAt) {
      const day = parseDay(data[i].day);
      const text = data.length <= 7 ? day.toLocaleDateString("en-US", { weekday: "short" }) : fmtShort(day);
      const x = L + band * i + band / 2;
      const anchor = data.length <= 7 ? "middle" : i === 0 ? "start" : i === data.length - 1 ? "end" : "middle";
      svg += `<text class="xlab" x="${anchor === "start" ? L + band * i : anchor === "end" ? L + band * (i + 1) : x}" y="${H - 6}" text-anchor="${anchor}">${text}</text>`;
    }

    data.forEach((p, i) => {
      const x = L + band * i + gap / 2;
      svg += `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ph}"/>`;
      if (p.sales_cents > 0) {
        const top = y(p.sales_cents), h = Math.max(y(0) - top, 2), r = Math.min(rad, h);
        svg += `<path class="bar" data-i="${i}" d="M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + bw - r} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + r} V${y(0)} Z"/>`;
      }
    });
    svg += `<line class="base" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/></svg>`;

    const table = `<table class="sr-only"><caption>Sales per day</caption><tr><th>Day</th><th>Sales</th><th>Orders</th></tr>${data.map((p) => `<tr><td>${p.day}</td><td>${money(p.sales_cents, true)}</td><td>${p.orders}</td></tr>`).join("")}</table>`;
    box.innerHTML = svg + `<div class="tip" id="tip"></div>` + table;

    const tip = $("#tip", box);
    const show = (i) => {
      const p = data[i];
      box.querySelectorAll(".bar.on").forEach((el) => el.classList.remove("on"));
      box.querySelector(`.bar[data-i="${i}"]`)?.classList.add("on");
      const day = parseDay(p.day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      tip.textContent = `${day} · ${money(p.sales_cents, true)} · ${plural(p.orders, "order")}`;
      const scale = box.clientWidth / W;
      const xPx = (L + band * i + band / 2) * scale;
      tip.style.left = `${Math.min(Math.max(xPx, 90), box.clientWidth - 90)}px`;
      tip.style.top = `${Math.min(y(p.sales_cents), y(0) - 2) * (box.querySelector("svg").clientHeight / H)}px`;
      tip.classList.add("show");
    };
    const hide = () => { tip.classList.remove("show"); box.querySelectorAll(".bar.on").forEach((el) => el.classList.remove("on")); };
    box.querySelectorAll(".hit").forEach((r) => {
      r.addEventListener("mouseenter", () => show(+r.dataset.i));
      r.addEventListener("touchstart", () => show(+r.dataset.i), { passive: true });
    });
    box.querySelector("svg").addEventListener("mouseleave", hide);
  }

  let resizeTimer;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 100); });

  /* ------------------------------------------------------------------ keep fresh while open */

  setInterval(() => {
    if (document.visibilityState === "visible" && !state.editing && state.me) loadTasks();
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.me) return;
    if (!state.editing) loadTasks();
    if (Date.now() - state.analyticsAt > 5 * 60_000) loadAnalytics();
  });

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    if (new URLSearchParams(location.search).has("demo")) {
      await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "demo.js"; s.onload = ok; s.onerror = no; document.head.append(s); });
      api = window.IWC_DEMO_BACKEND;
    } else {
      if (!BASE || !KEY || KEY.startsWith("PASTE_")) {
        document.body.innerHTML = `<main class="signin"><p class="muted" style="max-width:420px">Add the Supabase URL and anon key to <code>config.js</code> first (see README).</p></main>`;
        return;
      }
      api = realBackend();
    }
    if (api.hasSession()) await start();
    else showSignIn();
  }
  boot();
})();
