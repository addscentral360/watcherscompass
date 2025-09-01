// @ts-nocheck
// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
// const { enrichRatings } = require('./adapters/ratings'); // not used yet

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));


// ---- TMDB sort map (UI sort -> TMDB sort_by) ----
const TMDB_SORT_MAP = {
  pop_desc:  'popularity.desc',
  pop_asc:   'popularity.asc',
  tmdb_desc: 'vote_average.desc',
  tmdb_asc:  'vote_average.asc',
  votes_desc:'vote_count.desc',
  votes_asc: 'vote_count.asc',
  year_desc: 'primary_release_date.desc',
  year_asc:  'primary_release_date.asc',
  title_asc: 'original_title.asc',
  title_desc:'original_title.desc',
};

// ---- Meta endpoints ----
app.get('/api/genres', async (req, res) => {
  try {
   const language = req.query.language || 'en-US';
const data = await tmdbGet('/genre/movie/list', { language });
res.json(data.genres || []);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/providers?region=SE — region-scoped provider catalog
app.get('/api/providers', async (req, res) => {
  try {
    const region = (req.query.region || 'US').toUpperCase();
    const key = `provCatalog:${region}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    // ✅ Added language param for consistency
    const data = await tmdbGet('/watch/providers/movie', { 
      watch_region: region, 
      language: 'en-US' 
    });

    const list = (data?.results || []).map(p => ({
      id: p.provider_id,
      name: p.provider_name,
      logo_path: p.logo_path || null,
      priority: p.display_priority ?? 9999
    }));

    // sort by priority then A→Z
    list.sort((a,b) => (a.priority - b.priority) || String(a.name).localeCompare(b.name));

    cacheSet(key, list, 12 * 60 * 60 * 1000); // 12h
    res.json(list);

  } catch (err) {
    // ✅ Clearer error log
    console.error('providers_failed:', err);
    res.status(500).json({ error: 'providers_failed', detail: String(err.message || err) });
  }
});



// /api/search — deluxe monetization + region + providers + availability
app.get('/api/search', async (req, res) => {
  try {
    const {
      region = 'US',
      yearFrom,
      yearTo,
      genres = '',
      services = '',            // comma list of TMDB provider IDs from the UI
      monetization = '',        // comma list: flatrate,free,ads,rent,buy
      sort = 'pop_desc',
      minVotes = '0',
      page = '1',
      erotic = '0',
      query = ''
    } = req.query;

    const PAGE_SIZE = 21;           // our logical page size
    const TMDB_SIZE = 20;           // TMDB's fixed page size
    const logicalPage = Math.max(1, Number(page) || 1);
    const start = (logicalPage - 1) * PAGE_SIZE;   // 0-based start index (inclusive)
    const end   = start + PAGE_SIZE;               // 0-based end index (exclusive)

    // Build Discover params (same as before)
    const monetPipe = monetization
      ? String(monetization).split(',').filter(Boolean).join('|')
      : undefined;

    const discoverParams = {
      language: 'en-US',
      include_adult: erotic === '1' ? 'true' : 'false',
      sort_by: mapSort(sort),
      'vote_count.gte': minVotes || '0',
      watch_region: region.toUpperCase(),
      with_watch_monetization_types: monetPipe || undefined,
      with_watch_providers: services || undefined,
      with_genres: genres || undefined,
      'primary_release_date.gte': yearFrom ? `${yearFrom}-01-01` : undefined,
      'primary_release_date.lte': yearTo   ? `${yearTo}-12-31` : undefined,
      // NOTE: we do NOT set 'page' here; we'll set it in each request below
    };

    // Figure out which TMDB pages cover our [start, end) range
    const tmdbPageStart = Math.floor(start / TMDB_SIZE) + 1;        // 1-based
    const tmdbPageEnd   = Math.floor((end - 1) / TMDB_SIZE) + 1;    // 1-based

    // Fetch the first TMDB page to learn totals
    const first = await tmdbGet('/discover/movie', { ...discoverParams, page: String(tmdbPageStart) });
    const totalResults = Number(first?.total_results || 0);
    const totalPagesLogical = Math.max(1, Math.ceil(totalResults / PAGE_SIZE));

    // Collect items from the necessary TMDB pages
    let combined = Array.isArray(first?.results) ? first.results.slice() : [];

    if (tmdbPageEnd > tmdbPageStart) {
      const second = await tmdbGet('/discover/movie', { ...discoverParams, page: String(tmdbPageEnd) });
      if (Array.isArray(second?.results)) combined = combined.concat(second.results);
    }

    // Compute offset inside the combined array to slice exactly 21
    const offsetIntoCombined = start - (tmdbPageStart - 1) * TMDB_SIZE; // 0..19
    let results = combined.slice(offsetIntoCombined, offsetIntoCombined + PAGE_SIZE);

    // (Optional) Dedupe by id defensively (shouldn't be needed with TMDB)
    const seen = new Set();
    results = results.filter(r => r && r.id && !seen.has(r.id) && seen.add(r.id));

    // Fetch availability for the current set in parallel
    const ids = results.map(r => r.id).filter(Boolean);
    const availabilityList = await Promise.all(
      ids.map(id => getAvailabilityForMovie(id, region.toUpperCase()).catch(() => null))
    );
    const byIdAvail = new Map(ids.map((id, i) => [id, availabilityList[i] || null]));

    const enriched = results.map(r => ({ ...r, availability: byIdAvail.get(r.id) || null }));

    res.json({
      page: logicalPage,
      total_pages: totalPagesLogical,
      total_results: totalResults,
      results: enriched
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'search_failed', detail: String(err.message || err) });
  }
});


// ---- YouTube Trailer (best guess) ----
app.get('/api/videos/:id', async (req, res) => {
  try {
    const { id } = req.params;
const language = 'en-US';
const data = await tmdbGet(`/movie/${id}/videos`, {
  language,
  include_video_language: `${language},null`,
});

    const vids = (data?.results || [])
      .filter(v => v.site === 'YouTube')
      .sort((a, b) => {
        const rankType = t => (t === 'Trailer' ? 0 : t === 'Teaser' ? 1 : 2);
        const rt = rankType(a.type) - rankType(b.type);
        if (rt !== 0) return rt;
        if (a.official !== b.official) return a.official ? -1 : 1;
        if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
        return (new Date(b.published_at || 0)) - (new Date(a.published_at || 0));
      });

    const best = vids[0]
      ? { key: vids[0].key, name: vids[0].name, type: vids[0].type }
      : null;

    res.json(best || {});
  } catch (e) {
    console.error('Videos error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Serve client ----
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/index.html'))
);

// ---- Start server ----
app.listen(process.env.PORT || 3001, () => {
  console.log(`Server running at http://localhost:${process.env.PORT || 3001}`);
});

// ==== TMDB helpers + tiny cache ====
const TMDB_BASE = 'https://api.themoviedb.org/3';

function qs(obj) {
  const params = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return params ? `?${params}` : '';
}

async function tmdbGet(path, params = {}) {
  // Support either v4 token (Bearer) or v3 key (?api_key=)
  const hasV4 = !!process.env.TMDB_TOKEN;
  const hasV3 = !!process.env.TMDB_API_KEY;

  const headers = {};
  const p = { ...params };

  if (hasV4) {
    headers.Authorization = `Bearer ${process.env.TMDB_TOKEN}`;
  } else if (hasV3) {
    p.api_key = process.env.TMDB_API_KEY;
  } else {
    throw new Error('No TMDB credentials: set TMDB_TOKEN (v4) or TMDB_API_KEY (v3) in .env');
  }

  const url = `${TMDB_BASE}${path}${qs(p)}`;
  const r = await fetch(url, { headers });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`TMDB ${path} ${r.status}: ${t}`);
  }
  return r.json();
}


// super-simple in-memory TTL cache
const _cache = new Map(); // key -> {expires, value}
function cacheGet(key) {
  const item = _cache.get(key);
  if (!item) return undefined;
  if (Date.now() > item.expires) { _cache.delete(key); return undefined; }
  return item.value;
}
function cacheSet(key, value, ttlMs) {
  _cache.set(key, { value, expires: Date.now() + ttlMs });
}

// map our UI sort -> TMDB sort_by
function mapSort(code) {
  switch (code) {
    case 'tmdb_desc': return 'vote_average.desc';
    case 'tmdb_asc':  return 'vote_average.asc';
    case 'pop_desc':  return 'popularity.desc';
    case 'pop_asc':   return 'popularity.asc';
    case 'votes_desc':return 'vote_count.desc';
    case 'votes_asc': return 'vote_count.asc';
    case 'year_desc': return 'primary_release_date.desc';
    case 'year_asc':  return 'primary_release_date.asc';
    case 'title_asc': return 'original_title.asc';
    case 'title_desc':return 'original_title.desc';
    default:          return 'popularity.desc';
  }
}

// fetch & cache per-movie availability (watch/providers) for a region
async function getAvailabilityForMovie(movieId, region) {
  const key = `prov:${movieId}:${region}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await tmdbGet(`/movie/${movieId}/watch/providers`);
  const regionBlock = data?.results?.[region] || {};

  const pick = (arr=[]) => arr.map(p => ({
    id: p.provider_id,
    name: p.provider_name,
    logo_path: p.logo_path || null,
  }));

  const availability = {
    flatrate: pick(regionBlock.flatrate),
    free:     pick(regionBlock.free),
    ads:      pick(regionBlock.ads),
    rent:     pick(regionBlock.rent),
    buy:      pick(regionBlock.buy),
  };

  cacheSet(key, availability, 24 * 60 * 60 * 1000); // 24h
  return availability;
}

