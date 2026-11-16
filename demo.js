/* Preview with made-up numbers: open index.html?demo. Nothing here touches the database. */
(() => {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  let seq = 0;
  const id = () => `demo-${++seq}`;
  const t = (member, title, due, done = false) => ({ id: id(), member, title, done, due_on: due == null ? null : day(due), created_at: new Date(Date.now() - seq * 6e5).toISOString(), done_at: done ? new Date().toISOString() : null });
  const tasks = [
    t("Yogesh", "Weigh this week's pieces at the hub", 0), t("Yogesh", "Order Kerala sarees from the shop", 2), t("Yogesh", "Courier invoice for Settings", null), t("Yogesh", "Pack Navratri order", null, true),
    t("Jollwin", "Answer customer emails", -1), t("Jollwin", "Check the weekly price run", 4), t("Jollwin", "Upload Punjab phulkari photos", null, true), t("Jollwin", "Fix Assam tea weights", null, true),
    t("Pritishma", "Write Maharashtra page story", 9), t("Pritishma", "Review new food drafts", 1),
    t("Sahil", "Compare US carriers", -3), t("Sahil", "Monthly database dump", 6), t("Sahil", "Set up uptime ping", null, true),
  ];
  const members = ["Yogesh", "Jollwin", "Pritishma", "Sahil"].map((name, i) => ({ name, sort: i + 1 }));

  function analytics(days) {
    let r = 7 * days + 3;
    const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const orders = rnd() < 0.25 ? 0 : Math.floor(rnd() * 4) + 1;
      daily.push({ day: day(-i), orders, sales_cents: orders ? Math.round(orders * (2400 + rnd() * 5200)) : 0 });
    }
    const sales = daily.reduce((s, d) => s + d.sales_cents, 0);
    const orders = daily.reduce((s, d) => s + d.orders, 0);
    return {
      days, tz: "Asia/Kolkata", from: daily[0].day, to: daily[daily.length - 1].day, generated_at: new Date().toISOString(),
      now: { sales_cents: sales, orders, pieces: Math.round(orders * 2.6), customers: Math.round(orders * 0.8), new_customers: Math.round(orders * 0.55) },
      before: { sales_cents: Math.round(sales * 0.81), orders: Math.round(orders * 0.86), pieces: Math.round(orders * 2.2), customers: Math.round(orders * 0.7), new_customers: Math.round(orders * 0.5) },
      daily,
      by_type: [{ type: "food", sales_cents: Math.round(sales * 0.52), pieces: 0 }, { type: "clothing", sales_cents: Math.round(sales * 0.33), pieces: 0 }, { type: "home", sales_cents: sales - Math.round(sales * 0.52) - Math.round(sales * 0.33), pieces: 0 }],
      top_regions: [["Kerala", 0.24], ["Punjab", 0.18], ["Rajasthan", 0.13], ["Maharashtra", 0.09], ["Assam", 0.06]].map(([name, f]) => ({ name, sales_cents: Math.round(sales * f), orders: Math.round(orders * f) })),
      top_products: [["Bikaneri bhujia 400 g", 31], ["Kerala banana chips", 22], ["Phulkari dupatta", 14], ["Assam CTC tea 250 g", 12], ["Brass diya set", 9]].map(([name, pieces]) => ({ name, pieces, sales_cents: pieces * 500 })),
      pipeline: [{ status: "confirmed", orders: 6 }, { status: "collecting", orders: 4 }, { status: "in_transit", orders: 9 }, { status: "shipped", orders: 3 }],
      late: 2,
      catalogue: { live: 5761, drafts: 112, live_by_type: { clothing: 664, food: 4093, home: 1004 }, listed_in_period: Math.round(days * 11.5) },
    };
  }

  const wait = (v) => new Promise((ok) => setTimeout(() => ok(structuredClone(v)), 120));
  let signedIn = true;
  window.IWC_DEMO_BACKEND = {
    hasSession: () => signedIn,
    signIn: async () => { signedIn = true; },
    signOut: async () => { signedIn = false; },
    me: () => wait("Jollwin"),
    members: () => wait(members),
    tasks: () => wait(tasks),
    addTask: (x) => { const row = { ...t(x.member, x.title, null), due_on: x.due_on, done: !!x.done }; tasks.push(row); return wait(row); },
    updateTask: (rid, patch) => { const row = tasks.find((x) => x.id === rid); Object.assign(row, patch); if ("done" in patch) row.done_at = patch.done ? new Date().toISOString() : null; return wait(row); },
    deleteTask: (rid) => { tasks.splice(tasks.findIndex((x) => x.id === rid), 1); return wait(null); },
    analytics: (days) => wait(analytics(days)),
  };
})();
