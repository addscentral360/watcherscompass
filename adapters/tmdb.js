// adapters/tmdb.js
require('dotenv').config();
const TMDB_BASE = 'https://api.themoviedb.org/3';

function buildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function fetchJson(url) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB error ${res.status} for ${url}`);
  return res.json();
}

async function tmdb(path, params = {}) {
  const url = `${TMDB_BASE}${path}?${buildQuery({ api_key: process.env.TMDB_API_KEY, ...params })}`;
  return fetchJson(url);
}

module.exports = { tmdb, buildQuery };
