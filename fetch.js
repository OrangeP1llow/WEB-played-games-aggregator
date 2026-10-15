// fetch.js: collects your Steam and PlayStation data into stats.json + stats.js and downloads cover art.
// Run: node fetch.js   (Node.js 18+. Steam needs no packages; PlayStation needs: npm install psn-api)
const fs = require("fs");
const path = require("path");
process.chdir(__dirname);

const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
const isSet = v => v && !/PASTE|ВСТАВТЕ/i.test(v);
const STEAM_KEY = cfg.steamApiKey, STEAM_ID = cfg.steamId, NPSSO = cfg.psnNpsso;
const doSteam = isSet(STEAM_KEY) && isSet(STEAM_ID);
const doPsn = isSet(NPSSO);
if (!doSteam && !doPsn) {
  console.error("Nothing to do: fill in steamApiKey and/or psnNpsso in config.json.");
  process.exit(1);
}

const CACHE = ".cache.json";
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run fn over items with at most n requests in flight (keeps us under rate limits)
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function getJson(url, retry = true) {
  const r = await fetch(url);
  if (r.status === 429 && retry) { await sleep(5000); return getJson(url, false); }
  return r;
}

// Download the first working URL to `file` (skips if already downloaded)
async function download(urls, file) {
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (r.ok) { fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return file; }
    } catch { /* try next URL */ }
  }
  return null;
}

