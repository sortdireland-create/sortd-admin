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
LIVE: 'fldBQ6YMcDuYPJkne',
WEEKS: 'fldL6Cf1fiQIdIAby',
TAGS: 'fldJi4Gme38iKvovO',
TYPE: 'fldIKsf7AM5Jqr60K',
COST_VALUE: 'fldISJYKzDZJYdE8r',
POSTCODE: 'fldwRc0BuvcO0T2gy',
DATE_END: 'fldgKIJM3jcMig7Ji',
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
function isExpiredCamp(f, todayStr) {
const typeRaw = f[F.TYPE];
const typeName = typeRaw && typeof typeRaw === 'object' ? typeRaw.name : (typeRaw||'');
if (typeName === 'Weekly Class') return false;

const dateEnd = f[F.DATE_END];
if (typeof dateEnd === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateEnd)) {
return dateEnd.slice(0, 10) < todayStr;
}

const weeksRaw = f[F.WEEKS];
if (Array.isArray(weeksRaw) && weeksRaw.length) {
const weekNames = weeksRaw.map(w => (w && typeof w === 'object') ? w.name : String(w || ''));
const endDates = weekNames.map(w => WEEK_END_DATES[w]).filter(Boolean);
if (endDates.length) {
const latestEnd = endDates.sort().slice(-1)[0];
return latestEnd < todayStr;
}
}

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
const STATIC_PAGES = [
{ path: '/', changefreq: 'daily', priority: '1.0' },
{ path: '/about', changefreq: 'monthly', priority: '0.5' },
{ path: '/how-it-works', changefreq: 'monthly', priority: '0.5' },
{ path: '/recommend', changefreq: 'monthly', priority: '0.4' },
{ path: '/privacy-policy', changefreq: 'yearly', priority: '0.2' },
{ path: '/neurodivergent-camps-ireland', changefreq: 'weekly', priority: '0.8' },
{ path: '/dublin/northside/camps', changefreq: 'daily', priority: '0.9' },
{ path: '/dublin/southdublin/camps', changefreq: 'daily', priority: '0.9' },
{ path: '/dublin/citycentre/camps', changefreq: 'daily', priority: '0.9' },
];

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
function generateHTML(record, allRecords) {
const f = record.fields;
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

const countySlug = makeCountySlug(county||'ireland');
const slug = makeSlug(provider, name);
const section = sectionForType(f[F.TYPE]);
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
const waText = encodeURIComponent(`I found this camp on sortd.ie — thought you might be interested! ${pageUrl}`);
const emailBody = encodeURIComponent(`I found this camp on sortd.ie — thought you might be interested!\n${pageUrl}`);
const locLines = location.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>`${esc(l)}<br>`).join('');
const sfx = `. ${category} camp in ${area}, ${county} for ages ${ageMin}–${ageMax}. Find and book on sortd.ie.`;
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

// Fully-booked / waitlist state — signalled by the provider putting
// "FULLY BOOKED" in Notes. Swaps the CTA to a waitlist link instead of
// hiding the page, so sold-out camps still rank and still convert waitlist signups.
const isFullyBooked = /FULLY BOOKED/i.test(notes);
const bookBtnLabel = isFullyBooked ? 'Join the waitlist ↗' : 'Book this camp ↗';
const fullyBookedBanner = isFullyBooked ? `
<div class="fb-banner">
<div class="fb-banner__t">😔 Fully booked for this summer</div>
<p class="fb-banner__p">This camp has sold out, but spaces sometimes open up when families cancel — join the waitlist to be first in line.</p>
</div>` : '';

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
const rNotes = (rf[F.NOTES]||'').trim();
const rFull = /FULLY BOOKED/i.test(rNotes);
return {
name: rName,
url: `/${rSection}/${rCountySlug}/${rSlug}`,
ages: rAgeMin && rAgeMax ? `${rAgeMin}–${rAgeMax}` : '',
full: rFull,
};
})
.filter(Boolean);

