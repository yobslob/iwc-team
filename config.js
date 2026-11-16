// The two public values the dashboard needs. Both are safe to publish: the database only lets the four team
// members in (setup.sql). Find them in Supabase → Project Settings → API (or Vercel's NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY). Never put the service_role / secret key here.
window.IWC_TEAM = {
  supabaseUrl: "https://ttobhpcidixxdteczccv.supabase.co",
  supabaseKey: "sb_publishable_HYh0qm3NsqK-COza3q_y0g_HRKabgok",
};