/* ---------------- Steam ---------------- */
async function steamAchievements(g) {
  const c = cache[g.appid];
  if (c && c.lp === g.rtime_last_played) return c; // not played since last run: reuse
  const r = await getJson(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${STEAM_ID}&appid=${g.appid}&format=json`);
  let a = 0, t = 0;
  if (r.ok) {
    const list = (await r.json()).playerstats?.achievements || [];
    t = list.length; a = list.filter(x => x.achieved).length;
  } else if (r.status !== 400) {
    return { a: 0, t: 0 }; // temporary error: don't cache
  } // 400 = the game has no achievements
  return (cache[g.appid] = { lp: g.rtime_last_played, a, t });
}

async function fetchSteam() {
  console.log("Steam: fetching game list...");
  const r = await getJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${STEAM_ID}&include_appinfo=1&include_played_free_games=1&format=json`);
  if (r.status === 401 || r.status === 403) throw new Error("Steam rejected the key. Check steamApiKey in config.json.");
  const owned = (await r.json()).response?.games || [];
  if (!owned.length) throw new Error("Game list is empty. Most likely your profile is private: Steam → Privacy → 'Game details' must be Public.");

  const played = owned.filter(g => g.playtime_forever > 0);
  console.log(`Steam: ${owned.length} games, ${played.length} with playtime. Fetching achievements and covers...`);
  let done = 0;
  const games = await pool(played, 5, async g => {
    const [ach, img] = await Promise.all([
      steamAchievements(g),
      download([
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`
      ], `covers/steam/${g.appid}.jpg`)
    ]);
    if (++done % 20 === 0) console.log(`  ${done}/${played.length}`);
    return { appid: g.appid, n: g.name, h: Math.round(g.playtime_forever / 60 * 10) / 10, a: ach.a, t: ach.t, last: (g.rtime_last_played || 0) * 1000, img };
  });
  games.sort((x, y) => y.h - x.h);
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  const totals = { games: games.length, hours: Math.round(games.reduce((s, g) => s + g.h, 0)), achievements: games.reduce((s, g) => s + g.a, 0) };
  console.log(`Steam done: ${totals.games} games, ${totals.hours} h, ${totals.achievements} achievements`);
  return { games, totals };
}

/* ---------------- PlayStation ---------------- */
const norm = s => String(s).toLowerCase().replace(/[™®©]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
const isoToHours = d => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  return m ? Math.round(((+m[1] || 0) + (+m[2] || 0) / 60 + (+m[3] || 0) / 3600) * 10) / 10 : 0;
};
const sumTroph = o => (o?.bronze || 0) + (o?.silver || 0) + (o?.gold || 0) + (o?.platinum || 0);

async function fetchPsn() {
  console.log("PSN: signing in...");
  let psn;
  try { psn = await import("psn-api"); }
  catch { throw new Error("Package 'psn-api' is missing. Run: npm install psn-api"); }

  let auth;
  try {
    const code = await psn.exchangeNpssoForCode(NPSSO);
    auth = await psn.exchangeCodeForAccessToken(code);
  } catch {
    throw new Error("Could not sign in. The NPSSO token is wrong or expired: get a fresh one (see README).");
  }

  // 1) Trophy titles: every game you earned at least one trophy in (PS3, PS4, PS5, Vita)
  const titles = [];
  for (let offset = 0; ; ) {
    const r = await psn.getUserTitles(auth, "me", { limit: 100, offset });
    titles.push(...(r.trophyTitles || []));
    if (!r.nextOffset) break;
    offset = r.nextOffset;
  }
  const summary = await psn.getUserTrophyProfileSummary(auth, "me");

  // 2) Play time (PS4/PS5 only). If this fails we just skip hours.
  const hoursByName = {}, lastByName = {};
  let psnApps = [];
  try {
    const played = [];
    for (let offset = 0, i = 0; i < 20; i++) {
      const r = await psn.getUserPlayedGames(auth, "me", { limit: 200, offset });
      const batch = r.titles || [];
      played.push(...batch);
      const total = r.totalItemCount;
      if (!batch.length || (total != null && played.length >= total) || (r.nextOffset == null && batch.length < 200)) break;
      offset = r.nextOffset ?? offset + batch.length;
    }
    // Media / streaming apps (categories like *_nongame_mini_app, *_media_app) are not games: keep them out of the totals
    const isApp = c => /nongame|_app$/i.test(c || "");
    const byCat = {};
    for (const p of played) {
      const h = isoToHours(p.playDuration), c = p.category || "(none)";
      byCat[c] = byCat[c] || { games: 0, hours: 0 };
      byCat[c].games++; byCat[c].hours += h;
      if (isApp(c)) { psnApps.push({ n: p.name, h, category: c }); continue; }
      const k = norm(p.name);
      hoursByName[k] = (hoursByName[k] || 0) + h;
      lastByName[k] = Math.max(lastByName[k] || 0, Date.parse(p.lastPlayedDateTime) || 0);
    }
    console.log(`PSN: play time found for ${played.length} titles. Breakdown by category:`);
    for (const [c, v] of Object.entries(byCat)) console.log(`  ${c}: ${v.games} titles, ${Math.round(v.hours)} h${isApp(c) ? "  (app, not counted)" : ""}`);
    var playedList = played.filter(p => !isApp(p.category));
  } catch (e) {
    console.warn("PSN: could not read play time, hours will be empty (" + e.message + ")");
    var playedList = [];
  }

  const modern = titles.filter(t => /PS4|PS5/.test(t.trophyTitlePlatform));
  const ps3 = titles.filter(t => /PS3/.test(t.trophyTitlePlatform) && !/PS4|PS5/.test(t.trophyTitlePlatform));
  console.log(`PSN: ${modern.length} PS4/PS5 and ${ps3.length} PS3 trophy titles. Downloading covers...`);

  const withCover = t => download([t.trophyTitleIconUrl], `covers/psn/${t.npCommunicationId}.png`);
  // The same game on PS4 and PS5 shares one play-time entry: count its hours only once
  const hourOwner = new Set();
  const hrs = modern.map(t => { const k = norm(t.trophyTitleName); if (hourOwner.has(k)) return 0; hourOwner.add(k); return Math.round((hoursByName[k] || 0) * 10) / 10; });
  const games = await pool(modern, 5, async (t, i) => ({
    n: t.trophyTitleName,
    h: hrs[i],
    a: sumTroph(t.earnedTrophies), t: sumTroph(t.definedTrophies),
    last: Math.max(lastByName[norm(t.trophyTitleName)] || 0, Date.parse(t.lastUpdatedDateTime) || 0),
    img: await withCover(t)
  }));
  // Games with play time but no trophies
  const known = new Set(modern.map(t => norm(t.trophyTitleName)));
  const seen = new Set();
  for (const p of playedList) {
    const k = norm(p.name);
    if (known.has(k) || seen.has(k)) continue;
    seen.add(k);
    const h = Math.round((hoursByName[k] || 0) * 10) / 10; // all editions of this game combined
    if (h > 0) games.push({ n: p.name, h, a: 0, t: 0, last: Date.parse(p.lastPlayedDateTime) || 0, img: await download([p.imageUrl].filter(Boolean), `covers/psn/${k.slice(0, 60)}.png`) });
  }
  games.sort((x, y) => y.h - x.h || y.a - x.a);

  const ps3list = await pool(ps3, 5, async t => ({ n: t.trophyTitleName, img: await withCover(t) }));
  const trophies = summary.earnedTrophies || {};
  const hours = Math.round(games.reduce((s, g) => s + g.h, 0));
  console.log(`PSN done: ${games.length} PS4/PS5 games, ${hours} h, ${trophies.platinum || 0} platinums`);
  return { games, ps3: ps3list, trophies, level: summary.trophyLevel, apps: psnApps };
}

/* ---------------- main ---------------- */
(async () => {
  const out = fs.existsSync("stats.json") ? JSON.parse(fs.readFileSync("stats.json", "utf8")) : {};
  if (doSteam) { try { out.steam = await fetchSteam(); } catch (e) { console.error("Steam error:", e.message); } }
  if (doPsn) { try { out.psn = await fetchPsn(); } catch (e) { console.error("PSN error:", e.message); } }
  out.updated = new Date().toISOString();
  fs.writeFileSync("stats.json", JSON.stringify(out, null, 1));
  fs.writeFileSync("stats.js", "window.STATS=" + JSON.stringify(out) + ";"); // read by index.html
  console.log("Saved stats.json and stats.js. Open index.html.");
})();
