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
};

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
const CATEGORY_CONFIG = {
'Tennis': { icon:'ti-ball-tennis', colour:'#29ABE2' },
'Football': { icon:'ti-ball-football', colour:'#2BAD7E' },
'GAA': { icon:'ti-ball-football', colour:'#2BAD7E' },
'Swimming': { icon:'ti-swimming', colour:'#29ABE2' },
'Adventure': { icon:'ti-mountain', colour:'#2BAD7E' },
'Multi-Activity': { icon:'ti-stars', colour:'#29ABE2' },
'Sport — Multi-activity':{ icon:'ti-stars', colour:'#29ABE2' },
'Performing arts': { icon:'ti-masks-theater', colour:'#F7A800' },
'Drama': { icon:'ti-masks-theater', colour:'#F7A800' },
'Dance': { icon:'ti-music', colour:'#F4A7C3' },
'Music': { icon:'ti-music', colour:'#F4A7C3' },
'Arts & Crafts': { icon:'ti-palette', colour:'#F7A800' },
'STEM / LEGO': { icon:'ti-building-factory', colour:'#29ABE2' },
'STEM': { icon:'ti-circuit-board', colour:'#29ABE2' },
'Nature': { icon:'ti-tree', colour:'#2BAD7E' },
'Language': { icon:'ti-language', colour:'#29ABE2' },
'default': { icon:'ti-star', colour:'#29ABE2' },
};
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
<style>
:root{--cr:#F5F0E8;--cd:#FBF8F0;--nv:#27314A;--sk:#29ABE2;--pk:#F4A7C3;--rd:#EF3D2F;--su:#F7A800;--gr:#2BAD7E;--bd:#EDE7D8;--bt:#444;--mu:#888;--la:#aaa;--fd:'Baloo 2',sans-serif;--fb:'Nunito',sans-serif;--fs:'Caveat',cursive;--bc:${cat.colour}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--fb);background:var(--cr);color:var(--bt);min-height:100vh}
a{text-decoration:none;color:inherit;}

/* ── NAV — matches homepage exactly ── */
.nav{background:#fff;border-bottom:1.5px solid #eee;position:sticky;top:0;z-index:200;}
.nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:16px 40px;}
.nav .lo{font-family:var(--fd);font-weight:800;font-size:28px;color:var(--nv);letter-spacing:-0.03em;}
.nav-links{display:flex;align-items:center;gap:24px;font-weight:700;font-size:14px;}
.nav-links a{color:var(--nv);opacity:0.6;transition:opacity 0.15s;}
.nav-links a:hover{opacity:1;}
@media(max-width:768px){.nav-links{display:none;}.nav-inner{padding:14px 20px;}}

/* ── BREADCRUMB ── */
.bc{background:#fff;padding:11px 40px;border-bottom:1px solid #f0f0f0;font-size:12px;font-weight:700;color:#bbb;}
.bc-inner{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.bc a{color:#bbb;}.bc a:hover{color:var(--nv);}.sep{opacity:0.4;}.cur{color:var(--nv);}
@media(max-width:768px){.bc{padding:10px 20px;}}

/* ── PAGE WRAPPER ── */
.page{max-width:1200px;margin:0 auto;padding:40px 40px 64px;}
@media(max-width:768px){.page{padding:24px 20px 48px;}}

/* ── TWO-COLUMN DESKTOP LAYOUT ── */
.layout{display:grid;grid-template-columns:1fr 360px;gap:32px;align-items:start;}
@media(max-width:900px){.layout{grid-template-columns:1fr;}}

/* ── BANNER ── */
.bn{position:relative;height:200px;background:var(--bc);overflow:hidden;border-radius:0;}
.bls{position:absolute;inset:0;overflow:hidden;}
.bl{position:absolute;border-radius:50%;opacity:.28;}
.bl1{width:200px;height:200px;background:var(--pk);top:-60px;left:-40px;}
.bl2{width:140px;height:140px;background:var(--su);bottom:-40px;right:80px;}
.bl3{width:120px;height:120px;background:var(--gr);top:20px;right:-20px;}
.bna{position:absolute;top:16px;right:16px;display:flex;gap:8px;z-index:2;}
.bnb{background:rgba(255,255,255,.9);border:none;border-radius:20px;padding:7px 14px;font-family:var(--fb);font-size:12px;font-weight:700;color:var(--nv);cursor:pointer;display:flex;align-items:center;gap:5px;}
.pb{position:absolute;bottom:-24px;left:40px;width:56px;height:56px;background:var(--cd);border:3px solid var(--cr);border-radius:16px;display:flex;align-items:center;justify-content:center;z-index:10;box-shadow:0 2px 12px rgba(39,49,74,.14);}
.pb .ti{font-size:26px;color:var(--bc);}
@media(max-width:768px){.bn{height:140px;}.pb{left:20px;width:48px;height:48px;}.pb .ti{font-size:22px;}}

/* ── MAIN CONTENT COLUMN ── */
.hd{background:var(--cd);border-radius:16px;padding:44px 28px 28px;margin-bottom:16px;}
.hd__c{font-size:10px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;color:var(--rd);margin-bottom:8px;}
h1{font-family:var(--fd);font-weight:800;font-size:clamp(22px,3.5vw,36px);line-height:1.1;color:var(--nv);margin-bottom:8px;}
.hd__p{font-size:14px;color:var(--mu);display:flex;align-items:center;gap:8px;margin-bottom:20px;}
.sb{background:var(--sk);color:#fff;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:4px;}
.fg{display:grid;grid-template-columns:1fr 1fr;border:1.5px solid var(--bd);border-radius:12px;overflow:hidden;margin-bottom:16px;}
.fc{padding:12px 16px;border-right:1.5px solid var(--bd);border-bottom:1.5px solid var(--bd);}
.fc:nth-child(2n){border-right:none;}.fc:nth-child(3),.fc:nth-child(4){border-bottom:none;}
.fc__l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--la);display:flex;align-items:center;gap:4px;margin-bottom:4px;}
.fc__l .ti{color:var(--rd);font-size:12px;}.fc__v{font-size:13px;font-weight:700;color:var(--nv);line-height:1.35;}
.sd{background:var(--pk);border-radius:10px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.sd__l{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--nv);opacity:.7;margin-bottom:2px;}
.sd__d{font-family:var(--fd);font-weight:800;font-size:18px;color:var(--nv);}
.sd .ti{font-size:26px;color:var(--nv);opacity:.5;}
.bb{display:block;width:100%;background:var(--rd);color:#fff;border:none;border-radius:30px;padding:14px;font-family:var(--fd);font-size:15px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer;margin-bottom:10px;transition:opacity .15s;}
.bb:hover{opacity:.88;}
.be{display:block;width:100%;background:transparent;color:var(--nv);border:1.5px solid var(--bd);border-radius:30px;padding:12px;font-family:var(--fb);font-size:13px;font-weight:700;text-align:center;cursor:not-allowed;opacity:.5;}
.sc{background:var(--cd);border-radius:16px;padding:24px 28px;margin-bottom:16px;}
.sl{font-family:var(--fd);font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--rd);margin-bottom:12px;}
.ab{font-size:15px;line-height:1.7;color:var(--bt);white-space:pre-line;}
.mu2{font-size:13px;color:var(--mu);}
.wcs{display:flex;flex-direction:column;gap:8px;}
.wc{background:var(--cr);border:1px solid var(--bd);border-radius:8px;padding:9px 14px;}
.wc__p{font-size:13px;font-weight:700;color:var(--nv);}.wc__s{font-size:11px;color:var(--mu);margin-top:2px;}
.cp{font-family:var(--fd);font-weight:800;font-size:32px;color:var(--nv);line-height:1;}
.cpe{font-size:13px;color:var(--mu);margin-top:4px;margin-bottom:14px;}
.cn{background:var(--cr);border-radius:7px;padding:12px 14px;font-size:13px;color:var(--bt);line-height:1.55;white-space:pre-line;}
.lr{display:flex;gap:14px;align-items:flex-start;}
.lm{width:90px;min-width:90px;height:72px;background:#D2F2E2;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--gr);font-size:28px;}
.la2{font-size:14px;color:var(--bt);line-height:1.55;margin-bottom:8px;}
.ld{color:var(--sk);font-size:13px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:4px;}

/* ── SIDEBAR COLUMN ── */
.sidebar{}
.bx{background:var(--nv);border-radius:16px;padding:20px 22px;display:flex;flex-direction:column;margin-bottom:16px;}
.br{padding:11px 0;border-bottom:1px solid rgba(255,255,255,.08);}.br:last-child{border-bottom:none;}
.br__l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.45);margin-bottom:4px;}
.br__v{font-size:14px;font-weight:600;color:#fff;display:flex;align-items:center;gap:6px;}
.br__v a{color:#fff;text-decoration:underline;text-underline-offset:2px;}
.br__v--ig{color:var(--pk);}.br__n{font-weight:400;color:rgba(255,255,255,.7);font-size:13px;line-height:1.5;}
.ib{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.ibt{display:flex;align-items:center;justify-content:center;gap:6px;padding:13px;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none;border:none;cursor:pointer;font-family:var(--fb);}
.ibt--w{background:#25D366;color:#fff;}.ibt--e{background:var(--cr);color:var(--nv);}
.sn{background:var(--cd);border-radius:16px;padding:20px 22px;text-align:center;font-family:var(--fs);font-size:20px;font-weight:600;color:var(--gr);margin-bottom:16px;}
.ex{background:var(--cd);border-radius:16px;padding:20px 22px;}
.ex__l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--la);margin-bottom:12px;}
.ex__ls{display:flex;flex-direction:column;gap:10px;}
.ex__a{color:var(--sk);font-size:14px;font-weight:600;text-decoration:none;display:flex;align-items:center;gap:5px;}

/* ── FOOTER — matches homepage exactly ── */
.footer{background:var(--nv);padding:40px 40px 24px;}
.footer-inner{max-width:1200px;margin:0 auto;}
.f-logo{font-family:var(--fd);font-weight:800;font-size:22px;color:var(--pk);display:block;margin-bottom:6px;}
.f-links{display:flex;gap:24px;margin-bottom:24px;flex-wrap:wrap;}
.f-links a{font-size:13px;font-weight:600;color:rgba(255,255,255,.5);transition:color .15s;}
.f-links a:hover{color:#fff;}
.f-bot{border-top:1px solid rgba(255,255,255,.1);padding-top:16px;font-size:11px;color:rgba(255,255,255,.3);}
@media(max-width:768px){.footer{padding:32px 20px 20px;}}
.badge-neuro{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;font-size:.78rem;font-weight:700;background:#F3E8FF;color:#7C3AED;border:1.5px solid #7C3AED;margin-bottom:10px;}
.fb-banner{background:#FEF2F2;border:2px solid #DC2626;border-radius:16px;padding:20px 24px;margin-bottom:24px;}
.fb-banner__t{font-family:var(--fd);font-size:1.15rem;font-weight:800;color:#DC2626;margin-bottom:6px;}
.fb-banner__p{font-size:.92rem;color:#7F1D1D;line-height:1.6;margin:0;}
.other-camps{display:flex;flex-direction:column;gap:10px;margin-top:8px;}
.camp-link{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;background:var(--cr);border-radius:12px;text-decoration:none;color:#1a1a2e;font-weight:600;font-size:.88rem;}
.camp-link .avail{font-size:.74rem;color:#2BAD7E;font-weight:700;white-space:nowrap;}
.camp-link .full-tag{font-size:.74rem;color:#DC2626;font-weight:700;white-space:nowrap;}
</style>
</head>
<body>

<nav class="nav">
<div class="nav-inner">
<a href="/" class="lo">sortd</a>
<div class="nav-links">
<a href="/how-it-works">how it works</a>
<a href="/recommend">recommend a camp</a>
<a href="/about">about</a><a href="https://portal.sortd-ireland.ie" target="_blank" rel="noopener">partners portal</a>
<a href="https://www.instagram.com/sortd.ireland/" target="_blank" rel="noopener">instagram</a>
</div>
</div>
</nav>

<nav class="bc" aria-label="Breadcrumb">
<div class="bc-inner">
<a href="/">sortd</a><span class="sep">›</span>
<a href="/dublin/northside/camps">Summer camps · ${esc(county)}</a><span class="sep">›</span>
<a href="/dublin/northside/camps?area=${areaSlug}">${esc(area)}</a><span class="sep">›</span>
<span class="cur">${esc(name)}</span>
</div>
</nav>

<div class="bn">
<div class="bls"><div class="bl bl1"></div><div class="bl bl2"></div><div class="bl bl3"></div></div>
<div class="bna">
<button class="bnb"><i class="ti ti-heart"></i> Save</button>
<button class="bnb"><i class="ti ti-share"></i> Share</button>
</div>
<div class="pb"><i class="ti ${cat.icon}"></i></div>
</div>

<div class="page">
<div class="layout">

<!-- MAIN COLUMN -->
<div class="main-col">
<div class="hd">
<div class="hd__c">${esc(category)}</div>
${isNeurodivergent ? `<div class="badge-neuro">🧠 Neurodivergent-Friendly</div>` : ''}
<h1>${esc(name.toLowerCase().startsWith(provider.toLowerCase().split(' ')[0].toLowerCase()) ? name : provider + ' — ' + name)}</h1>
<div class="hd__p">${esc(provider)}<span class="sb">Sortd Listed</span></div>
<div class="fg">
<div class="fc"><div class="fc__l"><i class="ti ti-calendar-event"></i> Days</div><div class="fc__v">${esc(daysFirst||'Mon–Fri')}</div></div>
<div class="fc"><div class="fc__l"><i class="ti ti-users"></i> Ages</div><div class="fc__v">${esc(agesDisplay)}</div></div>
<div class="fc"><div class="fc__l"><i class="ti ti-currency-euro"></i> Cost</div><div class="fc__v">${esc(costFirst||'See provider')}</div></div>
<div class="fc"><div class="fc__l"><i class="ti ti-map-pin"></i> Location</div><div class="fc__v">${esc(area)}, ${esc(county)}</div></div>
</div>
${fullyBookedBanner}
${nextStart && !isFullyBooked ? `<div class="sd"><div><div class="sd__l">Next start date</div><div class="sd__d">${esc(nextStart)}</div></div><i class="ti ti-calendar-check"></i></div>` : ''}
${bookingUrl ? `<a href="${esc(bookingUrl)}" target="_blank" rel="noopener" class="bb">${bookBtnLabel}</a>` : `<button class="bb" disabled style="opacity:.5;cursor:default">Contact provider to book</button>`}
<button class="be" disabled>Send enquiry — coming soon</button>
</div>

<div class="sc">
<div class="sl">About this camp</div>
<p class="ab">${esc(description)}</p>
</div>

<div class="sc">
<div class="sl">Weeks available</div>
<div class="wcs">${weeksHtml}</div>
</div>

<div class="sc">
<div class="sl">Cost</div>
<div class="cp">${esc(costFirst||'—')}</div>
<div class="cpe">per child${timesFirst ? ' · '+esc(timesFirst) : ''}</div>
${costNote ? `<div class="cn">${esc(costNote)}</div>` : ''}
</div>

<div class="sc">
<div class="sl">Location</div>
<div class="lr">
<div class="lm"><i class="ti ti-map-pin"></i></div>
<div>
<div class="la2">${locLines || esc(area+', '+county)}</div>
<a href="https://maps.google.com/?q=${mapsQ}" target="_blank" rel="noopener" class="ld">Get directions <i class="ti ti-external-link"></i></a>
</div>
</div>
</div>
${siblingsHtml}
</div>

<!-- SIDEBAR COLUMN -->
<div class="sidebar">
<div class="bx">
<div class="sl" style="color:var(--pk)">How to book</div>
${bookingUrl ? `<div class="br"><div class="br__l">Book online</div><div class="br__v"><i class="ti ti-external-link"></i><a href="${esc(bookingUrl)}" target="_blank" rel="noopener">${esc(bookingHostname)}</a></div></div>` : ''}
${igHandle ? `<div class="br"><div class="br__l">Instagram</div><div class="br__v br__v--ig"><i class="ti ti-brand-instagram"></i><a href="${esc(instagram)}" target="_blank" rel="noopener">@${esc(igHandle)}</a></div></div>` : ''}
${booking ? `<div class="br"><div class="br__l">How to book</div><div class="br__v br__n">${esc(booking)}</div></div>` : ''}
</div>

<div class="sc">
<div class="sl">Invite a friend</div>
<div class="ib">
<a href="https://wa.me/?text=${waText}" target="_blank" rel="noopener" class="ibt ibt--w"><i class="ti ti-brand-whatsapp"></i> WhatsApp</a>
<a href="mailto:?subject=Found%20this%20on%20sortd&body=${emailBody}" class="ibt ibt--e"><i class="ti ti-mail"></i> Email</a>
</div>
</div>

<div class="sn">${caveat}</div>

<div class="ex">
<div class="ex__l">Explore more</div>
<div class="ex__ls">
<a href="/dublin/northside/camps?cat=${catSlug}" class="ex__a"><i class="ti ti-arrow-right"></i> All ${esc(category)} camps in ${esc(county)}</a>
<a href="/dublin/northside/camps?area=${areaSlug}" class="ex__a"><i class="ti ti-arrow-right"></i> All camps in ${esc(area||county)}</a>
${ageSlug ? `<a href="/dublin/northside/camps?ages=${ageSlug}" class="ex__a"><i class="ti ti-arrow-right"></i> Camps for ages ${esc(agesDisplay)}</a>` : ''}
<a href="/" class="ex__a"><i class="ti ti-arrow-right"></i> Back to all camps</a>
</div>
</div>
</div>

</div>
</div>

<footer class="footer">
<div class="footer-inner">
<span class="f-logo">sortd</span>
<div class="f-links">
<a href="/how-it-works">How it works</a>
<a href="/recommend">Recommend a camp</a>
<a href="/about">About</a>
<a href="/privacy-policy">Privacy Policy</a>
<a href="https://providers.sortd.ie">List your camp free</a>
</div>
<div class="f-bot">© 2026 sortd Ireland · Built by a mum in Malahide</div>
</div>
</footer>

</body>
</html>`;
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

try {
const startTime = Date.now();

const records = await fetchAllLiveRecords(apiKey, body.county || null);

const files = {};
const manifest = [];
let skipped = 0;

for (const record of records) {
const f = record.fields;
const name = (f[F.NAME] ||'').trim();
const provider = (f[F.PROVIDER]||'').trim();
const county = (f[F.COUNTY] ||'').trim();

if (!name || !provider || !county) { skipped++; continue; }

const countySlug = makeCountySlug(county);
const slug = makeSlug(provider, name);
const section = sectionForType(f[F.TYPE]);
const filePath = `/${section}/${countySlug}/${slug}.html`;
const pageUrl = `${BASE_URL}/${section}/${countySlug}/${slug}`;

files[filePath] = generateHTML(record, records);
manifest.push({ slug, county:countySlug, url:pageUrl, name, provider, section });
}

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
changed: commitResult ? commitResult.filesChanged.length : 0,
commitSha: commitResult ? commitResult.commitSha : null,
elapsed: `${elapsed}s`,
pages: manifest.map(m => m.url.replace(BASE_URL, '')),
}),
};

} catch (err) {
return { statusCode:500, body: JSON.stringify({ error: err.message }) };
}
};
