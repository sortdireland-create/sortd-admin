// netlify/functions/generate-listings.js
// Fetches all live Airtable records, generates HTML for each, and commits
// the result directly into the sortd-site git repo via GitHub's API.
//
// ============================================================
// UNIFICATION (2026-09-22)
// Previously this function deployed straight to Netlify via the Deploy API,
// bypassing git entirely (see git history for the old deployToNetlify/
// zip-writer/site-functions code, removed here). That meant two independent
// systems were publishing to the same live site: this function (API deploys)
// and the hand-built pages in sortd-site (git deploys). Any ordinary git
// push to sortd-site triggered a full git-based rebuild that replaced the
// live deploy's file manifest with just what's in git — silently wiping
// every page this function had ever published, since they only ever
// existed in Netlify's deployed file state, never in git. That caused a
// real production outage on 2026-09-22.
//
// Fix: this function now writes its generated pages straight into the
// sortd-site git repo (one commit per run, only when something actually
// changed) instead of deploying separately. There is only one publish path
// again, so a git push can never wipe this function's output — because
// this function's output IS git's output now. Netlify Functions (submit-
// listing.js etc.) are also no longer re-uploaded here: they live in the
// same repo, so the normal git-triggered build picks them up like anything
// else. Requires a GITHUB_TOKEN env var (fine-grained PAT scoped to
// sortdireland-create/sortd-site, Contents: read/write).
// ============================================================

const crypto = require('crypto');

// ============================================================
// CONFIG
// ============================================================
const AIRTABLE_BASE = 'appuyWkAmTRI4lN5r';
const AIRTABLE_TABLE = 'tblziKRbWXA1veyuz';
const BASE_URL = 'https://sortd-ireland.ie';

// The single git repo both systems now publish through.
const GITHUB_OWNER = 'sortdireland-create';
const GITHUB_REPO = 'sortd-site';
const GITHUB_BRANCH = 'main';

const F = {
NAME: 'fldTrzk8wQ8sefLvj',
PROVIDER: 'fldTeVX37izewUhIA',
AGE_MIN: 'fldlFGnJMY1xYt56Y',
AGE_MAX: 'fld8InKRs58HRZgVX',
CATEGORY: 'fldkrBMNkG1HKhLqv',
DAYS: 'fldD9VsUEU1FUmQ9A',
TIMES: 'fldTO3plXqY0oX7wA',
COST: 'fldCBKMjvwvcYHUip',
LOCATION: 'fldo79Q8gFhWoHqMd',
AREA: 'fldUeF6R78CuZF39k',
COUNTY: 'fldNPedJO4jIgRa0j',
BOOKING_URL: 'fldEhcai8rQQuUWtY',
BOOKING: 'fldNP69Qh7Hw3YZx2',
INSTAGRAM: 'fldgem2tL1nbTbgPr',
ACTIVITIES: 'fldELpg99Iz6mNrIB',
NOTES: 'fldf0DnzcUkCcg2gE',
AVAILABILITY: 'fldaxaUQBfKAsWQrf', // singleSelect: Open / Limited spaces / Waitlist (blank = Open)
LIVE: 'fldBQ6YMcDuYPJkne',
WEEKS: 'fldL6Cf1fiQIdIAby',
TAGS: 'fldJi4Gme38iKvovO',
TYPE: 'fldIKsf7AM5Jqr60K',
COST_VALUE: 'fldISJYKzDZJYdE8r',
POSTCODE: 'fldwRc0BuvcO0T2gy',
DATE_START: 'fldwCRNqtDFTs7u4N',
DATE_END: 'fldgKIJM3jcMig7Ji',
SCHOOLS: 'fldI7BPPhFNmVtoGZ',
};

// ============================================================
// EXPIRY CHECK (added 2026-09-22)
//
// A Holiday Camp with an end date in the past should stop showing up in
// search/browse once it's over. Discovered 2026-09-22 that this was never
// enforced — 58 of 201 "live" listings turned out to already be finished
// (Designer Minds' ~50 summer locations, Navan Adventure Centre, Keys &
// Strings, Alive Outside, Neurodiversity Ireland's summer editions, LetsGo
// Wicklow, Malahide Cricket Club), all still generating pages and showing
// in search because nothing ever checked the date against Live=true.
//
// Checks DateEnd first (most records have it); falls back to the latest
// selected Week's known end date for older records that only have Weeks
// set. If neither is available, treats the record as NOT expired — can't
// safely determine, so don't guess and accidentally hide something real.
// Weekly Classes are recurring/ongoing and not checked here.
//
// This does not delete or un-publish already-committed pages for expired
// camps (same "redirect, don't delete" caution as the URL migration) — it
// only stops including them in new pages/sitemap/manifest/camps-data.js
// going forward, so old direct links don't suddenly 404.
// ============================================================
const WEEK_END_DATES = {
'Week 1':'2026-07-03','Week 2':'2026-07-10','Week 3':'2026-07-17',
'Week 4':'2026-07-24','Week 5':'2026-07-31','Week 6':'2026-08-07',
'Week 7':'2026-08-14','Week 8':'2026-08-21','Week 9':'2026-08-28',
};
// UPDATED 2026-11-04 (retiring the Halloween 2026 camps), per Rachel:
// - DateEnd now applies to EVERY listing type, Weekly Classes included. A
//   class whose end date has passed (e.g. a term block or a seasonal
//   "Autumn & Halloween" class) drops out of search like a camp does. A
//   Weekly Class with no DateEnd is still treated as ongoing.
// - New last-resort fallback for camps/one-offs with only a DateStart (the
//   provider self-submit form often leaves DateEnd blank — Playball's and
//   GCakes' Halloween submissions both did): treat it as over once
//   START_ONLY_GRACE_DAYS have passed since it started. Holiday camps here
//   run a week at most; multi-week summer camps use Weeks/DateEnd instead.
const START_ONLY_GRACE_DAYS = 6;
const isoDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0, 10) : null;
function addDays(iso, n) {
const d = new Date(iso + 'T00:00:00Z');
d.setUTCDate(d.getUTCDate() + n);
return d.toISOString().slice(0, 10);
}

function isExpiredCamp(f, todayStr) {
const typeRaw = f[F.TYPE];
const typeName = typeRaw && typeof typeRaw === 'object' ? typeRaw.name : (typeRaw||'');

const dateEnd = isoDate(f[F.DATE_END]);
if (dateEnd) return dateEnd < todayStr;

if (typeName === 'Weekly Class') return false; // ongoing unless it has an end date

const weeksRaw = f[F.WEEKS];
if (Array.isArray(weeksRaw) && weeksRaw.length) {
const weekNames = weeksRaw.map(w => (w && typeof w === 'object') ? w.name : String(w || ''));
const endDates = weekNames.map(w => WEEK_END_DATES[w]).filter(Boolean);
if (endDates.length) {
const latestEnd = endDates.sort().slice(-1)[0];
return latestEnd < todayStr;
}
}

const dateStart = isoDate(f[F.DATE_START]);
if (dateStart) return addDays(dateStart, START_ONLY_GRACE_DAYS) < todayStr;

return false; // no reliable date data on this record — don't guess
}

const WEEK_DATES = {
'Week 1':'29 Jun – 3 Jul','Week 2':'6–10 Jul','Week 3':'13–17 Jul',
'Week 4':'20–24 Jul','Week 5':'27–31 Jul','Week 6':'3–7 Aug',
'Week 7':'10–14 Aug','Week 8':'17–21 Aug','Week 9':'24–28 Aug',
};
const WEEK_START_DATES = {
'Week 1':'Mon 29 June 2026','Week 2':'Mon 6 July 2026','Week 3':'Mon 13 July 2026',
'Week 4':'Mon 20 July 2026','Week 5':'Mon 27 July 2026','Week 6':'Mon 3 August 2026',
'Week 7':'Mon 10 August 2026','Week 8':'Mon 17 August 2026','Week 9':'Mon 24 August 2026',
};
// Colour + icon per category — ported from js/search.js's categoryStyle()
// so a listing page always shows the SAME accent colour the listing card
// already showed the family on /camps or /weekly-classes. Each accent has a
// matching pale tint (same pairs as js/search.js's COLS array) used for the
// page's hero background, so the accent always sits on its own tint, never
// a mismatched one — matches the brand rule that every accent has one paired
// tint. These are the actual site.css tokens (--sk/--gr/--pu/--pkink), not
// the old bespoke palette this file used to hardcode.
function categoryStyle(cat) {
const c = (cat||'').toLowerCase();
if (c.includes('tennis')) return { icon:'ti-ball-tennis', colour:'#3D77A3', tint:'#CFE8F6' };
if (c.includes('football') || c.includes('gaa')) return { icon:'ti-ball-football', colour:'#1D8A52', tint:'#C9F0DA' };
if (c.includes('adventure') || c.includes('outdoor')) return { icon:'ti-mountain', colour:'#1D8A52', tint:'#C9F0DA' };
if (c.includes('drama') || c.includes('performing')) return { icon:'ti-masks-theater', colour:'#5B4FCA', tint:'#E7E1F8' };
if (c.includes('dance') || c.includes('music')) return { icon:'ti-music', colour:'#C6567F', tint:'#FBE1EB' };
if (c.includes('art')) return { icon:'ti-palette', colour:'#5B4FCA', tint:'#E7E1F8' };
if (c.includes('stem') || c.includes('coding') || c.includes('lego') || c.includes('science')) return { icon:'ti-circuit-board', colour:'#3D77A3', tint:'#CFE8F6' };
if (c.includes('language')) return { icon:'ti-language', colour:'#1D8A52', tint:'#C9F0DA' };
if (c.includes('additional needs')) return { icon:'ti-heart', colour:'#5B4FCA', tint:'#E7E1F8' };
if (c.includes('academic')) return { icon:'ti-book', colour:'#3D77A3', tint:'#CFE8F6' };
if (c.includes('multi') || c.includes('sport')) return { icon:'ti-stars', colour:'#3D77A3', tint:'#CFE8F6' };
return { icon:'ti-star', colour:'#3D77A3', tint:'#CFE8F6' };
}
const CATEGORY_CONFIG = new Proxy({}, { get: (_, cat) => categoryStyle(String(cat)) });
// Static / hub pages not driven by Airtable records.
// Add new hub/category/county pages here as they go live.
// UPDATED 2026-11-06 (AI/search audit, step 2): removed five URLs that
// pointed at pages which don't exist in sortd-site (/recommend,
// /neurodivergent-camps-ireland and three /dublin/*/camps hubs whose
// redirect targets were never built) and added the real search/browse
// pages. Monthly guides are added automatically from data/guides-index.json
// (see readRepoJson in the handler). Static pages carry no <lastmod> — this
// function can't know when a hand-built page last changed, and a fake
// "today" date on every run teaches crawlers to ignore the field.
const STATIC_PAGES = [
{ path: '/', changefreq: 'daily', priority: '1.0' },
{ path: '/find-an-activity', changefreq: 'daily', priority: '0.9' },
{ path: '/camps', changefreq: 'daily', priority: '0.9' },
{ path: '/weekly-classes', changefreq: 'daily', priority: '0.9' },
{ path: '/whats-on', changefreq: 'weekly', priority: '0.8' },
{ path: '/guides', changefreq: 'monthly', priority: '0.7' },
{ path: '/about', changefreq: 'monthly', priority: '0.5' },
{ path: '/how-it-works', changefreq: 'monthly', priority: '0.5' },
{ path: '/newsletter', changefreq: 'monthly', priority: '0.6' },
{ path: '/list', changefreq: 'monthly', priority: '0.5' },
{ path: '/privacy-policy', changefreq: 'yearly', priority: '0.2' },
];

