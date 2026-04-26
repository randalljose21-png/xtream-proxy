import express from 'express';
import { gotScraping } from 'got-scraping';

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/test', async (req, res) => {
  const { username, password, baseurl } = req.query;
  if (!username || !password || !baseurl) {
    return res.status(400).json({ error: 'missing params' });
  }
  const url = `${baseurl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`;
  const out = await fetchXtream(url);
  res.json({ status: out.status, error: out.error || null, sample: (out.body || '').slice(0, 400) });
});

app.get('/buscador', async (req, res) => {
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