const siblingsHtml = siblings.length ? `
<div class="sc">
<div class="sl">More from ${esc(provider)}</div>
<div class="other-camps">
${siblings.map(s => `<a href="${esc(s.url)}" class="camp-link">${esc(s.name)}${s.ages ? ` <span class="mu">(ages ${esc(s.ages)})</span>` : ''} ${s.full ? '<span class="full-tag">Waitlist</span>' : '<span class="avail">Places available ✓</span>'}</a>`).join('')}
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
<title>${esc(name)} — ${esc(area)}, ${esc(county)} | sortd</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${esc(name+' — '+area+' | sortd')}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:type" content="website">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SportsClub","name":"${escJson(name)}","description":"${escJson(descClean)}","url":"${pageUrl}","address":{"@type":"PostalAddress","addressLocality":"${escJson(area)}","addressRegion":"${escJson(county)}","addressCountry":"IE"}}<\/script>
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
.lp-sibling-link{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;background:var(--pg);border-radius:12px;text-decoration:none;color:var(--nv);font-weight:600;font-size:.88rem;margin-top:10px;}
.lp-sibling-link .lp-avail{font-size:.74rem;color:var(--gr);font-weight:700;white-space:nowrap;}
.lp-sibling-link .lp-full{font-size:.74rem;color:#8a5f0f;font-weight:700;white-space:nowrap;}
</style>
</head>
<body>

<nav>
  <a href="/" class="brand">sortd<span>.</span></a>
  <div class="navlinks">
    <a href="/camps" class="navlink${section!=='classes'?' active':''}">Camps</a>
    <a href="/weekly-classes" class="navlink${section==='classes'?' active':''}">Weekly classes</a>
    <a href="/how-it-works" class="navlink">How it works</a>
    <a href="/about" class="navlink">Our story</a>
    <a href="https://portal.sortd-ireland.ie" target="_blank" rel="noopener" class="navlink">Partners portal</a>
  </div>
  <div style="display:flex; align-items:center; gap:12px;">
    <a href="https://www.instagram.com/sortd.ireland/" target="_blank" rel="noopener"><i class="ti ti-brand-instagram nav-icon"></i></a>
    <a href="/list" class="nav-cta-outline">Add a class</a>
    <button class="nav-cta" onclick="openPopup()">Follow us</button>
  </div>
</nav>

<nav class="lp-bc" aria-label="Breadcrumb">
<div class="lp-bc-inner">
<a href="/">sortd</a><span class="lp-sep">›</span>
<a href="${hubPath}?q=${encodeURIComponent(county)}">${esc(category)} · ${esc(county)}</a><span class="lp-sep">›</span>
<a href="${hubPath}?q=${encodeURIComponent(area)}">${esc(area)}</a><span class="lp-sep">›</span>
<span class="lp-cur">${esc(name)}</span>
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
${fullyBookedBanner}
${nextStart && !isFullyBooked ? `<div class="lp-startdate"><div><div class="lp-startdate-l">Next start date</div><div class="lp-startdate-d">${esc(nextStart)}</div></div><i class="ti ti-calendar-check"></i></div>` : ''}
${bookingUrl ? `<a href="${esc(bookingUrl)}" target="_blank" rel="noopener" class="lp-cta">${bookBtnLabel}</a>` : `<button class="lp-cta" disabled>Contact provider to book</button>`}
<button class="lp-cta-ghost" disabled>Send enquiry — coming soon</button>
</div>

<div class="lp-card">
<div class="lp-card-l">About this camp</div>
<p class="lp-about">${esc(description)}</p>
</div>

<div class="lp-card">
<div class="lp-card-l">Weeks available</div>
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

<div class="note" style="background:#fff;border:1px solid var(--bd);border-radius:20px;padding:20px 22px;margin-bottom:16px;color:${cat.colour};">${caveat}</div>

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

<footer>
  <div class="foot-top">
    <div>
      <div class="foot-logo">sortd</div>
      <p class="foot-tag">Every kids' camp &amp; weekly class across Leinster, in one place. Built by a mum. For parents.</p>
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
      <a href="/weekly-classes">All weekly classes</a>
    </div>
    <div class="foot-col">
      <div class="foot-heading">Company</div>
      <a href="/how-it-works">How it works</a>
      <a href="/about">About</a>
      <a href="mailto:sortd.ireland@gmail.com?subject=Camp%20recommendation">Recommend an activity</a>
      <a href="mailto:sortd.ireland@gmail.com">Contact</a>
    </div>
    <div class="foot-col">
      <div class="foot-heading">For providers</div>
      <a href="/list">Add a class — free</a>
      <a href="/claim">Claim your listing</a>
      <a href="https://portal.sortd-ireland.ie" target="_blank" rel="noopener">Partners portal</a>
    </div>
  </div>
  <div class="foot-bottom">
    <div>© 2026 Sortd Ireland · <a href="/privacy-policy">Privacy Policy</a></div>
    <div class="foot-source">Sources: provider websites, WhatsApp screenshots, Instagram. Confirm details with each provider before booking.</div>
  </div>
</footer>
<div class="popup-overlay" id="popupOverlay" role="dialog" aria-modal="true" aria-label="Follow sortd on Instagram">
<div class="popup">
<button class="popup-close" onclick="closePopup()" aria-label="Close">&#10005;</button>
<div class="popup-logo">sortd</div>
<div class="popup-title">Follow on Instagram</div>
<p class="popup-sub">New camps, open spots and last-minute updates — posted first on Instagram. No app, no spam, just what's on.</p>
<a href="https://www.instagram.com/sortd.ireland/" target="_blank" rel="noopener" class="popup-btn" style="display:flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;">
<i class="ti ti-brand-instagram" style="font-size:20px;"></i> Follow @sortd.ireland
</a>
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
</script>

</body>
</html>`;
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
const listings = [];
let skipped = 0;
let skippedExpired = 0;
const todayStr = new Date().toISOString().slice(0, 10);

