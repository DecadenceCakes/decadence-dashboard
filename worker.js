/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'   // Xero's token endpoint wants HTTP Basic client auth (client_secret_basic)
    },
    async status(env, h) {
      try {
        const tenant = await xeroTenant(env, h);
        if (!tenant) return { connected: false };
        return {
          connected: true,
          org: tenant.tenantName,
          sandbox: /demo company/i.test(tenant.tenantName || ''),
          lastSync: await lastSync(env, 'accounting')
        };
      } catch (err) {
        return { connected: false };
      }
    },
    async fetchRange(env, h, q) {
      const tenant = await xeroTenant(env, h);
      if (!tenant) throw new NotConfigured('accounting');
      const data = await h.fetchJson(
        XERO_API + '/Reports/ProfitAndLoss?fromDate=' + q.from + '&toDate=' + q.to,
        { headers: { 'Xero-Tenant-Id': tenant.tenantId, 'Accept': 'application/json' } }
      );
      const parsed = parsePL(data, 1);
      return {
        revenue: parsed.revenue[0],
        cogs: parsed.cogs[0],
        wagesSuper: parsed.wagesSuper[0],
        overheads: parsed.overheads[0],
        ownerWage: parsed.ownerWage[0]
      };
    },
    async fetchMonthly(env, h, q) {
      const tenant = await xeroTenant(env, h);
      if (!tenant) throw new NotConfigured('accounting');
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months: [], revenue: [], cogs: [], wagesSuper: [], overheads: [], ownerWage: [] };
      for (let i = 0; i < months.length; i += 12) {
        const batch = months.slice(i, i + 12);
        const fromDate = batch[0] + '-01';
        const toDate = monthEndDate(batch[batch.length - 1]);
        const periods = batch.length - 1;
        const url = XERO_API + '/Reports/ProfitAndLoss?fromDate=' + fromDate + '&toDate=' + toDate +
          '&timeframe=MONTH&periods=' + periods;
        const data = await h.fetchJson(url, { headers: { 'Xero-Tenant-Id': tenant.tenantId, 'Accept': 'application/json' } });
        const parsed = parsePL(data, batch.length);
        out.months.push(...batch);
        out.revenue.push(...parsed.revenue);
        out.cogs.push(...parsed.cogs);
        out.wagesSuper.push(...parsed.wagesSuper);
        out.overheads.push(...parsed.overheads);
        out.ownerWage.push(...parsed.ownerWage);
      }
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      try {
        const locations = await squareLocations(env);
        if (!locations.length) return { connected: false };
        const businessName = locations[0].business_name;
        const names = locations.map((l) => l.name).join(' + ');
        return {
          connected: true,
          org: (businessName && businessName !== names ? businessName + ' · ' : '') + names + (locations.length > 1 ? ' (' + locations.length + ' locations, all counted)' : ''),
          sandbox: false,
          lastSync: await lastSync(env, 'pos')
        };
      } catch (err) {
        return { connected: false };
      }
    },
    async fetchRange(env, h, q) {
      return { count: await squareCompletedCount(env, q.from, q.to, q.tz, q.rollover) };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const counts = [];
      for (const mo of months) {
        counts.push(await squareCompletedCount(env, mo + '-01', monthEndDate(mo), q.tz, q.rollover));
      }
      return { months, count: counts };
    }
  },

  /* >>> ADAPTER 2b: WEBSITE (Wix) - additional transaction-count channel, owner-
     requested July 2026. Xero already carries this revenue (owner confirmed),
     so this adapter supplies ONLY a completed-order count, same contract as
     pos, to feed the additional "All transactions" / "Average customer spend
     (all channels)" metrics - the locked Square-only Number of transactions
     and Average customer spend are untouched.
     Auth is a Wix account-level API Key (Settings > API Keys Manager on
     manage.wix.com), scoped to this one site with eCommerce/Orders read
     permission - NOT the OAuth app-install flow (that's for apps distributed
     to other people's sites; this is the owner's own single site, and Wix's
     own docs point single-site server-to-server integrations at API Keys
     instead). No browser redirect, no token refresh, nothing for the owner
     to click here - it just works once the two secrets are set.
     Secrets: WIX_API_KEY, WIX_SITE_ID. */
  website: {
    configured: true,
    auth: 'apikey',
    oauth: {},
    async status(env, h) {
      if (!env.WIX_API_KEY || !env.WIX_SITE_ID) return { connected: false };
      try {
        await wixSearchOrderCount(env, new Date(Date.now() - 86400000).toISOString(), new Date().toISOString());
        return {
          connected: true,
          org: 'Your Wix site (orders)',
          sandbox: false,
          lastSync: await lastSync(env, 'website')
        };
      } catch (err) {
        return { connected: false, error: { plain: 'Your Wix connection needs attention. Tell your AI it’s showing an error.' } };
      }
    },
    async fetchRange(env, h, q) {
      if (!env.WIX_API_KEY || !env.WIX_SITE_ID) throw new NotConfigured('website');
      return { count: await wixCompletedCount(env, q.from, q.to, q.tz, q.rollover) };
    },
    async fetchMonthly(env, h, q) {
      if (!env.WIX_API_KEY || !env.WIX_SITE_ID) throw new NotConfigured('website');
      const months = monthList(q.fromMonth, q.toMonth);
      const counts = [];
      for (const mo of months) {
        counts.push(await wixCompletedCount(env, mo + '-01', monthEndDate(mo), q.tz, q.rollover));
      }
      return { months, count: counts };
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* Every adapter key, derived from ADAPTERS itself so a new source (website,
   podium, ...) only needs adding there - the router/status/fetch loops below
   all iterate this instead of a hand-maintained list. */
const SOURCE_KEYS = Object.keys(ADAPTERS);

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

/* ---------------- Square (pos) adapter helpers ---------------------------- */

const SQUARE_API = 'https://connect.squareup.com';
const SQUARE_VERSION = '2026-05-20';

/* Convert a local wall-clock instant (date + hour, in a given IANA timezone)
   to the correct UTC Date - handles DST via the double-format trick. */
function zonedTimeToUtc(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = dtf.formatToParts(new Date(utcGuess)).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
  const asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
  const offset = asIfUTC - utcGuess;
  return new Date(utcGuess - offset);
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/* OWNER CONFIRMED (reconciliation, July 2026): this Square account has two
   tills, both for Decadence Cakes - count completed transactions across ALL
   locations, not just the default one (the List Payments endpoint otherwise
   scopes to the seller's single default location and silently undercounts). */
async function squareLocations(env) {
  const res = await fetch(SQUARE_API + '/v2/locations', {
    headers: { 'Square-Version': SQUARE_VERSION, 'Authorization': 'Bearer ' + (env.POS_API_TOKEN || ''), 'Accept': 'application/json' }
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  const data = await res.json();
  return data.locations || [];
}

/* Fetch every COMPLETED payment id for one location matching a given set of
   List Payments query params (paginated via cursor). Used twice below - once
   filtered by the payment's created_at (begin_time/end_time), once by its
   offline client_created_at (offline_begin_time/offline_end_time) - because
   the two filters are mutually exclusive on Square's side, and a payment
   taken while the till was briefly offline can otherwise fall outside the
   created_at window and be silently missed. */
async function squarePaymentIds(env, locationId, extraParams) {
  const ids = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ limit: '100', location_id: locationId, ...extraParams });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(SQUARE_API + '/v2/payments?' + params.toString(), {
      headers: { 'Square-Version': SQUARE_VERSION, 'Authorization': 'Bearer ' + (env.POS_API_TOKEN || ''), 'Accept': 'application/json' }
    });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const data = await res.json();
    for (const p of (data.payments || [])) {
      if (p.status === 'COMPLETED') ids.push(p.id);
    }
    cursor = data.cursor || null;
  } while (cursor);
  return ids;
}

/* Count COMPLETED payments (voids/cancellations excluded; refunds are
   separate records and never reduce this count) for [from, to] inclusive,
   across every location, honouring the venue's timezone and trading-day
   rollover hour, and including offline-taken payments synced later.
   De-duplicated by payment id. Never returns a dollar figure - see
   kpi-spec.md rule 2. */
async function squareCompletedCount(env, from, to, tz, rollover) {
  const beginTime = zonedTimeToUtc(from, rollover || 0, tz || 'Australia/Sydney').toISOString();
  const endTime = zonedTimeToUtc(addDaysStr(to, 1), rollover || 0, tz || 'Australia/Sydney').toISOString();
  const locations = await squareLocations(env);
  const seen = new Set();
  for (const loc of locations) {
    const online = await squarePaymentIds(env, loc.id, { begin_time: beginTime, end_time: endTime });
    online.forEach((id) => seen.add(id));
    const offline = await squarePaymentIds(env, loc.id, { offline_begin_time: beginTime, offline_end_time: endTime });
    offline.forEach((id) => seen.add(id));
  }
  return seen.size;
}

/* ---------------- Wix (website) adapter helpers --------------------------- */

const WIX_API = 'https://www.wixapis.com';

/* Count orders that represent a genuine completed sale: not canceled, and paid
   (a later refund never removes it from the count - kpi-spec.md rule 2, same
   principle as the Square adapter). Paginated defensively: only follows a
   cursor when a full page (100) came back, so an unexpected response shape
   degrades to "first page only" rather than looping forever.
   Auth: a site-scoped Wix API Key, sent as a raw Authorization header (no
   Bearer prefix) plus a wix-site-id header - no token minting, no refresh. */
async function wixSearchOrderCount(env, beginIso, endIso) {
  let count = 0;
  let cursor = null;
  do {
    const body = {
      filter: {
        createdDate: { '$gte': beginIso, '$lte': endIso },
        status: { '$ne': 'CANCELED' },
        paymentStatus: { '$in': ['PAID', 'PARTIALLY_REFUNDED', 'FULLY_REFUNDED'] }
      },
      cursorPaging: { limit: 100 }
    };
    if (cursor) body.cursorPaging.cursor = cursor;
    const res = await fetch(WIX_API + '/ecom/v1/orders/search', {
      method: 'POST',
      headers: {
        'Authorization': env.WIX_API_KEY || '',
        'wix-site-id': env.WIX_SITE_ID || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const data = await res.json();
    const orders = data.orders || [];
    count += orders.length;
    const nextCursor = (data.pagingMetadata && data.pagingMetadata.cursors && data.pagingMetadata.cursors.next)
      || (data.metadata && data.metadata.cursors && data.metadata.cursors.next) || null;
    cursor = orders.length === 100 ? nextCursor : null;
  } while (cursor);
  return count;
}

async function wixCompletedCount(env, from, to, tz, rollover) {
  const beginIso = zonedTimeToUtc(from, rollover || 0, tz || 'Australia/Sydney').toISOString();
  const endIso = zonedTimeToUtc(addDaysStr(to, 1), rollover || 0, tz || 'Australia/Sydney').toISOString();
  return wixSearchOrderCount(env, beginIso, endIso);
}

/* ---------------- Xero (accounting) adapter helpers ---------------------- */

const XERO_API = 'https://api.xero.com/api.xro/2.0';
const WAGE_RE = /wages|salaries|superannuation|super|payroll|annual leave|long service|workcover/i;

/* Resolve (and cache in the token record) which Xero organisation this
   connection is for. The Starter tier is one connection = one org, so the
   first entry from /connections is it. */
async function xeroTenant(env, h) {
  const tokens = await h.getTokens();
  if (!tokens) return null;
  if (tokens.tenantId && tokens.tenantName) return { tenantId: tokens.tenantId, tenantName: tokens.tenantName };
  const conns = await h.fetchJson('https://api.xero.com/connections', {});
  if (!Array.isArray(conns) || conns.length === 0) return null;
  const tenant = conns[0];
  await h.saveTokens({ ...tokens, tenantId: tenant.tenantId, tenantName: tenant.tenantName });
  return { tenantId: tenant.tenantId, tenantName: tenant.tenantName };
}

function monthEndDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)); /* day 0 of next month = last day of this month */
  return ym + '-' + String(last.getUTCDate()).padStart(2, '0');
}

function findSection(rows, matchFn) {
  for (const row of rows || []) {
    if (row.RowType === 'Section' && matchFn(row.Title || '')) return row;
  }
  return null;
}

function cellsToNumbers(cells, nCols) {
  const out = [];
  for (let i = 1; i <= nCols; i++) {
    const raw = cells[i] ? String(cells[i].Value).replace(/,/g, '') : '0';
    const v = parseFloat(raw);
    out.push(isFinite(v) ? v : 0);
  }
  return out;
}

/* Recursively collect every RowType:'Row' line under a section, including ones
   nested inside sub-sections (some Xero P&L layouts group accounts under
   sub-headings, e.g. an "overhead" grouping within Operating Expenses) - a flat
   top-level scan silently drops those and undercounts. */
function collectRows(section) {
  const out = [];
  (function walk(rows) {
    for (const r of rows || []) {
      if (r.RowType === 'Row') out.push(r);
      else if (r.RowType === 'Section') walk(r.Rows);
    }
  })((section && section.Rows) || []);
  return out;
}

function sectionTotals(section, nCols) {
  const rows = (section && section.Rows) || [];
  const summary = rows.find((r) => r.RowType === 'SummaryRow');
  if (summary) return cellsToNumbers(summary.Cells, nCols);
  const totals = new Array(nCols).fill(0);
  collectRows(section).forEach((r) => {
    cellsToNumbers(r.Cells, nCols).forEach((n, i) => { totals[i] += n; });
  });
  return totals;
}

/* Wage/super lines within Operating Expenses: keyword-matched here, then
   CONFIRMED WITH THE OWNER at reconciliation (capability-matrix.md, kpi-spec.md
   rule 5) - this proposes, the owner's confirmation is what makes it correct.
   OWNER CONFIRMED (reconciliation, July 2026): accounts labelled "(overhead)"
   are salaried/admin labour, not rostered trading-hour labour, so they're
   excluded from Wage % here and fall into Overheads instead - this is a
   chart-of-accounts mapping call (kpi-spec.md rule 3), not a redefinition of
   the Wage % formula itself. */
const OVERHEAD_LABOUR_RE = /\(overhead\)/i;
function wageSuperTotals(opexSection, nCols) {
  const rows = collectRows(opexSection);
  const totals = new Array(nCols).fill(0);
  const matched = [];
  rows.forEach((r) => {
    const label = (r.Cells[0] && r.Cells[0].Value) || '';
    if (WAGE_RE.test(label) && !OVERHEAD_LABOUR_RE.test(label)) {
      matched.push(label);
      cellsToNumbers(r.Cells, nCols).forEach((n, i) => { totals[i] += n; });
    }
  });
  return { totals, matched };
}

/* ADDITIONAL METRIC (owner-requested, kpi-spec.md deviation - kept separate from
   the locked Overheads/Profit): the owner draws a wage + super from these two
   "(overhead)"-labelled accounts but doesn't work day-to-day in the venue, so
   they asked for a Profit/Overheads view that excludes that draw. This totals
   exactly the accounts wageSuperTotals() above excludes - never touches the
   locked Wage %, Overheads, or Profit figures themselves. */
function ownerWageTotals(opexSection, nCols) {
  const rows = collectRows(opexSection);
  const totals = new Array(nCols).fill(0);
  const matched = [];
  rows.forEach((r) => {
    const label = (r.Cells[0] && r.Cells[0].Value) || '';
    if (WAGE_RE.test(label) && OVERHEAD_LABOUR_RE.test(label)) {
      matched.push(label);
      cellsToNumbers(r.Cells, nCols).forEach((n, i) => { totals[i] += n; });
    }
  });
  return { totals, matched };
}

/* Parse a Xero ProfitAndLoss report into per-column (period) arrays.
   nCols = number of amount columns requested (1 for a single range,
   batch.length for a multi-period pull). See capability-matrix.md (Xero)
   for the report shape and the worked example this mirrors. */
function parsePL(data, nCols) {
  const report = data && data.Reports && data.Reports[0];
  const rows = (report && report.Rows) || [];
  const incomeSection =
    findSection(rows, (t) => /^(trading\s+)?income$|^revenue$/i.test(t)) ||
    findSection(rows, (t) => /income/i.test(t) && !/other/i.test(t));
  const cosSection = findSection(rows, (t) => /cost of sales/i.test(t));
  const opexSection = findSection(rows, (t) => /operating expenses/i.test(t));

  const revenue = incomeSection ? sectionTotals(incomeSection, nCols) : new Array(nCols).fill(null);
  const cogs = cosSection ? sectionTotals(cosSection, nCols) : new Array(nCols).fill(0);
  const opexTotal = opexSection ? sectionTotals(opexSection, nCols) : new Array(nCols).fill(0);
  const wageResult = opexSection ? wageSuperTotals(opexSection, nCols) : { totals: new Array(nCols).fill(0), matched: [] };
  const overheads = opexTotal.map((t, i) => t - (wageResult.totals[i] || 0));
  const ownerWageResult = opexSection ? ownerWageTotals(opexSection, nCols) : { totals: new Array(nCols).fill(0), matched: [] };

  return { revenue, cogs, wagesSuper: wageResult.totals, overheads, ownerWage: ownerWageResult.totals, matchedWageLabels: wageResult.matched, matchedOwnerWageLabels: ownerWageResult.matched };
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!SOURCE_KEYS.includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      auth: adapter.auth || null,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: (st && st.error) || null
    };
  } catch (err) {
    return {
      configured: true,
      auth: adapter.auth || null,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of SOURCE_KEYS) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const statusPairs = await Promise.all(SOURCE_KEYS.map(async (k) => [k, await sourceStatus(env, k)]));
  const statuses = Object.fromEntries(statusPairs);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of SOURCE_KEYS) {
        if (source === 'rostering') continue; /* projected wage % only, not part of the monthly trend grid */
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: statuses,
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (SOURCE_KEYS.includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of SOURCE_KEYS) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
