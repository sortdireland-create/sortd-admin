// netlify/functions/content.js
// Backend for the content calendar at /content (public/content.html).
// Reads and writes four Airtable tables in the Sortd base:
//   Content Posts, Content B-roll, Content Notes, Content Suggestions.
// Same auth pattern as generate-listings: every request carries the admin
// password in its JSON body and is checked against ADMIN_PASSWORD.
// Needs AIRTABLE_API_KEY with data.records:read AND data.records:write on
// the base (generate-listings only reads, so check the token's scopes if
// writes come back 403).

const crypto = require('crypto');

const BASE = 'appuyWkAmTRI4lN5r';
const T = {
  posts: 'tblCZXNyfRQMELByy',
  broll: 'tblBAmkYolyxfvVQm',
  notes: 'tblbYl3vPh2Wwmkzz',
  suggestions: 'tblkBTsVkMAwsdKKD',
};

// Fields the page may write on a post. Anything else is ignored.
const POST_FIELDS = new Set([
  'Title', 'Date', 'Status', 'Hook', 'Brief', 'Shot list', 'Caption', 'Hashtags',
  'Alt text', 'Ends on', 'Checks', 'Post link', 'Results', 'Film day',
  'Account', 'Kind', 'Pillar', 'Week',
]);
// Fields a suggestion may change when Rachel accepts it.
const SUGGESTABLE = new Set(['Title', 'Date', 'Hook', 'Brief', 'Shot list', 'B-roll needed', 'Caption', 'Ends on', 'Checks']);

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

function passwordOk(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function airtable(apiKey, method, path, body) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.type)) || text;
    const err = new Error(`Airtable ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function listAll(apiKey, table, query = '') {
  const out = [];
  let offset;
  do {
    const q = query + (offset ? `${query ? '&' : ''}offset=${encodeURIComponent(offset)}` : '');
    const data = await airtable(apiKey, 'GET', `${table}?pageSize=100${q ? '&' + q : ''}`);
    for (const r of data.records) out.push({ id: r.id, ...r.fields });
    offset = data.offset;
  } while (offset);
  return out;
}

function pick(fields, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) if (allowed.has(k)) out[k] = v === '' ? null : v;
  return out;
}

function todayDublin() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date());
}

async function patch(apiKey, table, id, fields) {
  const data = await airtable(apiKey, 'PATCH', table, { records: [{ id, fields }], typecast: true });
  return { id: data.records[0].id, ...data.records[0].fields };
}

async function create(apiKey, table, fields) {
  const data = await airtable(apiKey, 'POST', table, { records: [{ fields }], typecast: true });
  return { id: data.records[0].id, ...data.records[0].fields };
}

const isRec = (id) => typeof id === 'string' && /^rec[A-Za-z0-9]{14}$/.test(id);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  const apiKey = process.env.AIRTABLE_API_KEY;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  if (!passwordOk(body.password, process.env.ADMIN_PASSWORD)) return json(401, { error: 'Wrong password' });
  if (!apiKey) return json(500, { error: 'AIRTABLE_API_KEY not set in env vars' });

  try {
    switch (body.action) {
      case 'load': {
        const [posts, broll, notes, suggestions] = await Promise.all([
          listAll(apiKey, T.posts),
          listAll(apiKey, T.broll),
          listAll(apiKey, T.notes, 'sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=30'),
          listAll(apiKey, T.suggestions),
        ]);
        return json(200, { posts, broll, notes, suggestions, today: todayDublin() });
      }

      case 'updatePost': {
        if (!isRec(body.id)) return json(400, { error: 'Bad id' });
        const fields = pick(body.fields, POST_FIELDS);
        if (!Object.keys(fields).length) return json(400, { error: 'Nothing to save' });
        return json(200, { post: await patch(apiKey, T.posts, body.id, fields) });
      }

      case 'addPost': {
        const fields = pick(body.fields, POST_FIELDS);
        if (!fields.Title) return json(400, { error: 'A title is needed' });
        if (!fields.Status) fields.Status = 'Idea';
        return json(200, { post: await create(apiKey, T.posts, fields) });
      }

      case 'toggleBroll': {
        if (!isRec(body.id)) return json(400, { error: 'Bad id' });
        return json(200, { broll: await patch(apiKey, T.broll, body.id, { 'Got it': !!body.done }) });
      }

      case 'addBroll': {
        const shot = String(body.shot || '').trim().slice(0, 200);
        if (!shot) return json(400, { error: 'Describe the shot first' });
        const fields = { Shot: shot, Generic: true };
        if (body.needBy && /^\d{4}-\d{2}-\d{2}$/.test(body.needBy)) { fields['Need by'] = body.needBy; fields.Generic = false; }
        return json(200, { broll: await create(apiKey, T.broll, fields) });
      }

      case 'addNote': {
        const text = String(body.text || '').trim().slice(0, 20000);
        if (!text) return json(400, { error: 'Write a note first' });
        const day = todayDublin();
        return json(200, { note: await create(apiKey, T.notes, { Title: `Notes ${day}`, Date: day, Notes: text }) });
      }

      case 'decide': {
        if (!isRec(body.id)) return json(400, { error: 'Bad id' });
        const s = await airtable(apiKey, 'GET', `${T.suggestions}/${body.id}`);
        const f = s.fields || {};
        if (f.Status && f.Status !== 'Pending') return json(409, { error: `Already ${f.Status}` });
        let applied = null;
        if (body.accept) {
          const postId = Array.isArray(f.Post) ? f.Post[0] : null;
          if (f.Type === 'Change post' && postId && SUGGESTABLE.has(f.Field)) {
            applied = await patch(apiKey, T.posts, postId, { [f.Field]: f.Proposed || null });
          } else if (f.Type === 'New idea' || f.Type === 'Trend') {
            applied = await create(apiKey, T.posts, {
              Title: (f.Title || 'New idea').replace(/^(Trend|New idea):\s*/i, ''),
              Status: 'Idea',
              Account: '@rach.hannon',
              Brief: [f.Proposed, f.Why && `Why: ${f.Why}`, f.Source && `Source: ${f.Source}`].filter(Boolean).join('\n\n'),
            });
          }
        }
        const suggestion = await patch(apiKey, T.suggestions, body.id, { Status: body.accept ? 'Accepted' : 'Rejected' });
        return json(200, { suggestion, applied });
      }

      default:
        return json(400, { error: 'Unknown action' });
    }
  } catch (err) {
    console.error('content function error', err);
    return json(err.status === 403 ? 403 : 500, { error: err.message });
  }
};
