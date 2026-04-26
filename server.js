import express from 'express';
import { gotScraping } from 'got-scraping';
import { readFileSync } from 'node:fs';

const app = express();
const PORT = process.env.PORT || 3000;

// Internal token shared with master-admin's /admin/api/validate_key.php
const INTERNAL_TOKEN = (() => {
  try { return readFileSync('/opt/master-admin-internal.token', 'utf8').trim(); }
  catch { return ''; }
})();

const VALIDATOR_URL = process.env.VALIDATOR_URL || 'http://127.0.0.1/admin/api/validate_key.php';

// Tiny in-memory positive-cache so we don't pound the master on bursty traffic.
const validateCache = new Map();
const VALIDATE_CACHE_MS = 5000;

async function validateKey(payload) {
  const cacheKey = `${payload.api_key}|${payload.domain || ''}|${payload.service || ''}`;
  const cached = validateCache.get(cacheKey);
  if (cached && Date.now() - cached.t < VALIDATE_CACHE_MS) {
    return cached.v;
  }

  if (!INTERNAL_TOKEN) {
    return { allowed: false, reason: 'internal token missing' };
  }

  try {
    const r = await fetch(VALIDATOR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const v = { allowed: !!j.allowed, reason: j.reason || null, license_id: j.license_id || null };
    if (v.allowed) validateCache.set(cacheKey, { t: Date.now(), v });
    return v;
  } catch (err) {
    return { allowed: false, reason: 'validator unreachable: ' + err.message };
  }
}

function requireApiKey(service) {
  return async (req, res, next) => {
    const key = (req.query.api_key || req.get('x-api-key') || '').trim();
    if (!key) return res.status(401).json({ error: 'missing api_key' });

    const domain = (req.query.domain || req.get('x-forwarded-host') || req.get('host') || '').split(':')[0];
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    const ua = (req.get('user-agent') || '').slice(0, 500);

    const v = await validateKey({
      api_key: key,
      service,
      endpoint: req.path,
      domain,
      ip,
      user_agent: ua,
      status_code: 200,
    });

    if (!v.allowed) {
      return res.status(401).json({ error: 'forbidden', reason: v.reason });
    }
    req.licenseId = v.license_id;
    next();
  };
}

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function stripDiacritics(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function fetchXtream(url) {
  try {
    const res = await gotScraping({
      url,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
      timeout: { request: 20000 },
      throwHttpErrors: false,
      retry: { limit: 0 },
    });
    return { status: res.statusCode, body: res.body };
  } catch (err) {
    return { status: 0, body: '', error: err.message };
  }
}

app.get('/test', requireApiKey('buscador'), async (req, res) => {
  const { username, password, baseurl } = req.query;
  if (!username || !password || !baseurl) {
    return res.status(400).json({ error: 'missing params' });
  }
  const url = `${baseurl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`;
  const out = await fetchXtream(url);
  res.json({ status: out.status, error: out.error || null, sample: (out.body || '').slice(0, 400) });
});

app.get('/buscador', requireApiKey('buscador'), async (req, res) => {
  const { username, password, baseurl, tipoid = '0', search = '' } = req.query;
  if (!username || !password || !baseurl) {
    return res.status(400).json({ error: 'missing params' });
  }

  const types = tipoid === '0' || tipoid === 'all'
    ? [['live', 'get_live_streams', '1'], ['movies', 'get_vod_streams', '2'], ['series', 'get_series', '3']]
    : tipoid === '1' ? [['live', 'get_live_streams', '1']]
    : tipoid === '2' ? [['movies', 'get_vod_streams', '2']]
    : tipoid === '3' ? [['series', 'get_series', '3']]
    : [];

  if (!types.length) return res.status(400).json({ error: 'invalid tipoid' });

  const out = { live: [], movies: [], series: [], _debug: {} };
  const term = stripDiacritics(search.toLowerCase());

  await Promise.all(types.map(async ([key, action, tid]) => {
    const cacheKey = `${username}|${baseurl}|${tid}`;
    let data;
    const c = cache.get(cacheKey);
    if (c && Date.now() - c.t < CACHE_TTL) {
      data = c.data;
    } else {
      const url = `${baseurl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${action}`;
      const r = await fetchXtream(url);
      if (r.status !== 200) {
        out._debug[key] = `HTTP ${r.status}${r.error ? ' - ' + r.error : ''}`;
        return;
      }
      try { data = JSON.parse(r.body); }
      catch { out._debug[key] = `parse fail (len=${r.body.length})`; return; }
      if (!Array.isArray(data)) { out._debug[key] = 'not array'; return; }
      cache.set(cacheKey, { t: Date.now(), data });
    }

    let filtered = data;
    if (term) filtered = data.filter(s => stripDiacritics((s.name || '').toLowerCase()).includes(term));
    filtered = filtered.slice(0, 50).map(s => {
      const ext = s.container_extension || 'ts';
      const folder = tid === '2' ? 'movie' : tid === '3' ? 'series' : 'live';
      const playExt = tid === '1' ? 'ts' : ext;
      return { ...s, url_reproduccion: `${baseurl}/${folder}/${username}/${password}/${s.stream_id}.${playExt}` };
    });
    out[key] = filtered;
  }));

  if (Object.keys(out._debug).length === 0) delete out._debug;
  res.json(out);
});

app.get('/', (req, res) => res.json({ ok: true, service: 'xtream-proxy' }));

app.listen(PORT, () => console.log(`xtream-proxy listening on :${PORT}`));