// Archived (finished) listings — added 2026-11-06, per Rachel: "archive old
// listings, don't delete them". A listing whose end date has passed keeps
// its page at the same URL, rebuilt with a "this has finished" banner and
// no availability/next-date/booking claims, listed in /sitemap-archive.xml
// instead of /sitemap.xml, and still kept out of search (camps-data.js).
// The Airtable record is never touched (same principle as isExpiredCamp).
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(iso) {
const [y, m, d] = iso.split('-').map(Number);
return { d, m: MONTHS_SHORT[m-1], y };
}
// "13–17 Jul 2026", "28 Oct – 1 Nov 2026", "Summer 2026 (Week 3, Week 5)", or ''.
function ranWhenText(f) {
const ds = isoDate(f[F.DATE_START]);
const de = isoDate(f[F.DATE_END]);
if (ds && de) {
const a = fmtDay(ds), b = fmtDay(de);
if (ds === de) return `${a.d} ${a.m} ${a.y}`;
if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${b.m} ${b.y}`;
if (a.y === b.y) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`;
return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`;
}
if (de) { const b = fmtDay(de); return `until ${b.d} ${b.m} ${b.y}`; }
const weeks = Array.isArray(f[F.WEEKS]) ? f[F.WEEKS].map(w => (w && typeof w === 'object') ? w.name : String(w||'')).filter(w => WEEK_DATES[w]) : [];
if (weeks.length) return `summer 2026 (${weeks.map(w => `${w}: ${WEEK_DATES[w]}`).join(', ')})`;
if (ds) { const a = fmtDay(ds); return `from ${a.d} ${a.m} ${a.y}`; }
return '';
}
const todayIso = () => new Date().toISOString().slice(0, 10);

const CAVEAT_NOTES = {
'Tennis': 'all abilities welcome — just bring a racket ↗',
'Drama': 'no experience needed — just a big personality ↗',
'Performing arts': 'no experience needed — just a big personality ↗',
'Dance': 'no experience needed — just bring your best moves ↗',
'Music': 'beginners welcome — just bring the enthusiasm ↗',
'Swimming': 'all levels welcome — just bring a towel ↗',
'Adventure': 'all abilities welcome — adventure awaits ↗',
'Arts & Crafts': 'no experience needed — just bring your imagination ↗',
'STEM / LEGO': 'no experience needed — just bring your curiosity ↗',
'STEM': 'no experience needed — just bring your curiosity ↗',
'Nature': 'all welcome — just bring your wellies ↗',
'Football': 'all abilities welcome — just bring your boots ↗',
'GAA': 'all abilities welcome — just bring your gum shield ↗',
'default': 'something for everyone — places fill fast ↗',
};

// ============================================================
// HELPERS
// ============================================================
function makeSlug(provider, name) {
const clean = s => s.toLowerCase()
.replace(/[‐-―]/g,'-') // BUG FIX: normalize en-dash/em-dash/etc to a plain hyphen BEFORE stripping,
// otherwise "Ages 8–10" loses the dash entirely and becomes "ages810"
.replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
.replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o')
.replace(/[ùúûü]/g,'u').replace(/[^a-z0-9\s-]/g,'')
.trim().replace(/\s+/g,'-').replace(/-+/g,'-');
const p = clean(provider);
const n = clean(name);
// SLUG FIX (2026-09-22): dedupe on the provider's FIRST WORD only, not the
// whole cleaned provider string. The old `n.startsWith(p)` check almost
// never triggered in practice — "Stretch-n-Grow Halloween Camp – Dundrum"
// doesn't start with "stretch-n-grow-ireland" — so most slugs ended up
// doubled, e.g. "stretch-n-grow-ireland-stretch-n-grow-halloween-camp-
// dundrum". Matching on just the first word ("stretch") catches the same
// case cleanly and produces "stretch-n-grow-halloween-camp-dundrum",
// matching the shorter slugs already used elsewhere on the site.
const pFirstWord = p.split('-')[0];
return (pFirstWord && n.startsWith(pFirstWord)) ? n : `${p}-${n}`;
}
function makeCountySlug(c) { return c.toLowerCase().replace(/\s+/g,'-'); }
// Slug for a school hub page (/schools/{slug}.html) — same normalization as
// makeSlug's inner `clean` but standalone, since a school has no provider
// half to dedupe against. "St Oliver Plunkett NS (Malahide)" -> the
// parens/apostrophes are just stripped, not treated as a name to preserve.
function makeSchoolSlug(name) {
return String(name||'').toLowerCase()
.replace(/[‐-―]/g,'-')
.replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
.replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o')
.replace(/[ùúûü]/g,'u').replace(/[^a-z0-9\s-]/g,'')
.trim().replace(/\s+/g,'-').replace(/-+/g,'-');
}
// URL SCHEME FIX (2026-09-22): route by Type so a Weekly Class doesn't get
// published under /camps/... — Type is a singleSelect, so it may arrive as a
// plain string or as a {id,name,color} object (same shape as Category, see
// BUG 3 FIX above). Anything that isn't explicitly "Weekly Class" — including
// "Holiday Camp" and any blank/unrecognized value — keeps the original
// /camps/ section, so existing camp URLs are unaffected.
function sectionForType(typeRaw) {
const typeName = typeRaw && typeof typeRaw === 'object' ? typeRaw.name : (typeRaw||'');
return typeName === 'Weekly Class' ? 'classes' : 'camps';
}
// AVAILABILITY (added 2026-10-04): the single source of truth for the
// LIVE NOW / LIMITED SPACES / WAITLIST state, used by the listing page, the
// sibling-camp tags and the camps-data.js search index so they can't disagree.
// Returns 'Open', 'Limited spaces', 'Waitlist' or '' (field left blank).
// Availability is a singleSelect, so it may arrive as {id,name,color} or a
// plain string. Only when the field is blank do we fall back to the old
// convention of "FULLY BOOKED" typed into Notes (exact phrase only, so
// "waiting lists have reopened" can never flag a listing as waitlisted).
function availabilityOf(fields) {
const raw = fields[F.AVAILABILITY];
const name = raw && typeof raw === 'object' ? raw.name : (raw||'');
if (name) return name;
return /FULLY BOOKED/i.test(fields[F.NOTES]||'') ? 'Waitlist' : '';
}
function esc(s) {
return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
.replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escJson(s) {
return String(s||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n');
}

// ============================================================
// AIRTABLE FETCH
// ============================================================
async function fetchAllLiveRecords(apiKey, filterCounty) {
const records = [];
let offset = null;

// Use field ID in formula since we're using returnFieldsByFieldId=true
// fldBQ6YMcDuYPJkne = Live checkbox field
let formula = `{fldBQ6YMcDuYPJkne}=1`;
if (filterCounty) formula = `AND({fldBQ6YMcDuYPJkne}=1,{fldNPedJO4jIgRa0j}="${filterCounty}")`;

do {
const params = new URLSearchParams({
filterByFormula: formula,
pageSize: '100',
returnFieldsByFieldId: 'true',
});
if (offset) params.append('offset', offset);

const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?${params}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
const data = await res.json();
// Remap cellValuesByFieldId to fields for consistency
const remapped = (data.records||[]).map(r => ({ ...r, fields: r.fields || r.cellValuesByFieldId || {} }));
records.push(...remapped);
offset = data.offset || null;
} while (offset);

return records;
}

// ============================================================
// HTML GENERATOR
// ============================================================
// Shared site chrome, matching the homepage nav (6 Nov 2026 nav redesign) and footer.
const SITE_NAV = `<nav>
  <a href="/" class="brand">sortd<span>.</span></a>
  <div class="navlinks">
    <a href="/find-an-activity" class="navlink">Find an activity</a>
    <a href="/whats-on" class="navlink">What's on</a>
    <a href="/about" class="navlink">Our story</a>
    <a href="/list" class="navlink">For providers</a>
  </div>
  <div class="nav-right">
    <a href="https://www.instagram.com/sortd.ireland/" target="_blank" rel="noopener" aria-label="Sortd on Instagram"><i class="ti ti-brand-instagram nav-icon"></i></a>
    <a href="/login" class="navlink nav-login" id="nav-account-link" data-smn-item>Log in</a>
    <a href="/login" class="nav-cta-outline nav-signup" data-smn-cta>Sign up free</a>
    <a href="/find-an-activity" class="nav-cta nav-cta-find">Find an activity</a>
  </div>
</nav>`;
const SITE_FOOTER = `<footer>
  <div class="foot-nl">
    <div class="foot-nl-inner">
      <div>
        <div class="foot-nl-title">Get "what's on near you" every week</div>
        <p class="foot-nl-sub">New camps, open spots and honest updates — straight to your inbox. No spam.</p>
      </div>
      <form class="foot-nl-form">
        <input class="foot-nl-input" type="email" name="email" placeholder="your@email.ie" aria-label="Email address" required>
        <button class="foot-nl-btn" type="submit">Join free</button>
      </form>
    </div>
    <p class="foot-nl-msg" role="status" aria-live="polite"></p>
  </div>
  <div class="foot-top">
    <div>
      <div class="foot-logo">sortd</div>
      <p class="foot-tag">Every kids' camp &amp; class across Leinster, in one place. Built by a mum. For parents.</p>
      <div class="foot-social">
        <a href="https://www.instagram.com/sortd.ireland/" target="_blank" rel="noopener" aria-label="Instagram">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
        </a>
        <a href="https://whatsapp.com/channel/0029Vb7sv3eInlqMyMfLFY01" target="_blank" rel="noopener" aria-label="WhatsApp">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        </a>
      </div>
    </div>
    <div class="foot-col">
      <div class="foot-heading">Browse</div>
      <a href="/camps?q=Dublin">Dublin camps</a>
      <a href="/camps?q=Wicklow">Wicklow camps</a>
      <a href="/camps?q=Meath">Meath camps</a>
      <a href="/camps">All camps</a>
      <a href="/weekly-classes">All classes</a>
    </div>
    <div class="foot-col">
      <div class="foot-heading">Company</div>
      <a href="/how-it-works">How it works</a>
      <a href="/guides">Monthly guides</a>
      <a href="/about">Our story</a>
      <a href="/newsletter">Newsletter</a>
      <a href="mailto:sortd.ireland@gmail.com?subject=Camp%20recommendation">Recommend an activity</a>
      <a href="mailto:sortd.ireland@gmail.com">Contact</a>
    </div>
    <div class="foot-col">
      <div class="foot-heading">For providers</div>
      <a href="/list">List your activity free</a>
      <a href="/claim">Claim your listing</a>
      <a href="https://portal.sortd-ireland.ie" target="_blank" rel="noopener">Provider login</a>
    </div>
  </div>
  <div class="foot-bottom">
    <div>© 2026 Sortd Ireland · <a href="/privacy-policy">Privacy Policy</a></div>
    <div class="foot-source">Sources: provider websites, WhatsApp screenshots, Instagram. Confirm details with each provider before booking.</div>
  </div>
</footer>
<div class="popup-overlay" id="popupOverlay" role="dialog" aria-modal="true" aria-label="Get the Thursday email from sortd">
<div class="popup">
<button class="popup-close" onclick="closePopup()" aria-label="Close">&#10005;</button>
<div class="popup-logo">sortd</div>
<div class="popup-title">Get the Thursday email</div>
<p class="popup-sub">New camps, open spots and honest updates, once a week. Free, and you can unsubscribe in one click.</p>
<form class="popup-form">
<input class="popup-input" type="email" name="email" placeholder="Your email address" required autocomplete="email" aria-label="Email address">
<button class="popup-btn" type="submit">Get the Thursday email</button>
</form>
<div class="popup-msg" role="status"></div>
</div>
</div>
<script>
function openPopup() {
  document.getElementById('popupOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closePopup() {
  document.getElementById('popupOverlay').classList.remove('show');
  document.body.style.overflow = '';
}
document.getElementById('popupOverlay').addEventListener('click', function(e) {
  if (e.target === this) closePopup();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closePopup();
});
</script>`;

// ============================================================
// WEEKLY CLASS PAGES (redesigned 5 Nov 2026, per Rachel: class pages were
// using camp wording and were too busy). One sticky action card (Book with
// provider, Add to my calendar, Save, Share), the full timetable grouped by
// day and venue, and nothing camp-specific (no weeks, no camp script note).
// Styles live in sortd-site /css/class-page.css and behaviour in
// /js/class-page.js, so design tweaks don't need every page regenerated.
// ============================================================
const DAY_FULL = {mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
function timetableHTML(times) {
const lines = String(times||'').split('\n').map(l => l.trim()).filter(Boolean);
if (!lines.length) return '';
const groups = []; const plain = [];
lines.forEach(line => {
const m = line.match(/^([A-Za-z]{3,9})\.?\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/);
const day = m && DAY_FULL[m[1].toLowerCase().slice(0,3)];
if (!day) { plain.push(line); return; }
const slots = m[3].split(/,\s*(?=\d)/).map(x => x.trim()).filter(Boolean).map(x => {
const t = x.match(/^([\d:.]+\s*(?:am|pm)?\s*[-–]\s*[\d:.]+\s*(?:am|pm)?)\s*(.*)$/i);
return t ? { time: t[1].replace(/\s*[-–]\s*/, '–'), what: t[2] } : { time: '', what: x };
});
groups.push({ day, venue: (m[2]||'').trim(), slots });
});
let html = '';
if (groups.length) {
html += '<div class="cl-tt">' + groups.map(g => `<div class="cl-tt-grp"><h3>${esc(g.day)}${g.venue ? ` <span>· ${esc(g.venue)}</span>` : ''}</h3>` +
g.slots.map(s => `<div class="cl-tt-row"><b>${esc(s.time)}</b><span>${esc(s.what)}</span></div>`).join('') + '</div>').join('') + '</div>';
}
if (plain.length) html += `<ul class="cl-tt-plain${groups.length ? ' cl-tt-more' : ''}">` + plain.map(l => `<li>${esc(l)}</li>`).join('') + '</ul>';
return html;
}

function generateClassHTML(record, allRecords, opts = {}) {
const f = record.fields;
const archived = !!opts.archived;
const ranWhen = archived ? ranWhenText(f) : '';
const name = (f[F.NAME]||'').trim();
const provider = (f[F.PROVIDER]||'').trim();
const tags = (f[F.TAGS]||'').trim();
const categoryRaw = f[F.CATEGORY];
const category = categoryRaw && typeof categoryRaw === 'object' ? categoryRaw.name : (categoryRaw||'');
const ageMin = f[F.AGE_MIN]||'';
const ageMax = f[F.AGE_MAX]||'';
const days = (f[F.DAYS]||'').trim();
const times = (f[F.TIMES]||'').trim();
const cost = (f[F.COST]||'').trim();
const location = (f[F.LOCATION]||'').trim();
const area = (f[F.AREA]||'').trim();
const county = (f[F.COUNTY]||'').trim();
const bookingUrl = (f[F.BOOKING_URL]||'').trim();
const booking = (f[F.BOOKING]||'').trim();
const instagram = (f[F.INSTAGRAM]||'').trim();
const activities = (f[F.ACTIVITIES]||'').trim();
const notes = (f[F.NOTES]||'').trim();
const dateStart = isoDate(f[F.DATE_START]);
const dateEnd = isoDate(f[F.DATE_END]);

const countySlug = makeCountySlug(county||'ireland');
const slug = makeSlug(provider, name);
const pageUrl = `${BASE_URL}/classes/${countySlug}/${slug}`;
const cat = CATEGORY_CONFIG[category] || CATEGORY_CONFIG['default'];
const agesDisplay = ageMin && ageMax ? `Ages ${ageMin}–${ageMax}` : ageMin ? `Ages ${ageMin}+` : 'All ages';
const costFirst = cost.split('\n')[0].trim();
const costNote = cost.includes('\n') ? cost.split('\n').slice(1).join('\n').trim() : '';
const description = activities || notes || `${category} class in ${area||county}.`;
const descClean = description.replace(/\n/g,' ').trim();
const sfx = `. Weekly ${category.toLowerCase()} class in ${area}, ${county}${ageMin&&ageMax ? ` for ages ${ageMin}–${ageMax}` : ''}. On sortd.`;
const metaDesc = (descClean.length > 155-sfx.length ? descClean.substring(0,155-sfx.length-1)+'…' : descClean) + sfx;
const title = name.toLowerCase().startsWith(provider.toLowerCase().split(' ')[0].toLowerCase()) ? name : provider + ' — ' + name;
const daysShort = days.replace(/\n/g, ', ').replace(/Monday/g,'Mon').replace(/Tuesday/g,'Tue').replace(/Wednesday/g,'Wed').replace(/Thursday/g,'Thu').replace(/Friday/g,'Fri').replace(/Saturday/g,'Sat').replace(/Sunday/g,'Sun');
const isNeurodivergent = /neurodivergent/i.test(tags);
const isFullyBooked = availabilityOf(f) === 'Waitlist';
const isMembersOnly = /MEMBERS ONLY/i.test(notes);
const realLocation = location && !/confirm with provider/i.test(location);
const igHandle = instagram ? instagram.replace(/https?:\/\/(www\.)?instagram\.com\//,'').replace(/\/$/,'') : null;
let bookingHostname = '';
if (bookingUrl) { try { bookingHostname = new URL(bookingUrl).hostname.replace(/^www\./,''); } catch { bookingHostname = bookingUrl.replace(/https?:\/\/(www\.)?/,'').split('/')[0]; } }
const provShort = provider.length > 24 ? 'provider' : provider;
const bookLabel = archived ? `See what's next at ${provShort}` : isFullyBooked ? 'Join the waitlist' : `Book with ${provShort}`;

// Venues named in the timetable, e.g. "Mon (St. Nicholas Hall): ..."
const venues = [];
times.split('\n').forEach(l => { const m = l.match(/^[A-Za-z]{3,9}\.?\s*\(([^)]*)\)\s*:/); if (m && !venues.includes(m[1].trim())) venues.push(m[1].trim()); });
const mapsQ = encodeURIComponent((realLocation ? location.replace(/\n/g,', ') : `${area}, ${county}`));
const whereHtml = realLocation
? location.split('\n').map(l => esc(l.trim())).filter(Boolean).join('<br>')
: venues.length ? `${esc(area)}, ${esc(county)}. Classes run at ${venues.map(esc).join(', ')}.` : `${esc(area)}, ${esc(county)}. The provider confirms the exact venue when you book.`;

const siblings = (allRecords||[]).filter(r => r.id !== record.id).map(r => {
const rf = r.fields; const rName = (rf[F.NAME]||'').trim(); const rProvider = (rf[F.PROVIDER]||'').trim(); const rCounty = (rf[F.COUNTY]||'').trim();
if (rProvider !== provider || !rName || !rCounty || (rf[F.SCHOOLS] && rf[F.SCHOOLS].length)) return null;
const a1 = rf[F.AGE_MIN]||'', a2 = rf[F.AGE_MAX]||'';
return { name: rName, url: `/${sectionForType(rf[F.TYPE])}/${makeCountySlug(rCounty)}/${makeSlug(rProvider, rName)}`, ages: a1 && a2 ? `ages ${a1}–${a2}` : '', done: isExpiredCamp(rf, todayIso()) };
}).filter(Boolean);
const ageKey = ageMin === '' ? '' : ageMin <= 2 ? '0-2' : ageMin <= 5 ? '3-5' : ageMin <= 8 ? '6-8' : ageMin <= 12 ? '9-12' : '13-99';
const tt = timetableHTML(times);

const pageData = { id: record.id, slug, name, provider, url: pageUrl, days, times, cost: costFirst, area: `${area}${county ? ', ' + county : ''}`,
location: realLocation ? location.replace(/\n/g, ', ') : '', bookingUrl, dateStart, dateEnd };
const pageJson = JSON.stringify(pageData).replace(/</g, '\\u003c');

const bookBtn = bookingUrl
? `<a href="${esc(bookingUrl)}" target="_blank" rel="noopener" class="lp-btn lp-btn--book bb" data-track="booking">${esc(bookLabel)} <i class="ti ti-external-link"></i></a>`
: igHandle ? `<a href="${esc(instagram)}" target="_blank" rel="noopener" class="lp-btn lp-btn--book" data-track="booking"><i class="ti ti-brand-instagram"></i> Message ${esc(provShort)} to book</a>` : '';
const calBtn = archived ? '' : `<button type="button" class="lp-btn lp-btn--cal" data-lp="calendar"><i class="ti ti-calendar-plus"></i> Add to my Sortd calendar</button>`;
const howBits = [];
if (booking) howBits.push(esc(booking));
else if (igHandle && bookingUrl) howBits.push(`Instagram: <a href="${esc(instagram)}" target="_blank" rel="noopener">@${esc(igHandle)}</a>`);

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-HHTB7S9WJG"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-HHTB7S9WJG');
</script>
<script src="/js/booking-tracking.js" defer></script>
<script src="/js/newsletter-signup.js" defer></script>
<script src="/js/account.js" defer></script>
<script src="/js/saved.js" defer></script>
<script src="/js/school-year.js" defer></script>
<script src="/js/class-page.js" defer></script>
<title>${esc(name)} — ${esc(area)}, ${esc(county)} | sortd</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${esc(name+' — '+area+' | sortd')}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SportsClub","name":"${escJson(name)}","description":"${escJson(descClean)}","url":"${pageUrl}","address":{"@type":"PostalAddress","addressLocality":"${escJson(area)}","addressRegion":"${escJson(county)}","addressCountry":"IE"}}<\/script>
${breadcrumbJsonLd(listingTrail(county, area, 'classes'), name, pageUrl)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:wght@400;600;700;800&family=Caveat:wght@600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
<link rel="stylesheet" href="/css/site.css">
<link rel="stylesheet" href="/css/class-page.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body data-listing-id="${esc(record.id)}" data-listing-name="${esc(name)}" data-provider="${esc(provider)}" data-listing-type="class" style="--cat:${cat.colour};--cat-tint:${cat.tint};">
${isMembersOnly ? '<div class="lp-mo-ribbon"><i class="ti ti-lock"></i> For existing members only</div>' : ''}
${SITE_NAV}

<nav class="lp-bc" aria-label="Breadcrumb">
<div class="lp-bc-inner">
${trailHTML(listingTrail(county, area, 'classes'), name)}
</div>
</nav>

<div class="cl-wrap">
<main class="cl-page">

<header class="cl-head">
<div class="cl-eyebrow">Weekly class · ${esc(category)}</div>
<h1>${esc(title)}</h1>
<div class="cl-prov">${esc(provider)}${isNeurodivergent ? '<span class="cl-badge cl-badge--nd">Neurodivergent-friendly</span>' : ''}</div>
<div class="cl-chips">
<span class="cl-chip"><i class="ti ti-users"></i>${esc(agesDisplay)}</span>
${daysShort ? `<span class="cl-chip"><i class="ti ti-calendar-event"></i>${esc(daysShort)}</span>` : ''}
<span class="cl-chip"><i class="ti ti-map-pin"></i>${esc(area||county)}</span>
</div>
${archived ? `<div class="cl-banner" style="background:#fff;border-color:var(--bd);color:#3f4557;"><b style="color:var(--nv);">This class has finished</b>It ran ${ranWhen ? esc(ranWhen) : 'earlier this year'}. We've kept the details here for reference. Check with ${esc(provider)} for their next term, or browse classes running now.</div>` : isFullyBooked ? '<div class="cl-banner"><b>Full right now</b>Spaces sometimes open up during the term. Join the waitlist to be first in line.</div>' : ''}
</header>

<aside class="lp-act${bookBtn ? '' : ' lp-act--nobook'}" aria-label="Book or plan this class">
<div class="lp-booked" id="lp-booked" hidden><b>Booked a place?</b>Add it to your Sortd calendar so you don't miss a week.<button type="button" id="lp-booked-x" aria-label="Dismiss">✕</button></div>
<div class="lp-act-price${costFirst.length > 28 ? ' lp-act-price--long' : ''}">${esc(costFirst || 'Price on request')}</div>
${costFirst ? '<div class="lp-act-sub">per child</div>' : ''}
${bookBtn}
${calBtn}
<div class="lp-minor">
<button type="button" class="lp-mini" data-save-id="${esc(record.id)}" aria-pressed="false" aria-label="Save for later"><i class="ti ti-heart h-off"></i><i class="ti ti-heart-filled h-on"></i> Save</button>
<button type="button" class="lp-mini" data-lp="share"><i class="ti ti-share"></i> Share</button>
</div>
${howBits.length ? `<div class="lp-act-how">${howBits.join('<br>')}</div>` : ''}
</aside>

<div class="cl-body">
${tt ? `<section class="cl-card"><h2>Timetable</h2>${tt}<p class="cl-note">Times are from ${esc(provider)}${bookingHostname ? ' (' + esc(bookingHostname) + ')' : ''}. Check with them before your first class.</p></section>` : ''}

<section class="cl-card"><h2>About</h2><p class="cl-about">${esc(description)}</p>
${costNote ? `<p class="cl-note">${esc(costNote).replace(/\n/g,'<br>')}</p>` : ''}</section>

<section class="cl-card"><h2>Where</h2><div class="cl-where"><div>${whereHtml}</div>
<a href="https://maps.google.com/?q=${mapsQ}" target="_blank" rel="noopener">Open in Google Maps <i class="ti ti-external-link"></i></a></div></section>

${siblings.length ? `<section class="cl-card"><h2>More from ${esc(provider)}</h2><div class="cl-sib">${siblings.map(s => `<a href="${esc(s.url)}">${esc(s.name)}${s.ages || s.done ? `<span>${[s.ages, s.done ? 'finished' : ''].filter(Boolean).map(esc).join(' · ')}</span>` : ''}</a>`).join('')}</div></section>` : ''}

<div class="cl-explore" role="navigation" aria-label="Explore more classes">
<a href="/weekly-classes?text=${encodeURIComponent(category)}">More ${esc(category.toLowerCase())} classes</a>
<a href="/weekly-classes?q=${encodeURIComponent(area||county)}">Classes in ${esc(area||county)}</a>
${ageKey ? `<a href="/weekly-classes?age=${ageKey}">Classes for ${esc(agesDisplay.toLowerCase())}</a>` : ''}
</div>
<p class="cl-src">Listed on Sortd from ${esc(provider)}'s own information. Confirm details with them before booking.</p>
</div>

</main>
</div>

<div class="lp-bar" aria-hidden="true">
${bookingUrl ? `<a href="${esc(bookingUrl)}" target="_blank" rel="noopener" class="lp-btn lp-btn--book bb" data-track="booking" tabindex="-1">${esc(archived ? `What's next at ${provShort}` : isFullyBooked ? 'Join waitlist' : 'Book')} <i class="ti ti-external-link"></i></a>` : ''}
${archived ? '' : `<button type="button" class="lp-btn lp-btn--cal" data-lp="calendar" tabindex="-1"${bookingUrl ? ' aria-label="Add to my Sortd calendar"' : ''}><i class="ti ti-calendar-plus"></i>${bookingUrl ? '' : ' Add to my Sortd calendar'}</button>`}
</div>

<script type="application/json" id="lp-data">${pageJson}</script>

${SITE_FOOTER}
</body>
</html>`;
}

function generateHTML(record, allRecords, opts = {}) {
const f = record.fields;
const archived = !!opts.archived;
const name = (f[F.NAME]||'').trim();
const provider = (f[F.PROVIDER]||'').trim();
const tags = (f[F.TAGS]||'').trim();
// BUG 3 FIX: category is a select object {id, name, color} — always extract .name
const categoryRaw = f[F.CATEGORY];
const category = categoryRaw && typeof categoryRaw === 'object' ? categoryRaw.name : (categoryRaw||'');
const ageMin = f[F.AGE_MIN]||'';
const ageMax = f[F.AGE_MAX]||'';
const days = (f[F.DAYS]||'').trim();
const times = (f[F.TIMES]||'').trim();
const cost = (f[F.COST]||'').trim();
const location = (f[F.LOCATION]||'').trim();
const area = (f[F.AREA]||'').trim();
const county = (f[F.COUNTY]||'').trim();
const bookingUrl = (f[F.BOOKING_URL]||'').trim();
const booking = (f[F.BOOKING]||'').trim();
const instagram = (f[F.INSTAGRAM]||'').trim();
const activities = (f[F.ACTIVITIES]||'').trim();
const notes = (f[F.NOTES]||'').trim();
// BUG 4 FIX: weeks is an array of select objects {id, name, color} — extract .name from each
const weeks = Array.isArray(f[F.WEEKS])
? f[F.WEEKS].map(w => (w && typeof w === 'object') ? w.name : String(w||'')).filter(Boolean)
: [];
// NOTE: a record with the Schools field populated never reaches this
// function at all — the main handler loop diverts it straight to its
// school's hub page instead of generating an individual listing page for
// it (see the school-hub-pages section below). So this function only ever
// needs the plain generic MEMBERS ONLY convention, unchanged from before
// that feature existed.

const countySlug = makeCountySlug(county||'ireland');
const slug = makeSlug(provider, name);
const section = sectionForType(f[F.TYPE]);
if (section === 'classes') return generateClassHTML(record, allRecords, opts);
const ranWhen = archived ? ranWhenText(f) : '';
const listingType = section === 'classes' ? 'class' : 'camp';
const pageUrl = `${BASE_URL}/${section}/${countySlug}/${slug}`;
const cat = CATEGORY_CONFIG[category] || CATEGORY_CONFIG['default'];
const caveat = CAVEAT_NOTES[category] || CAVEAT_NOTES['default'];
const agesDisplay = ageMin && ageMax ? `${ageMin}–${ageMax} yrs` : ageMin ? `${ageMin}+ yrs` : 'All ages';
const costFirst = cost.split('\n')[0].trim();
const costNote = cost.includes('\n') ? cost.split('\n').slice(1).join('\n').trim() : '';
const firstWeek = weeks[0] || null;
const nextStart = firstWeek ? (WEEK_START_DATES[firstWeek] || firstWeek) : null;
const description = activities || notes || `${category} camp in ${area||county}.`;
const daysFirst = days.split('\n')[0].trim();
const timesFirst = times.split('\n')[0].trim();
const catSlug = category.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const areaSlug = (area||'').toLowerCase().replace(/\s+/g,'-');
const ageSlug = ageMin && ageMax ? `${ageMin}-${ageMax}` : '';
const igHandle = instagram ? instagram.replace(/https?:\/\/(www\.)?instagram\.com\//,'').replace(/\/$/,'') : null;
const mapsQ = encodeURIComponent(location.replace(/\n/g,', '));
const waText = encodeURIComponent(`I found this camp on sortd-ireland.ie — thought you might be interested! ${pageUrl}`);
const emailBody = encodeURIComponent(`I found this camp on sortd-ireland.ie — thought you might be interested!\n${pageUrl}`);
const locLines = location.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>`${esc(l)}<br>`).join('');
const sfx = `. ${category} camp in ${area}, ${county} for ages ${ageMin}–${ageMax}. Find and book on sortd-ireland.ie.`;
const descClean = description.replace(/\n/g,' ').trim();
const metaDesc = (descClean.length > 155-sfx.length ? descClean.substring(0,155-sfx.length-1)+'…' : descClean) + sfx;
const weeksHtml = weeks.length
? weeks.map(w=>`<div class="wc"><div class="wc__p">${esc(w)} · ${WEEK_DATES[w]||''}</div><div class="wc__s">${esc(daysFirst)}</div></div>`).join('')
: '<p class="mu">Check with the provider for available weeks.</p>';

// Safe hostname extraction for booking URL display
let bookingHostname = '';
if (bookingUrl) {
try { bookingHostname = new URL(bookingUrl).hostname.replace(/^www\./,''); }
catch { bookingHostname = bookingUrl.replace(/https?:\/\/(www\.)?/,'').split('/')[0]; }
}

// Neurodivergent-friendly badge — driven by the Tags field, so it applies to
// ANY camp tagged this way, not just one provider.
const isNeurodivergent = /neurodivergent/i.test(tags);

// Waitlist state — driven by the Availability field (see availabilityOf).
// Swaps the CTA to a waitlist link instead of hiding the page, so full
// listings still rank and still convert waitlist signups.
const isFullyBooked = availabilityOf(f) === 'Waitlist';
const bookBtnLabel = archived ? `Check ${provider.length > 24 ? 'the provider' : provider} for upcoming dates ↗` : isFullyBooked ? 'Join the waitlist ↗' : 'Book this camp ↗';
const archivedBanner = archived ? `
<div class="lp-fb-banner lp-done-banner">
<div class="lp-fb-banner-t">This camp has finished</div>
<p class="lp-fb-banner-p">It ran ${ranWhen ? esc(ranWhen) : 'earlier this year'}. We've kept the details here for reference. Check with ${esc(provider)} for their next dates, or browse camps coming up.</p>
</div>` : '';
const fullyBookedBanner = isFullyBooked && !archived ? `
<div class="lp-fb-banner">
<div class="lp-fb-banner-t">Fully booked right now</div>
<p class="lp-fb-banner-p">This one is full, but spaces sometimes open up when families cancel. Join the waitlist to be first in line.</p>
</div>` : '';

// Restricted / members-only listing — signalled by the provider (or Rachel)
// putting "MEMBERS ONLY" in Notes, same convention as FULLY BOOKED above.
// Rendered as a ribbon across the very top of the page, above the nav, so
// it's the first thing a visitor sees before they read anything else —
// this is for listings like Hi5's that aren't open-enrolment.
const isMembersOnly = /MEMBERS ONLY/i.test(notes);
const membersOnlyRibbon = isMembersOnly ? `
<div class="lp-mo-ribbon"><i class="ti ti-lock"></i> For existing members only</div>` : '';

// Sibling camps — other live listings from the same provider, so multi-age-group
// or multi-location providers (NDI, Designer Minds, etc.) automatically cross-link
// without any manual page-building.
const siblings = (allRecords||[])
.filter(r => r.id !== record.id)
.map(r => {
const rf = r.fields;
const rName = (rf[F.NAME]||'').trim();
const rProvider = (rf[F.PROVIDER]||'').trim();
const rCounty = (rf[F.COUNTY]||'').trim();
if (rProvider !== provider || !rName || !rCounty) return null;
const rSlug = makeSlug(rProvider, rName);
const rCountySlug = makeCountySlug(rCounty);
const rSection = sectionForType(rf[F.TYPE]);
const rAgeMin = rf[F.AGE_MIN]||'';
const rAgeMax = rf[F.AGE_MAX]||'';
const rFull = availabilityOf(rf) === 'Waitlist';
const rDone = isExpiredCamp(rf, todayIso());
return {
name: rName,
url: `/${rSection}/${rCountySlug}/${rSlug}`,
ages: rAgeMin && rAgeMax ? `${rAgeMin}–${rAgeMax}` : '',
full: rFull,
done: rDone,
};
})
.filter(Boolean);

const siblingsHtml = siblings.length ? `
<div class="sc">
<div class="sl">More from ${esc(provider)}</div>
<div class="other-camps">
${siblings.map(s => `<a href="${esc(s.url)}" class="camp-link">${esc(s.name)}${s.ages ? ` <span class="mu">(ages ${esc(s.ages)})</span>` : ''} ${s.done ? '<span class="mu">Finished</span>' : s.full ? '<span class="full-tag">Waitlist</span>' : '<span class="avail">Places available ✓</span>'}</a>`).join('')}
</div>
</div>` : '';

// Hub page (the /camps or /weekly-classes search page) this listing belongs
// under, and a best-effort age bucket matching the hero search filter's own
// buckets — both used by the breadcrumb and "explore more" links below so
// they push into the SAME search UI real visitors use, with the same query
// params search.js already reads (q, age, text), instead of the old
// hardcoded /dublin/northside/camps path that didn't exist as a real route.
const hubPath = section === 'classes' ? '/weekly-classes' : '/camps';
const ageKey = ageMin === '' ? '' : ageMin <= 2 ? '0-2' : ageMin <= 5 ? '3-5' : ageMin <= 8 ? '6-8' : ageMin <= 12 ? '9-12' : '13-99';

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-HHTB7S9WJG"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-HHTB7S9WJG');
</script>
<script src="/js/booking-tracking.js" defer></script>
<script src="/js/newsletter-signup.js" defer></script>
<script src="/js/account.js" defer></script>
<title>${esc(name)} — ${esc(area)}, ${esc(county)} | sortd</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${esc(name+' — '+area+' | sortd')}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SportsClub","name":"${escJson(name)}","description":"${escJson(descClean)}","url":"${pageUrl}","address":{"@type":"PostalAddress","addressLocality":"${escJson(area)}","addressRegion":"${escJson(county)}","addressCountry":"IE"}}<\/script>
${breadcrumbJsonLd(listingTrail(county, area, section), name, pageUrl)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:wght@400;600;700&family=Caveat:wght@600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
<!-- Shared site stylesheet — same nav/hero/footer/tokens as the homepage,
     /camps and /weekly-classes, so a listing page is never its own island. -->
<link rel="stylesheet" href="/css/site.css">
<style>
/* ── Listing-page-only rules. Everything else (nav, footer, popup, colour
   tokens, fonts) comes from /css/site.css so this page always stays in sync
   with the rest of the site instead of drifting on its own. Classes below
   are prefixed lp- so they can never collide with a site.css class. ── */

/* Breadcrumb */
.lp-bc{background:#fff;padding:11px 40px;border-bottom:1px solid var(--bd);font-size:12px;font-weight:700;color:#9aa0ad;}
.lp-bc-inner{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.lp-bc a{color:#9aa0ad;}.lp-bc a:hover{color:var(--nv);}.lp-sep{opacity:.5;}.lp-cur{color:var(--nv);}
@media(max-width:768px){.lp-bc{padding:10px 20px;}}

/* Page wrapper + two-column layout */
.lp-page{max-width:1200px;margin:0 auto;padding:0 40px 64px;}
.lp-layout{display:grid;grid-template-columns:1fr 360px;gap:32px;align-items:start;}
@media(max-width:900px){.lp-layout{grid-template-columns:1fr;}}
@media(max-width:768px){.lp-page{padding:0 20px 48px;}}

/* Hero — same rotated rounded-card blobs as the homepage hero, tinted to
   this listing's category rather than the fixed purple/green/pink the
   homepage and hub pages use, so each listing still reads as itself. */
.lp-hero{position:relative;overflow:hidden;background:${cat.tint};padding:56px 40px 68px;}
.lp-hero .blob1{background:#fff;}
.lp-hero .blob2{background:rgba(255,255,255,.6);}
.lp-hero .blob3{background:${cat.colour};opacity:.3;}
.lp-pin{position:absolute;bottom:-24px;left:40px;width:56px;height:56px;background:#fff;border-radius:16px;display:flex;align-items:center;justify-content:center;z-index:10;box-shadow:0 4px 16px rgba(30,42,68,.16);}
.lp-pin .ti{font-size:26px;color:${cat.colour};}
@media(max-width:768px){.lp-hero{padding:40px 20px 52px;}.lp-pin{left:20px;}}

/* Main column cards */
.lp-hd{background:#fff;border:1px solid var(--bd);border-radius:20px;padding:44px 28px 28px;margin-bottom:16px;box-shadow:0 4px 16px rgba(30,42,68,.06);}
.lp-eyebrow{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:${cat.colour};margin-bottom:8px;}
h1{font-weight:800;font-size:clamp(22px,3.5vw,36px);line-height:1.1;color:var(--nv);margin-bottom:8px;}
.lp-provider-row{font-size:14px;color:#767c8c;display:flex;align-items:center;gap:8px;margin-bottom:20px;}
.lp-badge{background:var(--nv);color:#fff;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:999px;}
.lp-facts{display:grid;grid-template-columns:1fr 1fr;border:1.5px solid var(--bd);border-radius:14px;overflow:hidden;margin-bottom:16px;}
.lp-fact{padding:12px 16px;border-right:1.5px solid var(--bd);border-bottom:1.5px solid var(--bd);}
.lp-fact:nth-child(2n){border-right:none;}.lp-fact:nth-child(3),.lp-fact:nth-child(4){border-bottom:none;}
.lp-fact-l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#aaa;display:flex;align-items:center;gap:4px;margin-bottom:4px;}
.lp-fact-l .ti{color:${cat.colour};font-size:12px;}
.lp-fact-v{font-size:13px;font-weight:700;color:var(--nv);line-height:1.35;}
.lp-startdate{background:${cat.tint};border-radius:12px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.lp-startdate-l{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--nv);opacity:.7;margin-bottom:2px;}
.lp-startdate-d{font-weight:800;font-size:18px;color:var(--nv);}
.lp-startdate .ti{font-size:26px;color:var(--nv);opacity:.5;}
.lp-cta{display:block;width:100%;background:${cat.colour};color:#fff;border:none;border-radius:999px;padding:15px;font-weight:700;font-size:15px;text-align:center;text-decoration:none;cursor:pointer;margin-bottom:10px;transition:opacity .15s;}
.lp-cta:hover{opacity:.88;}
.lp-cta[disabled]{opacity:.5;cursor:default;}
.lp-cta-ghost{display:block;width:100%;background:transparent;color:var(--nv);border:1.5px solid var(--bd);border-radius:999px;padding:12px;font-family:'Nunito',sans-serif;font-size:13px;font-weight:700;text-align:center;cursor:not-allowed;opacity:.5;}
.lp-card{background:#fff;border:1px solid var(--bd);border-radius:20px;padding:24px 28px;margin-bottom:16px;}
.lp-card-l{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${cat.colour};margin-bottom:12px;}
.lp-about{font-size:15px;line-height:1.7;color:#3f4557;white-space:pre-line;}
.lp-weeks{display:flex;flex-direction:column;gap:8px;}
.lp-week{background:var(--pg);border:1px solid var(--bd);border-radius:10px;padding:9px 14px;}
.lp-week-p{font-size:13px;font-weight:700;color:var(--nv);}.lp-week-s{font-size:11px;color:#888;margin-top:2px;}
.lp-cost{font-weight:800;font-size:32px;color:var(--nv);line-height:1;}
.lp-cost-note{font-size:13px;color:#888;margin-top:4px;margin-bottom:14px;}
.lp-cost-extra{background:var(--pg);border-radius:10px;padding:12px 14px;font-size:13px;color:#3f4557;line-height:1.55;white-space:pre-line;}
.lp-loc{display:flex;gap:14px;align-items:flex-start;}
.lp-loc-icon{width:90px;min-width:90px;height:72px;background:var(--grl);border-radius:14px;display:flex;align-items:center;justify-content:center;color:var(--gr);font-size:28px;}
.lp-loc-text{font-size:14px;color:#3f4557;line-height:1.55;margin-bottom:8px;}
.lp-loc-link{color:var(--sk);font-size:13px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:4px;}

/* Sidebar column */
.lp-box{background:var(--nv);border-radius:20px;padding:20px 22px;display:flex;flex-direction:column;margin-bottom:16px;}
.lp-box-row{padding:11px 0;border-bottom:1px solid rgba(255,255,255,.1);}.lp-box-row:last-child{border-bottom:none;}
.lp-box-l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.5);margin-bottom:4px;}
.lp-box-v{font-size:14px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px;}
.lp-box-v a{color:#fff;text-decoration:underline;text-underline-offset:2px;}
.lp-box-v--ig{color:#F4A7C3;}.lp-box-n{font-weight:400;color:rgba(255,255,255,.75);font-size:13px;line-height:1.5;}
.lp-invite{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.lp-invite-btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:13px;border-radius:12px;font-size:13px;font-weight:700;text-decoration:none;border:none;cursor:pointer;font-family:'Nunito',sans-serif;}
.lp-invite-btn--wa{background:#25D366;color:#fff;}.lp-invite-btn--em{background:var(--pg);color:var(--nv);}
.lp-explore{background:#fff;border:1px solid var(--bd);border-radius:20px;padding:20px 22px;}
.lp-explore-l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#aaa;margin-bottom:12px;}
.lp-explore-ls{display:flex;flex-direction:column;gap:10px;}
.lp-explore-a{color:var(--sk);font-size:14px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:5px;}

.lp-badge-neuro{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:999px;font-size:.78rem;font-weight:700;background:var(--pul);color:var(--pu);border:1.5px solid var(--pu);margin-bottom:10px;}
.lp-fb-banner{background:#FFF7E8;border:2px solid #D9971E;border-radius:16px;padding:20px 24px;margin-bottom:24px;}
.lp-fb-banner-t{font-size:1.15rem;font-weight:800;color:#8a5f0f;margin-bottom:6px;}
.lp-fb-banner-p{font-size:.92rem;color:#6b4a0c;line-height:1.6;margin:0;}
.lp-done-banner{background:var(--pg);border-color:var(--bd);}.lp-done-banner .lp-fb-banner-t{color:var(--nv);}.lp-done-banner .lp-fb-banner-p{color:#3f4557;}
.lp-mo-ribbon{background:var(--nv);color:#fff;text-align:center;font-family:'Baloo 2',sans-serif;font-weight:700;font-size:.92rem;letter-spacing:.01em;padding:11px 16px;display:flex;align-items:center;justify-content:center;gap:8px;}
.lp-mo-ribbon .ti{font-size:1.05rem;}
.lp-sibling-link{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;background:var(--pg);border-radius:12px;text-decoration:none;color:var(--nv);font-weight:600;font-size:.88rem;margin-top:10px;}
.lp-sibling-link .lp-avail{font-size:.74rem;color:var(--gr);font-weight:700;white-space:nowrap;}
.lp-sibling-link .lp-full{font-size:.74rem;color:#8a5f0f;font-weight:700;white-space:nowrap;}
</style>
</head>
<body data-listing-id="${esc(record.id)}" data-listing-name="${esc(name)}" data-provider="${esc(provider)}" data-listing-type="${listingType}">
${membersOnlyRibbon}
${SITE_NAV}

<nav class="lp-bc" aria-label="Breadcrumb">
<div class="lp-bc-inner">
${trailHTML(listingTrail(county, area, section), name)}
</div>
</nav>

<div class="hero lp-hero">
<div class="blob blob1"></div><div class="blob blob2"></div><div class="blob blob3"></div>
<div class="lp-pin"><i class="ti ${cat.icon}"></i></div>
</div>

<div class="lp-page">
<div class="lp-layout">

<!-- MAIN COLUMN -->
<div class="main-col">
<div class="lp-hd">
<div class="lp-eyebrow">${esc(category)}</div>
${isNeurodivergent ? `<div class="lp-badge-neuro">🧠 Neurodivergent-Friendly</div>` : ''}
<h1>${esc(name.toLowerCase().startsWith(provider.toLowerCase().split(' ')[0].toLowerCase()) ? name : provider + ' — ' + name)}</h1>
<div class="lp-provider-row">${esc(provider)}<span class="lp-badge">Sortd Listed</span></div>
<div class="lp-facts">
<div class="lp-fact"><div class="lp-fact-l"><i class="ti ti-calendar-event"></i> Days</div><div class="lp-fact-v">${esc(daysFirst||'Mon–Fri')}</div></div>
<div class="lp-fact"><div class="lp-fact-l"><i class="ti ti-users"></i> Ages</div><div class="lp-fact-v">${esc(agesDisplay)}</div></div>
<div class="lp-fact"><div class="lp-fact-l"><i class="ti ti-currency-euro"></i> Cost</div><div class="lp-fact-v">${esc(costFirst||'See provider')}</div></div>
<div class="lp-fact"><div class="lp-fact-l"><i class="ti ti-map-pin"></i> Location</div><div class="lp-fact-v">${esc(area)}, ${esc(county)}</div></div>
</div>
${archivedBanner}
${fullyBookedBanner}
${nextStart && !isFullyBooked && !archived ? `<div class="lp-startdate"><div><div class="lp-startdate-l">Next start date</div><div class="lp-startdate-d">${esc(nextStart)}</div></div><i class="ti ti-calendar-check"></i></div>` : ''}
${bookingUrl ? `<a href="${esc(bookingUrl)}" target="_blank" rel="noopener" class="lp-cta bb" data-track="booking">${bookBtnLabel}</a>` : archived ? '' : `<button class="lp-cta" disabled>Contact provider to book</button>`}
${archived ? '' : '<button class="lp-cta-ghost" disabled>Send enquiry — coming soon</button>'}
</div>

<div class="lp-card">
<div class="lp-card-l">About this camp</div>
<p class="lp-about">${esc(description)}</p>
</div>

<div class="lp-card">
<div class="lp-card-l">${archived ? 'When it ran' : 'Weeks available'}</div>
<div class="lp-weeks">${weeksHtml}</div>
</div>

<div class="lp-card">
<div class="lp-card-l">Cost</div>
<div class="lp-cost">${esc(costFirst||'—')}</div>
<div class="lp-cost-note">per child${timesFirst ? ' · '+esc(timesFirst) : ''}</div>
${costNote ? `<div class="lp-cost-extra">${esc(costNote)}</div>` : ''}
</div>

<div class="lp-card">
<div class="lp-card-l">Location</div>
<div class="lp-loc">
<div class="lp-loc-icon"><i class="ti ti-map-pin"></i></div>
<div>
<div class="lp-loc-text">${locLines || esc(area+', '+county)}</div>
<a href="https://maps.google.com/?q=${mapsQ}" target="_blank" rel="noopener" class="lp-loc-link">Get directions <i class="ti ti-external-link"></i></a>
</div>
</div>
</div>
${siblingsHtml}
</div>

<!-- SIDEBAR COLUMN -->
<div class="sidebar">
<div class="lp-box">
<div class="lp-card-l" style="color:#F4A7C3">How to book</div>
${bookingUrl ? `<div class="lp-box-row"><div class="lp-box-l">Book online</div><div class="lp-box-v"><i class="ti ti-external-link"></i><a href="${esc(bookingUrl)}" target="_blank" rel="noopener">${esc(bookingHostname)}</a></div></div>` : ''}
${igHandle ? `<div class="lp-box-row"><div class="lp-box-l">Instagram</div><div class="lp-box-v lp-box-v--ig"><i class="ti ti-brand-instagram"></i><a href="${esc(instagram)}" target="_blank" rel="noopener">@${esc(igHandle)}</a></div></div>` : ''}
${booking ? `<div class="lp-box-row"><div class="lp-box-l">How to book</div><div class="lp-box-v lp-box-n">${esc(booking)}</div></div>` : ''}
</div>

<div class="lp-card">
<div class="lp-card-l">Invite a friend</div>
<div class="lp-invite">
<a href="https://wa.me/?text=${waText}" target="_blank" rel="noopener" class="lp-invite-btn lp-invite-btn--wa"><i class="ti ti-brand-whatsapp"></i> WhatsApp</a>
<a href="mailto:?subject=Found%20this%20on%20sortd&body=${emailBody}" class="lp-invite-btn lp-invite-btn--em"><i class="ti ti-mail"></i> Email</a>
</div>
</div>

<div class="note" style="background:#fff;border:1px solid var(--bd);border-radius:20px;padding:20px 22px;margin-bottom:16px;color:${cat.colour};">${archived ? 'finished for now — more camps coming up ↗' : caveat}</div>

<div class="lp-explore">
<div class="lp-explore-l">Explore more</div>
<div class="lp-explore-ls">
<a href="${hubPath}?text=${encodeURIComponent(category)}" class="lp-explore-a"><i class="ti ti-arrow-right"></i> All ${esc(category)} ${section==='classes'?'classes':'camps'} in ${esc(county)}</a>
<a href="${hubPath}?q=${encodeURIComponent(area||county)}" class="lp-explore-a"><i class="ti ti-arrow-right"></i> All ${section==='classes'?'classes':'camps'} in ${esc(area||county)}</a>
${ageKey ? `<a href="${hubPath}?age=${ageKey}" class="lp-explore-a"><i class="ti ti-arrow-right"></i> ${section==='classes'?'Classes':'Camps'} for ages ${esc(agesDisplay)}</a>` : ''}
<a href="${hubPath}" class="lp-explore-a"><i class="ti ti-arrow-right"></i> Back to all ${section==='classes'?'weekly classes':'camps'}</a>
</div>
</div>
</div>

</div>
</div>

${SITE_FOOTER}
</body>
</html>`;
}

// ============================================================
// SCHOOL HUB PAGES (added 2026-09-29 — pilot, St Oliver Plunkett NS only.
// Redesigned same day per Rachel: these are NOT weekly-class listings —
// a school-linked activity gets no individual /camps or /classes page,
// no camps-data.js search entry, and no sitemap/manifest camp entry. It
// exists ONLY as a card on its school's hub page. See the main handler
// loop below for where a Schools-tagged record gets diverted out of the
// normal per-listing pipeline entirely.)
//
// One static page per distinct value in the Schools field, at
// /schools/{slug}.html, listing every currently Live, non-expired
// activity tied to that school. New URL scheme, separate from /camps and
// /weekly-classes: a school page is a self-contained directory (like
// stops.ie's own after-school activities page), not a jumping-off point
// to individual bookable listings.
//
// Card markup deliberately mirrors listingCard() in js/search.js (same
// class names: camp-card/card-img/card-status/card-body/card-cat/
// card-name/card-prov/card-meta/cm/card-cost) so these cards render
// pixel-consistent with every other listing card on the site, using the
// same rules already in /css/site.css — no new card CSS needed here. The
// one deliberate difference: no "Find out more" link to a detail page —
// there isn't one — instead the card itself carries how to book (an
// email link when there's a BookingUrl, otherwise the Booking text).
// ============================================================
function schoolActivityCard(a) {
const cat = categoryStyle(a.category);
const ageStr = a.ageMin!=null && a.ageMax!=null ? `Ages ${a.ageMin}–${a.ageMax}` : a.ageMin!=null ? `Ages ${a.ageMin}+` : '';
const daysFirst = (a.days||'').split('\n')[0].trim();
const timesFirst = (a.times||'').split('\n')[0].trim();
const costFirst = (a.cost||'').split('\n')[0].trim();
let bookingHtml = '';
if (a.bookingUrl) {
const label = a.bookingUrl.startsWith('mailto:') ? 'Email to book ↗' : 'Find out more ↗';
bookingHtml = `<a href="${esc(a.bookingUrl)}" class="card-link">${label}</a>`;
} else if (a.booking) {
bookingHtml = `<p style="font-size:.78rem;color:#888;margin:8px 0 0;line-height:1.5;">${esc(a.booking)}</p>`;
}
return `<div class="camp-card">
<div class="card-img" style="background:${cat.tint}">
<div class="card-status s-open">RUNNING</div>
</div>
<div class="card-body">
${a.category?`<div class="card-cat" style="color:${cat.colour}">${esc(a.category)}</div>`:''}
<div class="card-name">${esc(a.name)}</div>
${a.provider && a.provider!==a.name?`<div class="card-prov">${esc(a.provider)}</div>`:''}
<div class="card-meta">
${ageStr?`<span class="cm">${esc(ageStr)}</span>`:''}
${daysFirst?`<span class="cm">📅 ${esc(daysFirst)}</span>`:''}
${timesFirst?`<span class="cm">${esc(timesFirst.substring(0,20))}</span>`:''}
</div>
${costFirst?`<div class="card-cost">${esc(costFirst.substring(0,30))}</div>`:''}
${bookingHtml}
</div></div>`;
}

function generateSchoolPageHTML(schoolName, schoolActivities) {
const schoolSlug = makeSchoolSlug(schoolName);
const pageUrl = `${BASE_URL}/schools/${schoolSlug}`;
const count = schoolActivities.length;
const cardsHtml = count
? schoolActivities.map(schoolActivityCard).join('\n')
: '<p class="sch-empty">Nothing listed here yet — check back soon.</p>';
const metaDesc = `After-school clubs and activities at ${schoolName}, open to pupils only. ${count} ${count===1?'activity':'activities'} currently listed on sortd.`;

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-HHTB7S9WJG"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-HHTB7S9WJG');
</script>
<script src="/js/booking-tracking.js" defer></script>
<script src="/js/newsletter-signup.js" defer></script>
<script src="/js/account.js" defer></script>
<title>${esc(schoolName)} — After-School Activities | sortd</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${esc(schoolName+' — After-School Activities | sortd')}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:wght@400;600;700&family=Caveat:wght@600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
<!-- Shared site stylesheet — same nav/footer/tokens/.camp-card as the
     homepage and every listing page, so a school page is never its own
     island. -->
<link rel="stylesheet" href="/css/site.css">
<style>
/* ── School-hub-page-only rules. Everything else (nav, footer, popup,
   colour tokens, fonts, .camp-card) comes from /css/site.css. ── */
.sch-hero{background:var(--pg,#F7F7F7);padding:56px 40px 40px;text-align:center;}
.sch-hero h1{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:clamp(24px,4vw,38px);color:var(--nv);margin-bottom:10px;}
.sch-hero p{font-family:'Nunito',sans-serif;color:var(--nv);opacity:.75;max-width:640px;margin:0 auto;font-size:1rem;line-height:1.6;}
.sch-badge{display:inline-flex;align-items:center;gap:6px;background:var(--nv);color:#fff;border-radius:999px;padding:6px 16px;font-family:'Baloo 2',sans-serif;font-weight:700;font-size:.82rem;margin-bottom:16px;}
.sch-wrap{max-width:1180px;margin:0 auto;padding:40px;}
.sch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;}
.sch-empty{text-align:center;color:#888;padding:60px 20px;font-family:'Nunito',sans-serif;}
@media(max-width:768px){.sch-hero{padding:40px 20px 28px;}.sch-wrap{padding:24px 20px;}}
</style>
</head>
<body data-school="${esc(schoolName)}">

${SITE_NAV}

<div class="sch-hero">
<div class="sch-badge"><i class="ti ti-lock"></i> Pupils only</div>
<h1>After-school activities at ${esc(schoolName)}</h1>
<p>Everything below runs on-site and is only open to ${esc(schoolName)}'s own pupils — sign up directly with whoever's running the club, not through sortd.</p>
</div>

<div class="sch-wrap">
<div class="sch-grid">
${cardsHtml}
</div>
</div>

${SITE_FOOTER}

</body>
</html>`;
}

// ============================================================
// AREA HUB PAGES (added 2026-11-06, AI/search audit step 3)
//
// Parents search geography-first ("classes in Malahide", "camps Swords"),
// so every county and area with enough live listings gets a real,
// crawlable page with the listings in the HTML (not filled in by JS):
//
//   /dublin/                    county hub: area directory + every listing
//   /dublin/malahide/           area hub: every live listing in the area
//   /dublin/malahide/camps/     only when the area has >= HUB_MIN camps AND
//   /dublin/malahide/classes/   some of the other type (otherwise the area
//                               hub IS that page and a copy would be thin)
//
// Folder + index.html, canonical with a trailing slash — the most reliable
// pattern on Netlify. Individual listing URLs are unchanged on purpose
// (stable URLs for citations); listing pages link up to their hubs via the
// breadcrumb. Areas with fewer than HUB_MIN listings get no page of their
// own (thin pages hurt the whole site) — they're listed on the county hub.
//
// The Airtable Area field is free text (85 spellings for ~60 places as of
// 2026-11-06), so normaliseArea() maps it to a clean place name without
// touching Airtable. Cleaning the field into a dropdown would make this
// mapping mostly unnecessary.
// ============================================================
const HUB_MIN = 3;
const RESERVED_AREA_SLUGS = new Set(['camps','classes','northside','southside','city']);
const AREA_ALIASES = {
'dublin 1':'City Centre','dublin 2':'City Centre','temple bar':'City Centre','dublin city':'City Centre',
'dun laoghaire':'Dún Laoghaire','dún laoghaire':'Dún Laoghaire',
'dublin 15':'Blanchardstown','corduff':'Blanchardstown',
'porterstown':'Castleknock',
'dublin city centre':'City Centre','ilac centre':'City Centre','north inner city':'City Centre',
'fassaugh avenue':'Cabra','dublin 18':'Sandyford','rathfarnham village':'Rathfarnham','ongar village':'Ongar',
};
function slugifyPlace(s) {
return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}
// "Clontarf, Dublin 3 (Dublin City)" -> Clontarf; "Fingal (Balbriggan)" ->
// Balbriggan; "Stillorgan/Leopardstown, DLR" -> Stillorgan; a listing that
// spans several places ("South Dublin & Dublin City (Tallaght, ...)") -> null.
function normaliseArea(raw) {
let s = String(raw||'').trim();
if (!s) return null;
const fingal = s.match(/^fingal\s*\(\s*([^,)]+)/i);
if (fingal) s = fingal[1];
if (/\s&\s/.test(s) || /^multiple sites/i.test(s)) return null;
let first = s.split(/[,(\/]/)[0].trim();
if (!first) return null;
const alias = AREA_ALIASES[first.toLowerCase()];
let name = alias || first.replace(/\s+/g,' ');
if (name === name.toLowerCase()) name = name.replace(/\b\w/g, ch => ch.toUpperCase()); // "malahide" -> "Malahide
let slug = slugifyPlace(name);
if (!slug) return null;
if (RESERVED_AREA_SLUGS.has(slug)) slug += '-area';
return { name, slug };
}

// Built once per run in the handler (buildHubIndex) and read by the listing
// templates for their breadcrumbs, so a breadcrumb only ever links to a hub
// page that this same run is generating.
let HUB_INDEX = { counties: {} };
function buildHubIndex(entries) {
// entries: [{ county, area, type: 'camp'|'weekly' }] for live, non-school listings
const idx = { counties: {} };
for (const e of entries) {
if (!e.county) continue;
const cSlug = makeCountySlug(e.county);
const c = idx.counties[cSlug] = idx.counties[cSlug] || { name: e.county, slug: cSlug, count: 0, areas: {} };
c.count++;
const a = normaliseArea(e.area);
if (!a) continue;
const area = c.areas[a.slug] = c.areas[a.slug] || { name: a.name, slug: a.slug, count: 0, camps: 0, classes: 0 };
area.count++;
if (e.type === 'weekly') area.classes++; else area.camps++;
}
for (const c of Object.values(idx.counties)) {
c.hasHub = c.count >= HUB_MIN;
for (const a of Object.values(c.areas)) {
a.hasHub = c.hasHub && a.count >= HUB_MIN;
a.hasCampsPage = a.hasHub && a.camps >= HUB_MIN && a.classes > 0;
a.hasClassesPage = a.hasHub && a.classes >= HUB_MIN && a.camps > 0;
}
}
return idx;
}
const countyHubPath = c => `/${c.slug}/`;
const areaHubPath = (c, a) => `/${c.slug}/${a.slug}/`;

// Breadcrumb trail for a listing page: sortd > County > Area > [Camps|Classes]
// — each level only if its hub page exists. Returns [{name, path}].
function listingTrail(county, rawArea, section) {
const trail = [{ name: 'sortd', path: '/' }];
const c = HUB_INDEX.counties[makeCountySlug(county||'')];
if (!c || !c.hasHub) {
trail.push(section === 'classes' ? { name: 'Classes', path: '/weekly-classes' } : { name: 'Camps', path: '/camps' });
return trail;
}
trail.push({ name: c.name, path: countyHubPath(c) });
const n = normaliseArea(rawArea);
const a = n && c.areas[n.slug];
if (a && a.hasHub) {
trail.push({ name: a.name, path: areaHubPath(c, a) });
if (section === 'classes' && a.hasClassesPage) trail.push({ name: 'Classes', path: `${areaHubPath(c, a)}classes/` });
if (section !== 'classes' && a.hasCampsPage) trail.push({ name: 'Camps', path: `${areaHubPath(c, a)}camps/` });
}
return trail;
}
function trailHTML(trail, currentName) {
return trail.map(t => `<a href="${esc(t.path)}">${esc(t.name)}</a><span class="lp-sep">›</span>`).join('\n') + `\n<span class="lp-cur">${esc(currentName)}</span>`;
}
function breadcrumbJsonLd(trail, currentName, currentUrl) {
const items = trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: BASE_URL + t.path }));
items.push({ '@type': 'ListItem', position: items.length + 1, name: currentName, item: currentUrl });
return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items }).replace(/</g,'\\u003c')}<\/script>`;
}

// Static version of js/search.js's listingCard() — same class names and
// rotating pastel bands, so hub cards look identical to /camps results.
const HUB_COLS = [{bg:'#CFE8F6',ink:'#3D77A3'},{bg:'#C9F0DA',ink:'#1D8A52'},{bg:'#E7E1F8',ink:'#5B4FCA'},{bg:'#FBE1EB',ink:'#C6567F'}];
function hubCard(c, i, showType) {
const col = HUB_COLS[i % HUB_COLS.length];
const ageStr = c.ageMin!=null && c.ageMax!=null ? `Ages ${c.ageMin}–${c.ageMax}` : c.ageMin!=null ? `Ages ${c.ageMin}+` : '';
const isWait = c.availability === 'Waitlist';
const isLimited = c.availability === 'Limited spaces';
const weeksStr = (c.weeks||[]).slice(0,2).join(', ');
const first = (s, n) => String(s||'').split('\n')[0].substring(0, n);
const clip = (s, n) => s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
return `<div class="camp-card">
<div class="card-img" style="background:${col.bg}"><div class="card-status ${isWait?'s-wait':isLimited?'s-limited':'s-open'}">${isWait?'WAITLIST':isLimited?'LIMITED SPACES':'LIVE NOW'}</div>
<button class="card-save" data-save-id="${esc(c.id)}" aria-label="Save for later" aria-pressed="false" onclick="event.preventDefault();window.SortdSaved&&window.SortdSaved.toggle('${esc(c.id)}',this);"><i class="ti ti-heart"></i></button></div>
<div class="card-body">
${c.category?`<div class="card-cat" style="color:${col.ink}">${esc(c.category)}</div>`:''}
<h3 class="card-name">${esc(c.name)}</h3>
${c.provider && c.provider!==c.name?`<div class="card-prov">${esc(c.provider)}</div>`:''}
<div class="card-meta">${showType?`<span class="cm cm-type">${c.type==='weekly'?'Class':'Camp'}</span>`:''}${ageStr?`<span class="cm">${esc(ageStr)}</span>`:''}${c.area?`<span class="cm">📍 ${esc(first(c.area, 40))}</span>`:''}${c.days?`<span class="cm">${esc(first(c.days,18))}</span>`:''}${c.times?`<span class="cm">${esc(first(c.times,20))}</span>`:''}${weeksStr?`<span class="cm">${esc(weeksStr)}</span>`:''}</div>
${c.cost?`<div class="card-cost">${esc(clip(String(c.cost).split('\n')[0], 32))}</div>`:''}
<a href="${esc(c.listingUrl)}" class="card-link">Find out more ↗</a>
</div></div>`;
}

const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
function joinList(xs) { return xs.length <= 1 ? (xs[0]||'') : `${xs.slice(0,-1).join(', ')} and ${xs[xs.length-1]}`; }
// One- or two-sentence plain-English summary at the top of each hub — the
// direct answer an AI assistant or a search snippet can quote.
function hubSummary(items, placeLabel) {
const camps = items.filter(i => i.type !== 'weekly').length;
const classes = items.length - camps;
const kinds = [classes ? `${classes} weekly ${classes===1?'class':'classes'}` : '', camps ? `${camps} holiday ${camps===1?'camp':'camps'}` : ''].filter(Boolean);
const catCounts = {};
for (const i of items) if (i.category) catCounts[i.category] = (catCounts[i.category]||0) + 1;
const topCats = Object.entries(catCounts).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).map(([c]) => c.toLowerCase());
const cats = topCats.length > 4 ? `${topCats.slice(0,4).join(', ')} and more` : joinList(topCats);
const mins = items.map(i => i.ageMin).filter(n => typeof n === 'number');
const maxs = items.map(i => i.ageMax).filter(n => typeof n === 'number');
const ages = mins.length && maxs.length ? ` for ages ${Math.min(...mins)} to ${Math.max(...maxs)}` : '';
const days = DAY_NAMES.filter(d => items.some(i => new RegExp(d.slice(0,3), 'i').test(i.days||'')));
const daysTxt = days.length >= 2 ? ` Activities run on ${days.length === 7 ? 'every day of the week' : joinList(days)}.` : '';
return `Sortd lists ${joinList(kinds)} for children in ${placeLabel}${cats ? `, covering ${cats}` : ''}${ages}.${daysTxt} Every listing is checked by hand; confirm the details with the provider before booking.`;
}
function groupByCategory(items) {
const groups = {};
for (const i of items) (groups[i.category || 'Other'] = groups[i.category || 'Other'] || []).push(i);
return Object.entries(groups).sort((a,b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}
const byName = (a, b) => a.name.localeCompare(b.name);

function hubPageHTML({ title, h1, eyebrow, summary, canonicalPath, trail, bodyHtml, listingUrls, metaDesc }) {
const pageUrl = BASE_URL + canonicalPath;
const ld = {
'@context': 'https://schema.org', '@type': 'CollectionPage', name: h1, description: metaDesc, url: pageUrl,
isPartOf: { '@type': 'WebSite', name: 'sortd', url: BASE_URL },
mainEntity: { '@type': 'ItemList', numberOfItems: listingUrls.length, itemListElement: listingUrls.map((u, i) => ({ '@type': 'ListItem', position: i + 1, url: BASE_URL + u })) },
};
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-HHTB7S9WJG"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-HHTB7S9WJG');
</script>
<script src="/js/booking-tracking.js" defer></script>
<script src="/js/newsletter-signup.js" defer></script>
<script src="/js/account.js" defer></script>
<script src="/js/saved.js" defer></script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}<\/script>
${breadcrumbJsonLd(trail, h1, pageUrl)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:wght@400;600;700&family=Caveat:wght@600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
<link rel="stylesheet" href="/css/site.css">
<style>
/* Hub-page-only rules. Nav, footer, tokens and .camp-card come from /css/site.css. */
.hub-bc{background:#fff;padding:11px 40px;border-bottom:1px solid var(--bd);font-size:12px;font-weight:700;color:#9aa0ad;}
.hub-bc-inner{max-width:1180px;margin:0 auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.hub-bc a{color:#9aa0ad;}.hub-bc a:hover{color:var(--nv);}.hub-bc .lp-sep{opacity:.5;}.hub-bc .lp-cur{color:var(--nv);}
.hub-hero{background:#fff;border-bottom:1px solid var(--bd);padding:44px 40px 36px;}
.hub-hero-inner{max-width:1180px;margin:0 auto;}
.hub-eyebrow{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--sk);margin-bottom:8px;}
.hub-hero h1{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:clamp(26px,4vw,40px);line-height:1.1;color:var(--nv);margin:0 0 12px;}
.hub-summary{font-size:1rem;line-height:1.65;color:#3f4557;max-width:760px;margin:0;}
.hub-wrap{max-width:1260px;margin:0 auto;padding:32px 40px 56px;}
.hub-chips{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 0;}
.hub-chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1.5px solid var(--bd);border-radius:999px;padding:7px 14px;font-weight:700;font-size:.86rem;color:var(--nv);text-decoration:none;}
.hub-chip:hover{border-color:var(--nv);}
.hub-chip span{font-weight:600;color:#888;font-size:.8rem;}
.hub-sec{margin-top:36px;}
.hub-sec:first-child{margin-top:0;}
.hub-sec h2{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:1.45rem;color:var(--nv);margin:0 0 14px;}
.hub-sec h2 small{font-family:'Nunito',sans-serif;font-weight:600;font-size:.9rem;color:#888;margin-left:6px;}
.hub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;}
.hub-grid .card-name{margin:0;}
.hub-list{list-style:none;padding:0;margin:0;columns:2 320px;column-gap:32px;}
.hub-list li{break-inside:avoid;padding:7px 0;border-bottom:1px solid var(--bd);font-size:.92rem;line-height:1.45;color:#3f4557;}
.hub-list li b{color:var(--nv);}
.hub-list a{color:var(--sk);font-weight:700;text-decoration:none;}
.hub-more{background:#fff;border:1px solid var(--bd);border-radius:20px;padding:22px 24px;display:flex;flex-wrap:wrap;gap:10px 24px;align-items:center;}
.hub-more a{color:var(--sk);font-weight:700;text-decoration:none;}
.hub-src{font-size:.82rem;color:#888;margin-top:28px;}
@media(max-width:768px){.hub-bc{padding:10px 20px;}.hub-hero{padding:36px 20px 28px;}.hub-wrap{padding:24px 20px 44px;}}
</style>
</head>
<body data-hub="${esc(canonicalPath)}">

${SITE_NAV}

<nav class="hub-bc" aria-label="Breadcrumb"><div class="hub-bc-inner">
${trailHTML(trail, h1)}
</div></nav>

<header class="hub-hero"><div class="hub-hero-inner">
<div class="hub-eyebrow">${esc(eyebrow)}</div>
<h1>${esc(h1)}</h1>
<p class="hub-summary">${esc(summary)}</p>
</div></header>

<main class="hub-wrap">
${bodyHtml}
<p class="hub-src">Listings come from each provider's own information and are checked by hand by Sortd. Confirm details with the provider before booking.</p>
</main>

${SITE_FOOTER}

</body>
</html>`;
}

function kindLabel(items) {
const camps = items.some(i => i.type !== 'weekly'), classes = items.some(i => i.type === 'weekly');
return camps && classes ? 'classes and camps' : camps ? 'camps' : 'classes';
}

// Returns { '/dublin/index.html': html, ... } plus manifest-style entries.
function buildHubPages(listings) {
const out = {}; const entries = [];
for (const c of Object.values(HUB_INDEX.counties)) {
if (!c.hasHub) continue;
const inCounty = listings.filter(l => makeCountySlug(l.county||'') === c.slug).sort(byName);
const areaItems = {}; const loose = {};
for (const l of inCounty) {
const n = normaliseArea(l.area);
const a = n && c.areas[n.slug];
if (a && a.hasHub) (areaItems[a.slug] = areaItems[a.slug] || []).push(l);
else { const key = n ? n.name : `Across ${c.name}`; (loose[key] = loose[key] || []).push(l); }
}
const hubAreas = Object.values(c.areas).filter(a => a.hasHub).sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
const areaChips = hubAreas.map(a => `<a class="hub-chip" href="${areaHubPath(c, a)}">${esc(a.name)} <span>${a.count}</span></a>`).join('\n');

// ── Area hubs (and their camps/classes sub-pages) ──
for (const a of hubAreas) {
const items = areaItems[a.slug] || [];
const place = `${a.name}, Co. ${c.name}`;
const kinds = kindLabel(items);
const otherAreas = hubAreas.filter(o => o.slug !== a.slug).map(o => `<a class="hub-chip" href="${areaHubPath(c, o)}">${esc(o.name)} <span>${o.count}</span></a>`).join('\n');
const subLinks = [a.hasCampsPage ? `<a class="hub-chip" href="${areaHubPath(c, a)}camps/">Camps in ${esc(a.name)} <span>${a.camps}</span></a>` : '', a.hasClassesPage ? `<a class="hub-chip" href="${areaHubPath(c, a)}classes/">Classes in ${esc(a.name)} <span>${a.classes}</span></a>` : ''].join('');
const mixed = items.some(i => i.type === 'weekly') && items.some(i => i.type !== 'weekly');
let n = 0;
const sections = groupByCategory(items).map(([cat, its]) => `<section class="hub-sec"><h2>${esc(cat)} in ${esc(a.name)}<small>${its.length}</small></h2><div class="hub-grid">${its.map(i => hubCard(i, n++, mixed)).join('\n')}</div></section>`).join('\n');
const body = `${subLinks ? `<div class="hub-chips" style="margin:0 0 8px;">${subLinks}</div>` : ''}
${sections}
<section class="hub-sec"><h2>More in ${esc(c.name)}</h2>
<div class="hub-more"><a href="${countyHubPath(c)}">Everything in ${esc(c.name)} →</a><a href="/whats-on">Days out &amp; what's on →</a><a href="/camps?q=${encodeURIComponent(a.name)}">Search camps near ${esc(a.name)} →</a><a href="/weekly-classes?q=${encodeURIComponent(a.name)}">Search classes near ${esc(a.name)} →</a></div>
${otherAreas ? `<div class="hub-chips">${otherAreas}</div>` : ''}</section>`;
const h1 = `Kids' ${kinds} in ${a.name}`;
const summary = hubSummary(items, place);
const path = areaHubPath(c, a);
out[`${path}index.html`] = hubPageHTML({
title: `${h1}, ${c.name} | sortd`, h1, eyebrow: `${c.name} · ${a.name}`, summary,
metaDesc: summary.length > 158 ? summary.slice(0, 157) + '…' : summary,
canonicalPath: path, trail: [{ name: 'sortd', path: '/' }, { name: c.name, path: countyHubPath(c) }],
bodyHtml: body, listingUrls: items.map(i => i.listingUrl),
});
entries.push({ section: 'hub', name: h1, url: BASE_URL + path, file: `${path}index.html` });

for (const [kind, flag, filter, word] of [['camps', a.hasCampsPage, i => i.type !== 'weekly', 'camps'], ['classes', a.hasClassesPage, i => i.type === 'weekly', 'classes']]) {
if (!flag) continue;
const sub = items.filter(filter);
let m = 0;
const subSections = groupByCategory(sub).map(([cat, its]) => `<section class="hub-sec"><h2>${esc(cat)} ${word} in ${esc(a.name)}<small>${its.length}</small></h2><div class="hub-grid">${its.map(i => hubCard(i, m++, false)).join('\n')}</div></section>`).join('\n');
const subPath = `${path}${kind}/`;
const subH1 = `Kids' ${word} in ${a.name}`;
const subSummary = hubSummary(sub, place);
out[`${subPath}index.html`] = hubPageHTML({
title: `${subH1}, ${c.name} | sortd`, h1: subH1, eyebrow: `${c.name} · ${a.name} · ${kind === 'camps' ? 'Camps' : 'Classes'}`, summary: subSummary,
metaDesc: subSummary.length > 158 ? subSummary.slice(0, 157) + '…' : subSummary,
canonicalPath: subPath, trail: [{ name: 'sortd', path: '/' }, { name: c.name, path: countyHubPath(c) }, { name: a.name, path }],
bodyHtml: `${subSections}<section class="hub-sec"><div class="hub-more"><a href="${path}">Everything in ${esc(a.name)} →</a><a href="${countyHubPath(c)}">Everything in ${esc(c.name)} →</a></div></section>`,
listingUrls: sub.map(i => i.listingUrl),
});
entries.push({ section: 'hub', name: subH1, url: BASE_URL + subPath, file: `${subPath}index.html` });
}
}

// ── County hub ──
const areaSections = hubAreas.map(a => {
const items = areaItems[a.slug] || [];
return `<li><b><a href="${areaHubPath(c, a)}">${esc(a.name)}</a></b> — ${items.length} ${kindLabel(items)}: ${items.slice(0, 4).map(i => esc(i.name)).join(', ')}${items.length > 4 ? ', …' : ''}</li>`;
}).join('\n');
const looseKeys = Object.keys(loose).sort((x, y) => x.startsWith('Across') ? 1 : y.startsWith('Across') ? -1 : x.localeCompare(y));
const looseList = looseKeys.map(k => loose[k].map(i => `<li><b>${esc(k)}</b> — <a href="${esc(i.listingUrl)}">${esc(i.name)}</a>${i.provider && i.provider !== i.name ? `, ${esc(i.provider)}` : ''}${i.ageMin != null && i.ageMax != null ? ` (ages ${i.ageMin}–${i.ageMax})` : ''}</li>`).join('\n')).join('\n');
const cKinds = kindLabel(inCounty);
const cH1 = `Kids' ${cKinds} in ${c.name}`;
const cSummary = hubSummary(inCounty, `Co. ${c.name}`) .replace(' Every listing', ` ${hubAreas.length ? `Browse by area below, from ${joinList(hubAreas.slice(0, 3).map(a => a.name))} to ` : 'Browse '}every listing in the county. Every listing`);
const cBody = `${hubAreas.length ? `<section class="hub-sec"><h2>Browse ${esc(c.name)} by area</h2><div class="hub-chips" style="margin:0 0 18px;">${areaChips}</div><ul class="hub-list">${areaSections}</ul></section>` : ''}
${looseList ? `<section class="hub-sec"><h2>${hubAreas.length ? `More around ${esc(c.name)}` : `Everything in ${esc(c.name)}`}</h2><ul class="hub-list">${looseList}</ul></section>` : ''}
<section class="hub-sec"><h2>Days out &amp; holiday plans</h2><div class="hub-more"><a href="/whats-on">What's on for kids this month →</a><a href="/guides">Monthly guides →</a><a href="/camps">All holiday camps →</a><a href="/weekly-classes">All weekly classes →</a></div></section>`;
out[`${countyHubPath(c)}index.html`] = hubPageHTML({
title: `${cH1} by area | sortd`, h1: cH1, eyebrow: `Co. ${c.name}`, summary: cSummary,
metaDesc: cSummary.length > 158 ? cSummary.slice(0, 157) + '…' : cSummary,
canonicalPath: countyHubPath(c), trail: [{ name: 'sortd', path: '/' }],
bodyHtml: cBody, listingUrls: inCounty.map(i => i.listingUrl),
});
entries.push({ section: 'hub', name: cH1, url: BASE_URL + countyHubPath(c), file: `${countyHubPath(c)}index.html` });
}
return { files: out, entries };
}

// js/areas-data.js — consumed by the homepage's "Browse by area" chips.
// Content-only (no timestamp) so it joins the changed-vs-unchanged diff.
function buildAreasDataJs() {
const hubs = [];
for (const c of Object.values(HUB_INDEX.counties)) {
if (!c.hasHub) continue;
const areas = Object.values(c.areas).filter(a => a.hasHub).sort((a,b) => b.count - a.count || a.name.localeCompare(b.name))
.map(a => ({ name: a.name, url: areaHubPath(c, a), count: a.count }));
hubs.push({ county: c.name, url: countyHubPath(c), count: c.count, areas });
}
return `// Auto-generated by generate-listings.js — area hub pages for the homepage.\n// Do not hand-edit; change listings in Airtable instead.\nconst AREA_HUBS = ${JSON.stringify(hubs)};\n`;
}

// ============================================================
// CAMPS-DATA.JS GENERATOR (added 2026-09-22)
//
// js/camps-data.js is the hand-maintained search index consumed directly by
// index.html, camps.html and weekly-classes.html as a global LISTINGS array.
// Being hand-maintained, it had drifted from Airtable: missing ~118 weekly
// classes entirely, and referencing pre-unification URLs for the rest. This
// regenerates it fresh from the same live records every run, so search
// stays in sync with what's actually published without anyone remembering
// to update a second file by hand.
//
// IMPORTANT: no per-run timestamp goes in the header comment. This content
// is included in the SAME changed-vs-unchanged diff as the HTML pages
// (added to `files` before the changedPages check in the handler, not
// after like sitemap.xml/manifest.json) — a date that changed every day
// regardless of real content would defeat that no-op check and cause a
// pointless commit every single day, the same trap sitemap.xml deliberately
// avoids by being added after the check instead.
// ============================================================
function buildCampsDataJs(listings) {
const header = `// ── SHARED LISTINGS DATA ────────────────────────────────────────────────
// Single source of truth, included by index.html, camps.html and
// weekly-classes.html so the dataset only has to be maintained in one place.
// Auto-generated by generate-listings.js from live Airtable records — do
// not hand-edit here, changes will be overwritten on the next run. To
// change a listing, edit it in Airtable instead.
const LISTINGS = ${JSON.stringify(listings)};

const LEINSTER_COUNTIES = ['Dublin','Kildare','Meath','Wicklow','Louth','Laois','Offaly','Westmeath','Longford','Carlow','Kilkenny','Wexford'];

const WEEK_RANGES = {
'Week 1':['2026-06-29','2026-07-03'],'Week 2':['2026-07-06','2026-07-10'],'Week 3':['2026-07-13','2026-07-17'],
'Week 4':['2026-07-20','2026-07-24'],'Week 5':['2026-07-27','2026-07-31'],'Week 6':['2026-08-03','2026-08-07'],
'Week 7':['2026-08-10','2026-08-14'],'Week 8':['2026-08-17','2026-08-21'],'Week 9':['2026-08-24','2026-08-28'],
};
`;
return header;
}

// ============================================================
// SCHOOLS-DATA.JS GENERATOR (added 2026-09-29)
//
// Powers the "search by school" dropdown in index.html's hero search card
// (see renderSchoolSearch() there). One entry per distinct value in the
// Schools field — the same schoolMap already used to build each school's
// /schools/{slug}.html hub page above, so the dropdown and the pages it
// links to can never disagree about which schools exist or their URLs.
// Like camps-data.js, this has no per-run timestamp so it can safely
// participate in the changed-vs-unchanged diff that decides whether a
// commit is needed at all.
// ============================================================
function buildSchoolsDataJs(schoolMap) {
const list = Object.keys(schoolMap).sort().map(name => {
const slug = makeSchoolSlug(name);
return { name, slug, url: `${BASE_URL}/schools/${slug}` };
});
return `// ── SCHOOL HUB PAGES ────────────────────────────────────────────────────
// Powers the "search by school" dropdown in index.html's hero search card.
// Auto-generated by generate-listings.js from live Airtable records (the
// Schools field on each activity) — do not hand-edit here, changes will be
// overwritten on the next run. To add a school, tag an activity with it in
// Airtable and it appears here (and gets its own /schools/{slug} page)
// automatically.
const SCHOOLS = ${JSON.stringify(list)};
`;
}

// ============================================================
// GITHUB COMMIT (replaces the old Netlify Deploy API path — see
// UNIFICATION note at top of file)
//
// Writes generated pages straight into the sortd-site git repo using
// GitHub's low-level Git Data API, which lets many files go into a single
// atomic commit (the Contents API only does one file per commit, which
// would mean one deploy per file — much noisier and slower). Only files
// whose content actually changed are included, so a run with nothing new
// makes no commit and triggers no deploy at all.
// ============================================================
function githubHeaders(token) {
return {
Authorization: `Bearer ${token}`,
Accept: 'application/vnd.github+json',
'Content-Type': 'application/json',
'X-GitHub-Api-Version': '2022-11-28',
};
}

async function githubApi(token, method, path, body) {
const res = await fetch(`https://api.github.com${path}`, {
method,
headers: githubHeaders(token),
body: body !== undefined ? JSON.stringify(body) : undefined,
});
if (!res.ok) {
const text = await res.text().catch(() => '');
throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${text}`);
}
return res.json();
}

// Git's own blob hash: sha1("blob " + byteLength + "\0" + content). Computing
// this locally lets us compare a freshly-generated file against what's
// already committed WITHOUT downloading every existing file's content —
// we just need the tree's recorded sha for that path.
function gitBlobSha1(content) {
const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

// Reads and parses a JSON file already committed in sortd-site, by its blob
// sha from getCurrentTree. Used for the previous manifest.json (to carry
// each page's lastmod forward) and data/guides-index.json (monthly guides
// for the sitemap). Returns null on any failure — both callers treat that
// as "no previous data" rather than failing the whole run.
async function readRepoJson(token, sha) {
if (!sha) return null;
try {
const blob = await githubApi(token, 'GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${sha}`);
return JSON.parse(Buffer.from(blob.content, blob.encoding || 'base64').toString('utf8'));
} catch (e) {
console.warn(`[generate-listings] readRepoJson ${sha} failed: ${e.message}`);
return null;
}
}

// Fetches the full current tree (path -> blob sha) for the branch, plus the
// commit/tree shas needed to base a new commit on top of it.
async function getCurrentTree(token) {
const ref = await githubApi(token, 'GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`);
const latestCommitSha = ref.object.sha;
const commit = await githubApi(token, 'GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${latestCommitSha}`);
const baseTreeSha = commit.tree.sha;
const tree = await githubApi(token, 'GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${baseTreeSha}?recursive=1`);
if (tree.truncated) {
// Repo has grown past the recursive-tree size limit — fail loudly rather
// than silently diffing against an incomplete picture of what exists.
throw new Error('GitHub tree listing was truncated — repo may be too large for a single recursive fetch. Needs a paginated approach before this can run safely.');
}
const pathToSha = {};
for (const entry of tree.tree) {
if (entry.type === 'blob') pathToSha[entry.path] = entry.sha;
}
return { latestCommitSha, baseTreeSha, pathToSha };
}

// Commits only the files that actually changed, in one commit. Returns null
// (no-op, no commit made) if nothing changed. Accepts an already-fetched
// tree (from getCurrentTree) so the caller can diff against it BEFORE
// deciding whether to commit at all, without paying for a second fetch here.
//
// SPEED FIX: Netlify's synchronous function invocations have a hard wall-
// clock limit, and the first version of this used a separate POST .../git/
// blobs call per changed file before building the tree — with 100+ pages
// changing on the very first unified run, that was 100+ sequential-ish
// round trips to GitHub and blew the limit, so the function got killed
// mid-run with nothing committed (admin.html saw a truncated response:
// "Unexpected end of JSON input"). GitHub's create-tree endpoint accepts
// inline `content` per entry and creates the blob itself server-side, so
// this now makes exactly ONE tree-creation call no matter how many files
// changed.
async function commitFilesToGitHub(token, newFiles, message, prefetchedTree) {
const { latestCommitSha, baseTreeSha, pathToSha } = prefetchedTree || await getCurrentTree(token);

// GitHub tree paths never start with a leading slash.
const changed = [];
for (const [filePath, content] of Object.entries(newFiles)) {
const repoPath = filePath.replace(/^\//, '');
const newSha = gitBlobSha1(content);
if (pathToSha[repoPath] !== newSha) {
changed.push({ repoPath, content });
}
}

if (changed.length === 0) {
return null; // nothing to do — no commit, no deploy triggered
}

const treeEntries = changed.map(item => ({
path: item.repoPath,
mode: '100644',
type: 'blob',
content: item.content, // GitHub creates the blob itself from this
}));

const newTree = await githubApi(token, 'POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, {
base_tree: baseTreeSha,
tree: treeEntries,
});

const newCommit = await githubApi(token, 'POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
message,
tree: newTree.sha,
parents: [latestCommitSha],
});

// Not forced — if the branch moved since we read it (e.g. someone else
// pushed at the same moment), this fails loudly instead of clobbering
// whatever landed in between.
await githubApi(token, 'PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`, {
sha: newCommit.sha,
});

return { commitSha: newCommit.sha, filesChanged: changed.map(c => c.repoPath) };
}

// ============================================================
// HANDLER
// ============================================================
exports.handler = async (event) => {
const adminPassword = process.env.ADMIN_PASSWORD;
const githubToken = process.env.GITHUB_TOKEN;
const apiKey = process.env.AIRTABLE_API_KEY;

let body;
try { body = JSON.parse(event.body||'{}'); } catch { body = {}; }

// Netlify's Scheduled Functions invoke this handler directly with a JSON
// body of { next_run }, not via the normal public HTTP endpoint (Netlify
// docs: "Scheduled functions cannot be invoked via normal HTTP URLs").
// That means this path is only reachable by Netlify's own scheduler, so
// it's safe to skip the manual password check for it. Public/manual
// requests to this function's URL still require the password below.
const isScheduledInvocation = typeof body.next_run === 'string';

if (!isScheduledInvocation && (!adminPassword || body.password !== adminPassword)) {
return { statusCode:401, body: JSON.stringify({ error:'Unauthorised' }) };
}
if (!apiKey) return { statusCode:500, body: JSON.stringify({ error:'AIRTABLE_API_KEY not set in env vars' }) };
if (!githubToken) return { statusCode:500, body: JSON.stringify({ error:'GITHUB_TOKEN not set in env vars' }) };

const startTime = Date.now();
try {
const records = await fetchAllLiveRecords(apiKey, body.county || null);

const files = {};
const manifest = [];
const archivedManifest = []; // finished listings — see ranWhenText/archived mode
const listings = [];
const schoolMap = {};
let skipped = 0;
let skippedExpired = 0;
const todayStr = new Date().toISOString().slice(0, 10);

// Pre-pass: which county/area hub pages exist this run (live, non-school
// listings only), so listing breadcrumbs can link to them — see AREA HUB PAGES.
HUB_INDEX = buildHubIndex(records.map(r => r.fields).filter(f =>
(f[F.NAME]||'').trim() && (f[F.PROVIDER]||'').trim() && (f[F.COUNTY]||'').trim()
&& !isExpiredCamp(f, todayStr) && !(Array.isArray(f[F.SCHOOLS]) && f[F.SCHOOLS].length)
).map(f => {
const t = f[F.TYPE]; const tn = t && typeof t === 'object' ? t.name : (t||'');
return { county: (f[F.COUNTY]||'').trim(), area: (f[F.AREA]||'').trim(), type: tn === 'Weekly Class' ? 'weekly' : 'camp' };
}));

for (const record of records) {
const f = record.fields;
const name = (f[F.NAME] ||'').trim();
const provider = (f[F.PROVIDER]||'').trim();
const county = (f[F.COUNTY] ||'').trim();

if (!name || !provider || !county) { skipped++; continue; }
const expired = isExpiredCamp(f, todayStr);
if (expired) skippedExpired++;

const categoryRaw = f[F.CATEGORY];
const category = categoryRaw && typeof categoryRaw === 'object' ? categoryRaw.name : (categoryRaw||'');
const ageMin = typeof f[F.AGE_MIN] === 'number' ? f[F.AGE_MIN] : null;
const ageMax = typeof f[F.AGE_MAX] === 'number' ? f[F.AGE_MAX] : null;
const schoolsArr = Array.isArray(f[F.SCHOOLS])
? f[F.SCHOOLS].map(s => (s && typeof s === 'object') ? s.name : String(s||'')).filter(Boolean)
: [];

// A Schools-tagged record is NOT a normal camp/class listing — confirmed
// by Rachel 2026-09-29. It gets no individual /camps or /classes page, no
// camps-data.js search-index entry, and no sitemap/manifest camp entry.
// It exists purely as a card on its school's hub page, built below.
if (schoolsArr.length) {
if (expired) continue; // finished school activity: just drop it off the hub page
const activity = {
name,
provider,
category,
ageMin,
ageMax,
days: (f[F.DAYS]||'').trim(),
times: (f[F.TIMES]||'').trim(),
cost: (f[F.COST]||'').trim(),
booking: (f[F.BOOKING]||'').trim(),
bookingUrl: (f[F.BOOKING_URL]||'').trim(),
};
for (const s of schoolsArr) {
(schoolMap[s] = schoolMap[s] || []).push(activity);
}
continue;
}

const countySlug = makeCountySlug(county);
const slug = makeSlug(provider, name);
const section = sectionForType(f[F.TYPE]);
const filePath = `/${section}/${countySlug}/${slug}.html`;
const pageUrl = `${BASE_URL}/${section}/${countySlug}/${slug}`;

// Finished listing: archive, don't drop. Same URL, rebuilt as an archived
// page, listed in sitemap-archive.xml only, and kept out of search.
if (expired) {
files[filePath] = generateHTML(record, records, { archived: true });
archivedManifest.push({ slug, county:countySlug, url:pageUrl, name, provider, section, archived: true, file: filePath });
continue;
}

files[filePath] = generateHTML(record, records);
manifest.push({ slug, county:countySlug, url:pageUrl, name, provider, section, file: filePath });

// camps-data.js entry (search index) — field extraction mirrors
// generateHTML's own, so the search index and the page it links to never
// disagree about category/ages/weeks/etc.
const weeksArr = Array.isArray(f[F.WEEKS])
? f[F.WEEKS].map(w => (w && typeof w === 'object') ? w.name : String(w||'')).filter(Boolean)
: [];
const typeRaw = f[F.TYPE];
const typeName = typeRaw && typeof typeRaw === 'object' ? typeRaw.name : (typeRaw||'');
const type = typeName === 'Weekly Class' ? 'weekly' : 'camp';

listings.push({
id: record.id,
name,
provider,
category,
ageMin,
ageMax,
area: (f[F.AREA]||'').trim(),
county,
cost: (f[F.COST]||'').trim(),
costValue: typeof f[F.COST_VALUE] === 'number' ? f[F.COST_VALUE] : 0,
times: (f[F.TIMES]||'').trim(),
days: (f[F.DAYS]||'').trim(),
bookingUrl: (f[F.BOOKING_URL]||'').trim(),
weeks: weeksArr,
notes: (f[F.NOTES]||'').trim(),
availability: availabilityOf(f),
listingUrl: `/${section}/${countySlug}/${slug}`,
postcode: (f[F.POSTCODE]||'').trim(),
type,
});
}

// School hub pages (/schools/{slug}.html) — one per distinct value in the
// Schools field, built from `schoolMap` (already Live + non-expired only,
// filtered in the loop above) so a hub page can never show a stale or
// unpublished activity. Added into `files`/`manifest` here, before the
// diff check below, for the same reason as camps-data.js: their content
// is purely data-driven (no self-changing timestamp), so they should
// participate in deciding whether today's run has anything to commit.
for (const [schoolName, schoolActivities] of Object.entries(schoolMap)) {
const schoolSlug = makeSchoolSlug(schoolName);
const filePath = `/schools/${schoolSlug}.html`;
const pageUrl = `${BASE_URL}/schools/${schoolSlug}`;
files[filePath] = generateSchoolPageHTML(schoolName, schoolActivities);
manifest.push({ slug: schoolSlug, county: null, provider: null, section: 'school', url: pageUrl, name: schoolName, listingCount: schoolActivities.length, file: filePath });
}

// Added into `files` here (not after the changedPages check, unlike
// sitemap.xml/manifest.json below) because it has no self-changing
// timestamp — its diff is purely content-based, so it can safely help
// decide whether a commit is needed at all. That also means a data-only
// change (e.g. CostValue edited without touching any field a page renders)
// still triggers a real commit instead of being silently skipped.
files['/js/camps-data.js'] = buildCampsDataJs(listings);
// County/area hub pages + the homepage's area-chip data (AREA HUB PAGES).
const hubBuild = buildHubPages(listings);
Object.assign(files, Object.fromEntries(Object.entries(hubBuild.files).map(([p, html]) => [p, html])));
manifest.push(...hubBuild.entries);
files['/js/areas-data.js'] = buildAreasDataJs();
files['/js/schools-data.js'] = buildSchoolsDataJs(schoolMap);

// Diff against what's currently committed BEFORE deciding whether to touch
// sitemap.xml/manifest.json — those are only worth re-writing (and the
// dated sitemap only worth bumping) when a real page actually changed, so
// a day with no content changes makes no commit and triggers no deploy.
const treeInfo = await getCurrentTree(githubToken);
const changedPages = Object.entries(files).filter(([filePath, content]) => {
const repoPath = filePath.replace(/^\//, '');
return treeInfo.pathToSha[repoPath] !== gitBlobSha1(content);
});

const elapsedNoChange = () => ((Date.now() - startTime) / 1000).toFixed(1);

if (changedPages.length === 0) {
return {
statusCode: 200,
body: JSON.stringify({
success: true,
generated: manifest.length,
skipped,
skippedExpired,
archived: archivedManifest.length,
changed: 0,
elapsed: `${elapsedNoChange()}s`,
pages: manifest.map(m => m.url.replace(BASE_URL, '')),
message: 'No page content changed since the last run — nothing committed.',
}),
};
}

// Sitemaps (reworked 2026-11-06, AI/search audit step 2):
// - /sitemap.xml: static pages, monthly guides, every live listing and
//   school hub page.
// - /sitemap-archive.xml: finished listings (archived pages), so crawlers
//   can still find and cite past camps without mixing them in with what's
//   bookable now.
// - <lastmod> is real: a page keeps the lastmod recorded in the previous
//   manifest.json while its generated content is unchanged, and only gets
//   today's date when its content actually changed (or it's new). Before
//   this, every URL got today's date on every run, which tells crawlers
//   nothing.
const today = todayStr;
const prevManifest = await readRepoJson(githubToken, treeInfo.pathToSha['manifest.json']);
const prevLastmod = {};
if (Array.isArray(prevManifest)) for (const m of prevManifest) if (m && m.url && m.lastmod) prevLastmod[m.url] = m.lastmod;
const stampLastmod = m => {
const unchanged = m.file && treeInfo.pathToSha[m.file.replace(/^\//, '')] === gitBlobSha1(files[m.file]);
m.lastmod = (unchanged && prevLastmod[m.url]) || today;
delete m.file;
return m;
};
manifest.forEach(stampLastmod);
archivedManifest.forEach(stampLastmod);

const urlTag = (loc, lastmod, changefreq, priority) =>
` <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
const staticUrls = STATIC_PAGES.map(p => urlTag(`${BASE_URL}${p.path}`, null, p.changefreq, p.priority));
const guidesIndex = await readRepoJson(githubToken, treeInfo.pathToSha['data/guides-index.json']);
const guideUrls = (guidesIndex && Array.isArray(guidesIndex.guides) ? guidesIndex.guides : [])
.filter(g => g && typeof g.guide === 'string' && g.guide.startsWith('/'))
.map(g => urlTag(`${BASE_URL}${g.guide}`, null, 'monthly', '0.7'));
const hubUrls = manifest.filter(m => m.section === 'hub').map(m => urlTag(m.url, m.lastmod, 'daily', '0.8'));
const campUrls = manifest.filter(m => m.section !== 'school' && m.section !== 'hub').map(m => urlTag(m.url, m.lastmod, 'weekly', '0.7'));
// School hub pages get a slightly lower priority than a bookable listing —
// they're a directory page, same tier as the static hub pages above.
const schoolUrls = manifest.filter(m => m.section === 'school').map(m => urlTag(m.url, m.lastmod, 'weekly', '0.6'));
const archiveUrls = archivedManifest.map(m => urlTag(m.url, m.lastmod, 'yearly', '0.3'));
const urlset = urls => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
files['/sitemap.xml'] = urlset([...staticUrls, ...guideUrls, ...hubUrls, ...campUrls, ...schoolUrls]);
files['/sitemap-archive.xml'] = urlset(archiveUrls);
files['/manifest.json'] = JSON.stringify([...manifest, ...archivedManifest], null, 2);

const changedSlugs = changedPages.map(([filePath]) => filePath).slice(0, 8);
const commitMessage = `Auto-update ${changedPages.length} listing page(s) via generate-listings\n\n${changedSlugs.join('\n')}${changedPages.length > changedSlugs.length ? `\n…and ${changedPages.length - changedSlugs.length} more` : ''}`;

const commitResult = await commitFilesToGitHub(githubToken, files, commitMessage, treeInfo);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

return {
statusCode: 200,
body: JSON.stringify({
success: true,
generated: manifest.length,
skipped,
skippedExpired,
archived: archivedManifest.length,
changed: commitResult ? commitResult.filesChanged.length : 0,
commitSha: commitResult ? commitResult.commitSha : null,
elapsed: `${elapsed}s`,
pages: manifest.map(m => m.url.replace(BASE_URL, '')),
}),
};

} catch (err) {
// Logged so a real failure shows up in Netlify's Function log even when
// the HTTP response back to the caller never completes.
console.error(`[generate-listings] failed after ${Date.now()-startTime}ms: ${err && err.stack || err}`);
return { statusCode:500, body: JSON.stringify({ error: err.message }) };
}
};
