# IWC Team

A small dashboard for the four founding members: everyone's task list on top, the business's numbers below.
It is a plain static site (HTML, CSS, one JavaScript file, no build step, no libraries) that talks straight to the
IWC Supabase database. It shares no code with the website and changes nothing the website uses.

Preview it with made-up numbers: open `index.html?demo` (any static server, or on GitHub Pages once it's up).

## Files

| File | What it is |
|---|---|
| `setup.sql` | run once in Supabase: the task tables, who's on the team, the analytics function, access rules |
| `config.js` | the Supabase URL and the public (anon / publishable) key |
| `index.html`, `style.css`, `app.js` | the dashboard |
| `demo.js` | the made-up numbers for `?demo`; loaded only then |

## Set up (about 10 minutes)

1. **Sign-in accounts.** Each member signs in with an email and password from the project's Supabase Auth.
   Supabase → Authentication → Users → **Add user** → email + password, tick **Auto confirm user**. Anyone who
   already signs in to IWC with an email (the admin) can use that same account.
   (Adding a user also gives them an ordinary customer profile on the store, which is harmless.)
2. **Database.** Open `setup.sql`, replace the four `@example.com` emails with the real ones (lower case), then paste
   the whole file into Supabase → SQL editor → Run. Running it again later is safe: it updates the emails and keeps
   every task.
3. **Key.** In `config.js`, paste the project's anon key (Supabase → Project Settings → API keys, the `anon` /
   publishable one; it is the same value as Vercel's `NEXT_PUBLIC_SUPABASE_ANON_KEY`). Never the `service_role` /
   secret key.
4. **GitHub Pages.** Create a new repository (for example `iwc-team`) and push this folder:
   ```
   git init -b main
   git add .
   git commit -m "IWC Team dashboard"
   git remote add origin https://github.com/yobslob/iwc-team.git
   git push -u origin main
   ```
   Then on GitHub: Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)` → Save. The site appears at
   `https://yobslob.github.io/iwc-team/` within a minute or two. On GitHub's free plan Pages needs a public
   repository; that's fine here, because the URL and the anon key are public by design and the database lets only the
   four listed emails read or change anything (step 2). The page also asks search engines not to index it.

## Who can do what

- Only the emails in `team_members`, with a confirmed account, get in. Everyone else (store customers, anyone who
  finds the page) sees nothing and can change nothing; the database enforces this, not the page.
- All four have full access: anyone can add, edit, tick, re-date or delete a task in any column.
- To change who's on the team, edit the emails in `setup.sql` and run it again.

## Using it

- **Add:** type in "Add a task" under a name and press Enter.
- **Edit:** click a task's text, change it, Enter (Esc cancels).
- **Due date:** click the date beside a task (on a computer it appears when you hover); clear it in the picker to
  remove it. Late tasks turn red.
- **Done:** tick the circle. "Done · n" at the bottom of a column shows the finished ones.
- **Delete:** the × at the end of a task; "Undo" brings it back for a few seconds.
- The page fetches everyone's changes every 30 seconds while it's open, and when you come back to the tab.

## What the analytics mean

- **Sales**: the goods' prices on paid orders (before shipping, tax and discounts), not counting cancelled or
  refunded orders or removed pieces; the same rule as the website's own admin sales page.
- Each number is compared with the same number of days just before (7, 30 or 90).
- **Customers**: different emails that paid; *new* ones paid for the first time in this period.
- **Open orders**: where every paid, not yet delivered order stands right now; *Past delivery date* counts those
  whose promised window has ended.
- **Catalogue**: live listings by type, how many went live in the period, and drafts.
- **Team**: tasks done in the period, open, and late, per member.
- Days are counted in the viewer's own time zone.

All the arithmetic happens in the database (`team_analytics`), so the page downloads a few kilobytes and never the
orders themselves. It reads the website's `orders`, `order_items` and `products` tables and never writes to them.

## If the database is ever rebuilt

The website's repository doesn't know about these tables. A full `supabase db dump` (as in the move to the new
Supabase project) carries them along with their tasks; a database rebuilt only from the website's migrations does
not, so run `setup.sql` again there.

## Removing it

```sql
drop function if exists public.team_analytics(integer, text);
drop table if exists public.team_tasks;
drop function if exists public.team_tasks_stamp();
drop table if exists public.team_members;
drop function if exists public.team_is_member(), public.team_me();
```