for (const record of records) {
const f = record.fields;
const name = (f[F.NAME] ||'').trim();
const provider = (f[F.PROVIDER]||'').trim();
const county = (f[F.COUNTY] ||'').trim();

if (!name || !provider || !county) { skipped++; continue; }
if (isExpiredCamp(f, todayStr)) { skippedExpired++; continue; }

const countySlug = makeCountySlug(county);
const slug = makeSlug(provider, name);
const section = sectionForType(f[F.TYPE]);
const filePath = `/${section}/${countySlug}/${slug}.html`;
const pageUrl = `${BASE_URL}/${section}/${countySlug}/${slug}`;

files[filePath] = generateHTML(record, records);
manifest.push({ slug, county:countySlug, url:pageUrl, name, provider, section });

// camps-data.js entry (search index) — field extraction mirrors
// generateHTML's own, so the search index and the page it links to never
// disagree about category/ages/weeks/etc.
const categoryRaw = f[F.CATEGORY];
const category = categoryRaw && typeof categoryRaw === 'object' ? categoryRaw.name : (categoryRaw||'');
const ageMin = typeof f[F.AGE_MIN] === 'number' ? f[F.AGE_MIN] : null;
const ageMax = typeof f[F.AGE_MAX] === 'number' ? f[F.AGE_MAX] : null;
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
listingUrl: `/${section}/${countySlug}/${slug}`,
postcode: (f[F.POSTCODE]||'').trim(),
type,
});
}

// Added into `files` here (not after the changedPages check, unlike
// sitemap.xml/manifest.json below) because it has no self-changing
// timestamp — its diff is purely content-based, so it can safely help
// decide whether a commit is needed at all. That also means a data-only
// change (e.g. CostValue edited without touching any field a page renders)
// still triggers a real commit instead of being silently skipped.
files['/js/camps-data.js'] = buildCampsDataJs(listings);

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
changed: 0,
elapsed: `${elapsedNoChange()}s`,
pages: manifest.map(m => m.url.replace(BASE_URL, '')),
message: 'No page content changed since the last run — nothing committed.',
}),
};
}

// Full sitemap: static/hub pages + every live camp page.
// Written to the conventional /sitemap.xml path so Search Console
// and crawlers find it without any extra configuration.
const today = new Date().toISOString().split('T')[0];
const staticUrls = STATIC_PAGES.map(p =>
` <url><loc>${BASE_URL}${p.path}</loc><lastmod>${today}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`
);
const campUrls = manifest.map(m =>
` <url><loc>${m.url}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`
);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...staticUrls, ...campUrls].join('\n')}\n</urlset>`;
files['/sitemap.xml'] = sitemap;
files['/manifest.json'] = JSON.stringify(manifest, null, 2);

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
