// adapters/ratings.js
async function enrichRatings(items) {
  // TMDB-only MVP: no extra ratings yet.
  return items.map(x => ({ ...x, imdb_rating: null, rt_rating: null }));
}
module.exports = { enrichRatings };
