const origin = "https://interfacepc.music.163.com";
const site = "https://music.163.com";
const logOrigin = "https://clientlog.music.163.com";
const appVersion = "3.0.18.203152";
const pageSize = 30;
const commentPageSize = 20;
const podcastPreviewSize = 24;
const songBatchSize = 300;
const sessionKey = "session";
const requestTimeout = 8000;
// Batches of 300 song details are large responses.
const songBatchTimeout = 15000;
const t = host.t;

let session;
let signInAttempt = 0;
let likedSongs;
let heartStation;
let favoriteIds;
let commentPage;
const playlistOrders = new Map();
const playlistWrites = new Map();
const sharedBrowseReads = new Map();
const playlistTrackCounts = new Map();

function fail(code, message) {
  const error = new Error(t(message));
  error.code = code;
  throw error;
}

function setting(key) {
  return String(host.setting(key) ?? "").trim().toLowerCase();
}

function currentSession() {
  // Read on first use. Hosts before 0.1.20 deadlocked on top-level storage reads.
  if (session === undefined) session = host.storage.get(sessionKey) || null;
  return session;
}

function saveSession(value) {
  if (value) host.storage.set(sessionKey, value);
  else host.storage.remove(sessionKey);
  session = value;
  likedSongs = undefined;
  favoriteIds = undefined;
  heartStation = undefined;
  commentPage = undefined;
  sharedBrowseReads.delete("daily");
  playlistOrders.clear();
  playlistTrackCounts.clear();
}

// NetEase's desktop EAPI envelope. Keep the request path and hash input in
// sync with the form body. See api-enhanced's util/crypto.js.
async function request(path, data, auth, { endpoint = origin, timeout = requestTimeout } = {}) {
  const reporting = endpoint === logOrigin;
  const header = {
    os: reporting ? "osx" : "pc",
    appver: reporting ? "3.1.10.5100" : appVersion,
    requestId: String(Date.now()),
    ...(auth ? { MUSIC_U: auth.ticket } : {}),
    ...(auth?.csrf ? { __csrf: auth.csrf } : {}),
  };
  const json = JSON.stringify({ ...data, header });
  const hash = host.crypto.md5(`nobody${path}use${json}md5forencrypt`);
  const params = host.crypto.aesEcbEncrypt(
    "e82ckenh8dichen8",
    [path, json, hash].join("-36cd479b6b5-"),
  );
  const cookie = Object.entries(header).map(([key, value]) => `${key}=${value}`).join("; ");
  const headers = { Cookie: cookie };
  if (reporting) {
    headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
  }
  return post(endpoint + "/eapi/" + path.slice(5), "params=" + params, headers, timeout);
}

function failRequest(error) {
  if (error?.name === "TimeoutError") fail("network", "NetEase Cloud Music took too long to respond. Try again.");
  fail("network", "Could not reach NetEase Cloud Music. Try again.");
}

async function post(url, body, headers, timeout = requestTimeout) {
  let response;
  let result;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeteaseMusic/${appVersion}`,
        ...headers,
      },
      body,
    });
  } catch (error) {
    failRequest(error);
  }
  try {
    result = await response.json();
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") failRequest(error);
    // Risk control and gateway errors can answer with an HTML page.
    fail("api", "NetEase Cloud Music returned an unexpected response.");
  }
  if (!result || typeof result !== "object") fail("api", "NetEase Cloud Music returned an unexpected response.");
  if (!response.ok && (typeof result.code !== "number" || result.code === 200)) {
    fail("api", "NetEase Cloud Music could not complete this request.");
  }
  return { body: result, cookies: result.code === 803 ? response.headers.getSetCookie() : [] };
}

async function api(path, data = {}, auth = currentSession(), timeout = requestTimeout) {
  const { body } = await request(path, data, auth, { timeout });
  return checked(body);
}

function checked(body) {
  if (body.code === 301 || body.code === 401) fail("signIn", "Sign in to NetEase Cloud Music.");
  if (body.code === -460) fail("api", "NetEase Cloud Music refused this action.");
  if (body.code !== 200) fail("api", "NetEase Cloud Music could not complete this request.");
  return body;
}

function cookieValue(cookies, name) {
  for (const header of cookies) {
    const pair = header.split(";", 1)[0];
    if (pair.startsWith(name + "=")) return pair.slice(name.length + 1);
  }
  return "";
}

function needSession() {
  const auth = currentSession();
  if (!auth) fail("signIn", "Sign in to NetEase Cloud Music.");
  return auth;
}

function toAccount(profile) {
  if (!profile?.userId) return null;
  return {
    id: String(profile.userId),
    name: profile.nickname,
    imageUrl: httpsImage(profile.avatarUrl),
    page: "my-page",
  };
}

async function fetchAccount(auth) {
  const { body } = await request("/api/nuser/account/get", {}, auth);
  if (body.code === 301 || body.code === 401) return null;
  if (body.code !== 200) fail("api", "NetEase Cloud Music could not complete this request.");
  return toAccount(body.profile);
}

export async function account() {
  const auth = currentSession();
  if (!auth) return null;
  const profile = await fetchAccount(auth);
  if (session !== auth) return null;
  if (!profile) saveSession(null);
  return profile;
}

export function signOut() {
  signInAttempt++;
  saveSession(null);
}

function checkAttempt(attempt) {
  if (attempt !== signInAttempt) fail("cancelled", "Sign-in was cancelled.");
}

export async function signIn() {
  const attempt = ++signInAttempt;
  const { body: start } = await request("/api/login/qrcode/unikey", { type: 3 }, null);
  checkAttempt(attempt);
  if (start.code !== 200 || !start.unikey) {
    fail("api", "Could not create a NetEase Cloud Music sign-in code.");
  }
  const qr = site + "/login?codekey=" + encodeURIComponent(start.unikey);
  host.signInPrompt({ qr, text: t("Scan with the NetEase Cloud Music app.") });
  const deadline = Date.now() + 120_000;
  let scanned = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    checkAttempt(attempt);
    if (Date.now() >= deadline) break;
    const { body, cookies } = await request(
      "/api/login/qrcode/client/login",
      { key: start.unikey, type: 3 },
      null,
    );
    checkAttempt(attempt);
    if (body.code === 800) break;
    if (body.code === 801) continue;
    if (body.code === 802) {
      if (!scanned) host.signInPrompt({ qr, text: t("Confirm sign-in on your phone.") });
      scanned = true;
      continue;
    }
    if (body.code !== 803) fail("api", "NetEase Cloud Music rejected sign-in. Try again.");
    const ticket = cookieValue(cookies, "MUSIC_U");
    const csrf = cookieValue(cookies, "__csrf");
    if (!ticket) fail("api", "NetEase Cloud Music did not return a session. Try again.");
    const profile = await fetchAccount({ ticket, csrf });
    checkAttempt(attempt);
    if (!profile) fail("api", "NetEase Cloud Music could not verify your sign-in. Try again.");
    saveSession({ ticket, csrf, userId: profile.id });
    return profile;
  }
  fail("expired", "The sign-in code expired. Try again for a new code.");
}

function httpsImage(url) {
  const address = (url || "").replace(/^http:/, "https:");
  if (!address) return "";
  try {
    const image = new URL(address);
    if (image.protocol !== "https:" || !image.hostname.endsWith(".music.126.net")) return address;
    // MyGo Music 0.1.20 replaces {size} with the pixels each view shows the
    // picture at, so rows don't download covers thousands of pixels across.
    image.searchParams.set("param", "{size}y{size}");
    return image.href;
  } catch {
    return address;
  }
}

function toArtist(row) {
  return {
    id: String(row.id),
    name: row.name,
    imageUrl: httpsImage(row.picUrl || row.img1v1Url),
    following: !!(row.followed ?? row.subed),
  };
}

function toAlbum(row) {
  const artists = row.artists || (row.artist ? [row.artist] : []);
  return {
    id: String(row.id),
    name: row.name,
    imageUrl: httpsImage(row.picUrl || row.blurPicUrl),
    artists: artists.map(toArtist),
  };
}

function toTrack(row) {
  const id = String(row.id);
  return {
    id,
    name: row.name,
    artists: (row.ar || row.artists || []).map(toArtist),
    album: toAlbum(row.al || row.album || { id: "", name: "" }),
    duration: row.dt ?? row.duration ?? 0,
    url: site + "/song?id=" + id,
  };
}

function toPlaylist(row, auth) {
  const id = String(row.id);
  if (Number.isInteger(row.trackCount) && row.trackCount > 0) {
    // A hint from cards or the sidebar, used only to size the detail request.
    playlistTrackCounts.delete(id);
    if (playlistTrackCounts.size >= 512) {
      playlistTrackCounts.delete(playlistTrackCounts.keys().next().value);
    }
    playlistTrackCounts.set(id, row.trackCount);
  }
  return {
    id,
    name: row.name,
    imageUrl: httpsImage(row.coverImgUrl || row.picUrl),
    description: row.description || "",
    owner: row.creator?.nickname || "",
    trackCount: row.trackCount || 0,
    mine: !!auth && String(row.userId ?? row.creator?.userId) === auth.userId,
    saved: !!auth && !!row.subscribed,
  };
}

function toShow(row) {
  return {
    id: String(row.id),
    name: row.name,
    imageUrl: httpsImage(row.picUrl),
    description: row.desc || "",
    publisher: row.dj?.nickname || "",
    publisherPage: row.dj?.userId ? `publisher:${row.dj.userId}` : "",
    episodeCount: row.programCount || 0,
    subscribed: !!row.subed,
  };
}

function toEpisode(row, show) {
  const audioId = row.mainTrackId || row.mainSong?.id || 0;
  return {
    id: `episode:${row.id}:${audioId}`,
    name: row.name,
    showId: show.id,
    duration: row.duration || row.mainSong?.duration || 0,
    album: { id: "", name: show.name, imageUrl: httpsImage(row.coverUrl) || show.imageUrl },
    artists: show.publisher ? [{ id: "", name: show.publisher }] : [],
    description: row.description || "",
    published: row.createTime > 0 ? new Date(row.createTime).toISOString().slice(0, 10) : "",
    url: site + "/program?id=" + row.id,
    unavailable: !audioId,
  };
}

// The program ID identifies the episode and its comments. The underlying
// track ID lets playback resolve its audio without another metadata request.
function episodeIds(id) {
  return /^episode:(\d+):(\d+)$/.exec(String(id));
}

function numericId(id) {
  const value = Number(id);
  if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(value) || value <= 0) {
    fail("unavailable", "This item is unavailable.");
  }
  return value;
}

const searches = {
  tracks: [1, "songs", "songCount", toTrack],
  albums: [10, "albums", "albumCount", toAlbum],
  artists: [100, "artists", "artistCount", toArtist],
  playlists: [1000, "playlists", "playlistCount", toPlaylist],
  shows: [1009, "djRadios", "djRadiosCount", toShow],
};

export async function search({ query, kind, offset = 0 }) {
  if (!Object.hasOwn(searches, kind) || !query.trim()) return {};
  const [type, field, total, convert] = searches[kind];
  const { result } = await api("/api/cloudsearch/pc", {
    s: query.trim(),
    type,
    offset,
    limit: pageSize,
    total: true,
  });
  const items = (result?.[field] || []).map(convert);
  return {
    [kind]: items,
    more: items.length > 0 && offset + items.length < (result?.[total] ?? 0),
  };
}

export async function suggest({ query }) {
  const keyword = query.trim();
  if (!keyword) return [];
  const { result } = await api("/api/search/suggest/web", { s: keyword }, null);
  const names = (result?.order || ["songs", "artists", "albums", "playlists"])
    .flatMap((kind) => (result?.[kind] || []).map((item) => item.name));
  return Array.from(new Set(names.filter(Boolean))).slice(0, 10);
}

export async function recent() {
  const auth = currentSession();
  if (!auth) return [];
  const { data } = await api("/api/play-record/song/list", { limit: 50 }, auth);
  if (session !== auth) return [];
  return (data?.list || []).map((item) => item.data).filter((song) => song?.id).map(toTrack);
}

export async function played({ id }) {
  const auth = currentSession();
  if (!auth || episodeIds(id) || setting("syncHistory") !== "on") return;
  // The host notifies us when playback begins. It supplies no elapsed time.
  const logs = JSON.stringify([{
    action: "startplay",
    json: { id: numericId(id), type: "song", mainsite: "1", mainsiteWeb: "1" },
  }]);
  const { body } = await request("/api/feedback/weblog", { logs }, auth, { endpoint: logOrigin });
  checked(body);
}

// Home, the daily page and the charts page can ask for the same data back to
// back. Share pending requests and briefly reuse successful, nonempty results.
function sharedBrowseRead(key, auth, load) {
  const cached = sharedBrowseReads.get(key);
  if (cached?.auth === auth && cached.until > Date.now()) return cached.result;
  const entry = { auth, until: Infinity };
  function discard() {
    if (sharedBrowseReads.get(key) === entry) sharedBrowseReads.delete(key);
  }
  entry.result = load().then((items) => {
    if (items.length) entry.until = Date.now() + 60_000;
    else discard();
    return items;
  }, (error) => {
    discard();
    throw error;
  });
  sharedBrowseReads.set(key, entry);
  return entry.result;
}

async function dailyTracks(auth) {
  const tracks = await sharedBrowseRead("daily", auth, async () => {
    const { data } = await api("/api/v3/discovery/recommend/songs", {}, auth);
    return (data?.dailySongs || []).map(toTrack);
  });
  return auth === session ? tracks : [];
}

async function dailyPlaylists(auth) {
  const { recommend } = await api("/api/v1/discovery/recommend/resource", {}, auth);
  return (recommend || []).slice(0, 15).map((row) => toPlaylist(row));
}

function chartPlaylists() {
  return sharedBrowseRead("charts", null, async () => {
    const { list } = await api("/api/toplist", {}, null);
    return (list || []).map((row) => toPlaylist(row));
  });
}

export async function home() {
  const auth = currentSession();
  const daily = auth
    ? dailyTracks(auth).catch(() => [])
    : [];
  const [recommended, tracks, today, charts] = await Promise.all([
    api("/api/personalized/playlist", { limit: 30, total: true, n: 1000 }, null).catch(() => null),
    daily,
    auth ? dailyPlaylists(auth).catch(() => []) : [],
    chartPlaylists().catch(() => []),
  ]);
  const sections = [];
  if (auth === session && tracks.length) {
    sections.push({ title: t("Daily Recommendations"), pageTitle: t("Daily Songs"), tracks });
  }
  if (auth === session && today.length) {
    sections.push({ title: t("Today's Picks for You"), playlists: today });
  }
  if (charts.length) {
    sections.push({ title: t("Official Charts"), playlists: charts.slice(0, 4), morePage: "charts" });
  }
  const dailyIds = new Set(auth === session ? today.map((row) => row.id) : []);
  const playlists = (recommended?.result || []).map((row) => toPlaylist(row))
    .filter((row) => !dailyIds.has(row.id));
  if (playlists.length) sections.push({ title: t("Recommended Playlists"), playlists });
  if (!recommended && !sections.length) fail("network", "Could not reach NetEase Cloud Music. Try again.");
  if (sections.length) {
    sections.push({ links: [{ title: t("Playlist Categories"), page: "playlist-categories" }] });
  }
  return { sections };
}

export async function browse({ page }) {
  if (page === "daily") {
    const tracks = await dailyTracks(needSession());
    return { title: t("Daily Songs"), subtitle: t("{count} tracks").replace("{count}", tracks.length), sections: [{ tracks }] };
  }
  if (page === "recent") {
    needSession();
    const tracks = await recent();
    return { title: t("Recently Played"), sections: [{ tracks, empty: t("No recently played songs.") }] };
  }
  if (page === "podcasts") return podcastBrowse();
  if (page === "playlist-categories") return playlistCategories();
  if (page === "podcast-categories") return podcastCategories();
  if (page === "my-page") return myPage();
  if (page === "popular-podcasts") {
    const popular = await popularPodcasts(100);
    return { title: t("Popular Podcasts"), sections: [{ shows: popular.shows }] };
  }
  const [kind, key, offset = "0", label] = page.split(":");
  if (kind === "playlist-category") return playlistCategory(decodeURIComponent(key), Number(offset));
  if (kind === "podcast-category") return podcastCategory(key, decodeURIComponent(label), Number(offset));
  if (kind === "publisher") return publisherPage(key);
  if (kind === "followed-artists") {
    const auth = needSession();
    const sections = [await followedArtists(auth, Number(key))];
    if (session !== auth) fail("signIn", "Sign in to NetEase Cloud Music.");
    return { title: t("Followed Artists"), sections };
  }
  if (page !== "charts") fail("unsupported", "This page is unavailable.");
  const charts = await chartPlaylists();
  const sections = [{ playlists: charts.slice(0, 4) }];
  if (charts.length > 4) sections.push({ title: t("All Charts"), playlists: charts.slice(4) });
  return { title: t("Charts"), sections };
}

async function playlistCategories() {
  const { categories, sub } = await api("/api/playlist/catalogue", {}, null);
  const groups = new Map();
  for (const { name, category } of sub || []) {
    if (!name) continue;
    const title = categories?.[category] || "";
    if (!groups.has(title)) groups.set(title, { title, links: [] });
    groups.get(title).links.push({ title: name, page: `playlist-category:${encodeURIComponent(name)}` });
  }
  return { title: t("Playlist Categories"), sections: [...groups.values()] };
}

async function playlistCategory(name, offset) {
  const data = await api("/api/playlist/list", { cat: name, order: "hot", limit: pageSize, offset, total: true }, null);
  const playlists = (data.playlists || []).map((row) => toPlaylist(row));
  const morePage = data.more && playlists.length ? `playlist-category:${encodeURIComponent(name)}:${offset + playlists.length}` : "";
  return { title: name, sections: [{ playlists, morePage, empty: t("No playlists in this category.") }] };
}

async function podcastCategories() {
  const { categories } = await api("/api/djradio/category/get", {}, null);
  const links = (categories || []).map((row) => ({
    title: row.name,
    imageUrl: httpsImage(row.pic96x96Url),
    page: `podcast-category:${row.id}:0:${encodeURIComponent(row.name)}`,
  }));
  return { title: t("Podcast Categories"), sections: [{ links }] };
}

async function podcastCategory(id, name, offset) {
  const cateId = numericId(id);
  const data = await api("/api/djradio/hot", { cateId, limit: pageSize, offset }, null);
  const shows = (data.djRadios || []).map(toShow);
  const morePage = data.hasMore && shows.length ? `podcast-category:${cateId}:${offset + shows.length}:${encodeURIComponent(name)}` : "";
  return { title: name, sections: [{ shows, morePage, empty: t("No podcasts in this category.") }] };
}

export async function shows() {
  const auth = needSession();
  const result = new Map();
  for (let offset = 0; session === auth;) {
    const data = await api("/api/djradio/get/subed", { limit: pageSize, offset, total: true }, auth);
    const rows = data.djRadios || [];
    const size = result.size;
    for (const row of rows) result.set(String(row.id), { ...toShow(row), subscribed: true });
    if (result.size === size || !(data.hasMore ?? data.more ?? (rows.length >= pageSize))) break;
    offset += rows.length;
  }
  return session === auth ? Array.from(result.values()) : [];
}

async function popularPodcasts(limit) {
  const { djRadios, hasMore } = await api("/api/djradio/hot/v1", { limit, offset: 0 }, null);
  const shows = (djRadios || []).map(toShow);
  return { shows: Array.from(new Map(shows.map((show) => [show.id, show])).values()), more: !!hasMore };
}

async function podcastBrowse() {
  const auth = currentSession();
  const [recommended, popular, subscribed] = await Promise.all([
    api("/api/djradio/recommend/v1", {}, null).catch(() => null),
    popularPodcasts(podcastPreviewSize).catch(() => null),
    auth ? shows().catch(() => []) : [],
  ]);
  const sections = [];
  if (auth === session && subscribed.length) {
    sections.push({ title: t("Subscribed Podcasts"), shows: subscribed });
  }
  if (!recommended && !popular && !sections.length) fail("network", "Could not reach NetEase Cloud Music. Try again.");
  if (recommended?.djRadios?.length) {
    sections.push({ title: t("Recommended Podcasts"), shows: recommended.djRadios.map(toShow) });
  }
  if (popular?.shows.length) {
    sections.push({
      title: t("Popular Podcasts"),
      shows: popular.shows,
      morePage: popular.more ? "popular-podcasts" : "",
    });
  }
  sections.push({ links: [{ title: t("Podcast Categories"), page: "podcast-categories" }] });
  return { title: t("Podcasts"), sections };
}

async function publisherPage(id) {
  const userId = numericId(id);
  const [details, radios] = await Promise.all([
    api(`/api/v1/user/detail/${userId}`, {}, null).catch(() => null),
    api("/api/djradio/get/byuser", { userId }, null),
  ]);
  const shows = (radios.djRadios || []).map(toShow);
  const profile = details?.profile;
  return {
    title: profile?.nickname || shows[0]?.publisher || t("Podcast Publisher"),
    imageUrl: httpsImage(profile?.avatarUrl),
    description: profile?.signature || profile?.description || "",
    sections: [{ shows, empty: t("No published podcasts.") }],
  };
}

export async function show({ id, offset = 0 }) {
  const auth = currentSession();
  const radioId = numericId(id);
  const [data, detail] = await Promise.all([
    api("/api/dj/program/byradio", { radioId, offset, limit: pageSize, asc: false }, auth),
    // The copy of the radio attached to an episode may omit the publisher.
    api("/api/djradio/v2/get", { id: radioId }, auth).catch((error) => {
      if (auth) throw error;
      return null;
    }),
  ]);
  const programs = data.programs || [];
  const radio = detail?.data || programs[0]?.radio;
  if (!radio) fail("unavailable", "This item is unavailable.");
  const show = toShow(radio);
  return {
    show,
    episodes: programs.map((program) => toEpisode(program, show)),
    more: !!data.more && programs.length > 0,
  };
}

export async function subscribeShow({ id, on }) {
  await api(on ? "/api/djradio/sub" : "/api/djradio/unsub", { id: String(numericId(id)) }, needSession());
}

const fmModes = {
  "personal-fm": ["DEFAULT", "Recommended"],
  "personal-fm-familiar": ["FAMILIAR", "Familiar"],
  "personal-fm-explore": ["EXPLORE", "Explore"],
};

export function stations() {
  const modes = Object.entries(fmModes).map(([id, [, name]]) => ({ id, name: t(name) }));
  return [...modes, { id: "heart-mode", name: t("Heart Mode") }];
}

export async function stationNext({ id }) {
  const auth = needSession();
  if (id === "heart-mode") return heartNext(auth);
  if (!Object.hasOwn(fmModes, id)) fail("unavailable", "This item is unavailable.");
  heartStation = undefined;
  const { data } = await api("/api/v1/radio/get", { mode: fmModes[id][0], limit: 3 }, auth);
  return auth === session ? (data || []).map(toTrack) : [];
}

async function heartNext(auth) {
  let state = heartStation;
  if (!state || state.auth !== auth || state.until < Date.now()) {
    state = { auth, until: Date.now() + 5 * 60_000 };
    heartStation = state;
    try {
      const favorites = await favoritePlaylist(auth);
      if (heartStation !== state) return [];
      if (!favorites) fail("unavailable", "Like a few songs to start Heart Mode.");
      const { playlist: row } = await playlistDetail(favorites.id, auth, 0);
      if (heartStation !== state) return [];
      const ids = row.trackIds || [];
      if (!ids.length) fail("unavailable", "Like a few songs to start Heart Mode.");
      state.pid = String(favorites.id);
      state.start = String(ids[Math.floor(Math.random() * ids.length)].id);
      state.last = state.start;
    } catch (error) {
      if (heartStation === state) heartStation = undefined;
      throw error;
    }
  }
  if (!state.last) return [];
  const { data } = await api("/api/playmode/intelligence/list", {
    songId: state.last,
    startMusicId: state.start,
    playlistId: state.pid,
    type: "fromPlayOne",
    count: 1,
  }, auth);
  if (heartStation !== state) return [];
  const tracks = (data || []).map((item) => item.songInfo)
    .filter((song) => song?.id && String(song.id) !== state.last).map(toTrack);
  if (tracks.length) {
    state.last = tracks[tracks.length - 1].id;
    state.until = Date.now() + 5 * 60_000;
  } else {
    heartStation = undefined;
  }
  return tracks;
}

export async function album({ id }) {
  const albumId = numericId(id);
  const auth = currentSession();
  const [data, status] = await Promise.all([
    api("/api/v1/album/" + albumId, {}, auth),
    auth ? api("/api/album/detail/dynamic", { id: albumId }, auth).catch(() => null) : null,
  ]);
  return {
    album: { ...toAlbum(data.album), saved: session === auth && !!status?.isSub },
    tracks: (data.songs || []).map(toTrack),
  };
}

export async function saveAlbum({ id, on }) {
  await api(on ? "/api/album/sub" : "/api/album/unsub", { id: String(numericId(id)) }, needSession());
}

export async function savedAlbums({ offset = 0 }) {
  const auth = needSession();
  const data = await api("/api/album/sublist", { limit: pageSize, offset, total: true }, auth);
  if (session !== auth) return { albums: [], more: false };
  const albums = (data.data || []).map((row) => ({ ...toAlbum(row), saved: true }));
  const more = data.hasMore ?? data.more ?? (offset + albums.length < (data.count || 0));
  return { albums, more: albums.length > 0 && !!more };
}

export async function artist({ id }) {
  const artistId = numericId(id);
  const auth = currentSession();
  const [songs, albums] = await Promise.all([
    api("/api/v1/artist/" + artistId, {}, auth),
    api("/api/artist/albums/" + artistId, { limit: pageSize, offset: 0, total: true }, auth),
  ]);
  return {
    artist: toArtist(songs.artist),
    tracks: (songs.hotSongs || []).map(toTrack),
    albums: (albums.hotAlbums || []).map(toAlbum),
  };
}

export async function followArtist({ id, on }) {
  const auth = needSession();
  const artistId = numericId(id);
  // NetEase rejects follows from its desktop EAPI. Use the web endpoint.
  const form = new URLSearchParams({
    artistId: String(artistId),
    artistIds: JSON.stringify([artistId]),
    csrf_token: auth.csrf || "",
  });
  const cookie = "MUSIC_U=" + auth.ticket + (auth.csrf ? "; __csrf=" + auth.csrf : "");
  const { body } = await post(site + (on ? "/api/artist/sub" : "/api/artist/unsub"), form.toString(), {
    Cookie: cookie,
    Origin: site,
    Referer: site + "/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  });
  checked(body);
}

function userPlaylists(auth, offset, limit = 100) {
  return api("/api/user/playlist", {
    uid: numericId(auth.userId),
    limit,
    offset,
    includeVideo: false,
  }, auth);
}

async function myPage() {
  const auth = needSession();
  const uid = numericId(auth.userId);
  const [profile, list, following, ranking] = await Promise.all([
    api(`/api/v1/user/detail/${uid}`, {}, auth),
    userPlaylists(auth, 0, pageSize).catch(() => null),
    followedArtists(auth, 0).catch(() => null),
    api("/api/v1/play/record", { uid, type: 1 }, auth).catch(() => null),
  ]);
  if (session !== auth) fail("signIn", "Sign in to NetEase Cloud Music.");
  const sections = [];
  const playlists = (list?.playlist || []).map((row) => toPlaylist(row, auth)).filter((row) => row.mine);
  if (playlists.length) sections.push({ title: t("My Playlists"), playlists });
  if (following?.artists.length) sections.push({ title: t("Followed Artists"), ...following });
  const tracks = (ranking?.weekData || []).slice(0, pageSize).map((row) => row.song).filter((song) => song?.id).map(toTrack);
  if (tracks.length) sections.push({ title: t("Weekly Listening Ranking"), tracks });
  return {
    title: profile.profile?.nickname || t("My Page"),
    imageUrl: httpsImage(profile.profile?.avatarUrl),
    description: profile.profile?.signature || "",
    sections,
  };
}

async function followedArtists(auth, offset) {
  const data = await api("/api/artist/sublist", { limit: pageSize, offset, total: true }, auth);
  const artists = (data.data || []).map((row) => ({ ...toArtist(row), following: true }));
  const morePage = data.hasMore && artists.length ? `followed-artists:${offset + artists.length}` : "";
  return { artists, morePage, empty: t("No followed artists.") };
}

export async function playlists() {
  const auth = needSession();
  const result = new Map();
  for (let offset = 0; session === auth;) {
    const data = await userPlaylists(auth, offset);
    if (session !== auth) return [];
    const rows = data.playlist || [];
    const size = result.size;
    for (const row of rows) result.set(String(row.id), toPlaylist(row, auth));
    if (!data.more || result.size === size) break;
    offset += rows.length;
  }
  return Array.from(result.values());
}

function playlistDetail(id, auth, count) {
  return api("/api/v6/playlist/detail", { id: numericId(id), n: count, s: 0 }, auth);
}

async function tracksById(ids, auth, initial = []) {
  const songs = new Map(initial.map((row) => [String(row.id), row]));
  const missing = ids.filter((id) => !songs.has(String(id)));
  // Use at most three requests at a time, then reconstruct the playlist order.
  for (let start = 0; start < missing.length; start += 3 * songBatchSize) {
    const requests = [];
    for (let offset = start; offset < Math.min(start + 3 * songBatchSize, missing.length); offset += songBatchSize) {
      const c = JSON.stringify(missing.slice(offset, offset + songBatchSize).map((id) => ({ id })));
      requests.push(api("/api/v3/song/detail", { c }, auth, songBatchTimeout));
    }
    for (const data of await Promise.all(requests)) {
      for (const row of data.songs || []) songs.set(String(row.id), row);
    }
  }
  return ids.map((id) => songs.get(String(id))).filter(Boolean).map(toTrack);
}

export async function playlist({ id }) {
  const auth = currentSession();
  const count = playlistTrackCounts.get(String(id));
  const embeddedLimit = count > 300 ? 0 : count > 200 ? 100 : 200;
  let { playlist: row } = await playlistDetail(id, auth, embeddedLimit);
  if (embeddedLimit === 0 && !row.trackIds?.length && (row.trackCount ?? count) > 0) {
    ({ playlist: row } = await playlistDetail(id, auth, 200));
  }
  const embedded = row.tracks || [];
  const ids = (row.trackIds || embedded).map((track) => track.id);
  const summary = toPlaylist(row, auth);
  const tracks = await tracksById(ids, auth, embedded);
  if (summary.mine && session === auth) {
    playlistOrders.set(summary.id, { ids: ids.map(String), visible: tracks.map((track) => track.id) });
  }
  return { ...summary, tracks };
}

export async function createPlaylist({ name }) {
  const auth = needSession();
  const data = await api("/api/playlist/create", { name: name.trim(), privacy: "10", type: "NORMAL" }, auth);
  const row = data.playlist || {};
  return {
    ...toPlaylist({ ...row, id: numericId(row.id || data.id), name: row.name || name.trim() }, auth),
    mine: true,
  };
}

// Keep successive edits to one playlist in order, including read-modify-write moves.
function editPlaylist(id, edit) {
  const auth = needSession();
  const pid = String(numericId(id));
  const key = auth.userId + ":" + pid;
  const prior = playlistWrites.get(key) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => {
    if (session !== auth) fail("signIn", "Sign in to NetEase Cloud Music.");
    return edit(pid, auth);
  });
  playlistWrites.set(key, next);
  return next.finally(() => {
    if (playlistWrites.get(key) === next) playlistWrites.delete(key);
  });
}

export function renamePlaylist({ id, name }) {
  return editPlaylist(id, (pid, auth) => api("/api/playlist/update/name", { id: pid, name: name.trim() }, auth));
}

export function deletePlaylist({ id }) {
  return editPlaylist(id, async (pid, auth) => {
    await api("/api/playlist/remove", { ids: JSON.stringify([Number(pid)]) }, auth);
    if (session === auth) playlistOrders.delete(pid);
  });
}

export async function savePlaylist({ id, on }) {
  await api(on ? "/api/playlist/subscribe" : "/api/playlist/unsubscribe", { id: String(numericId(id)) }, needSession());
}

async function updatePlaylistTracks(pid, op, ids, auth) {
  const payload = { pid, op, trackIds: JSON.stringify(ids), imme: "true" };
  let result = await request("/api/playlist/manipulate/tracks", payload, auth);
  // NetEase returns 512 for some add/remove requests and accepts the doubled list.
  if (result.body.code === 512 && op !== "update" && session === auth) {
    result = await request("/api/playlist/manipulate/tracks", {
      ...payload,
      trackIds: JSON.stringify(ids.concat(ids)),
    }, auth);
  }
  if (result.body.code === 502 && op === "add") fail("api", "This song is already in the playlist.");
  checked(result.body);
}

function editPlaylistTracks(id, op, trackIds) {
  return editPlaylist(id, async (pid, auth) => {
    const ids = Array.from(new Set(trackIds.map(numericId)));
    if (ids.length === 0) return;
    await updatePlaylistTracks(pid, op, ids, auth);
    if (session === auth) {
      playlistOrders.delete(pid);
      likedSongs = undefined;
      favoriteIds = undefined;
    }
  });
}

export function addToPlaylist({ id, trackIds }) {
  return editPlaylistTracks(id, "add", trackIds);
}

export function removeFromPlaylist({ id, trackIds }) {
  return editPlaylistTracks(id, "del", trackIds);
}

export function movePlaylistTrack({ id, from, to }) {
  return editPlaylist(id, async (pid, auth) => {
    let order = playlistOrders.get(pid);
    if (!order) {
      await playlist({ id: pid });
      order = playlistOrders.get(pid);
    }
    const { playlist: row } = await playlistDetail(pid, auth, 0);
    const remote = (row.trackIds || []).map((track) => String(track.id));
    if (session !== auth) fail("signIn", "Sign in to NetEase Cloud Music.");
    if (!order || !Number.isInteger(from) || !Number.isInteger(to) ||
        !order.visible[from] || !order.visible[to] ||
        order.ids.length !== remote.length || remote.some((id, index) => id !== order.ids[index])) {
      fail("api", "This playlist changed. Reopen it before changing the order.");
    }
    if (from === to) return;
    const visible = order.visible.slice();
    visible.splice(to, 0, visible.splice(from, 1)[0]);
    const displayed = new Set(order.visible);
    let at = 0;
    const ids = remote.map((id) => displayed.has(id) ? visible[at++] : id);
    await updatePlaylistTracks(pid, "update", ids.map(numericId), auth);
    if (session === auth) {
      playlistOrders.set(pid, { ids, visible });
      favoriteIds = undefined;
    }
  });
}

async function songLikes(auth) {
  if (likedSongs?.auth === auth && likedSongs.until > Date.now()) return likedSongs.result;
  const entry = { auth, until: Date.now() + 45_000 };
  entry.result = api("/api/song/like/get", { uid: String(numericId(auth.userId)) }, auth)
    .then((data) => {
      // A write can invalidate an in-flight read before it returns.
      if (session === auth && likedSongs !== entry) return songLikes(auth);
      return new Set((data.ids || []).map(String));
    })
    .catch((error) => {
      if (likedSongs === entry) likedSongs = undefined;
      throw error;
    });
  likedSongs = entry;
  return entry.result;
}

export async function isLiked({ ids }) {
  const auth = currentSession();
  if (!auth) return {};
  const songs = [];
  const episodes = new Map();
  for (const id of ids) {
    const episode = episodeIds(id);
    if (episode) episodes.set(episode[1], id);
    else songs.push(id);
  }
  const [liked, programs] = await Promise.all([
    songs.length ? songLikes(auth) : null,
    episodes.size ? api("/api/resource/commentInfo/list", {
      resourceType: "1",
      resourceIds: JSON.stringify(Array.from(episodes.keys(), numericId)),
    }, auth) : null,
  ]);
  if (session !== auth) return {};
  const result = Object.fromEntries(songs.map((id) => [id, liked.has(id)]));
  for (const row of programs?.data || []) {
    const id = episodes.get(String(row.resourceId));
    if (id) result[id] = !!row.liked;
  }
  return result;
}

export async function like({ id, on }) {
  const auth = needSession();
  await api("/api/radio/like", {
    alg: "itembased",
    trackId: String(numericId(id)),
    like: String(on),
    time: "3",
  }, auth);
  if (session === auth) {
    likedSongs = undefined;
    favoriteIds = undefined;
  }
}

export async function likeEpisode({ id, on }) {
  const auth = needSession();
  const episode = episodeIds(id);
  if (!episode) fail("unavailable", "This item is unavailable.");
  await api(on ? "/api/resource/like" : "/api/resource/unlike", {
    threadId: "A_DJ_1_" + numericId(episode[1]),
  }, auth);
}

// The favorites order, cached briefly so later pages of liked songs skip two requests.
function favoriteTrackIds(auth, fresh) {
  if (!fresh && favoriteIds?.auth === auth && favoriteIds.until > Date.now()) return favoriteIds.result;
  const entry = { auth, until: Date.now() + 45_000 };
  entry.result = (async () => {
    const favorites = await favoritePlaylist(auth);
    if (!favorites) return null;
    const { playlist: row } = await playlistDetail(favorites.id, auth, 0);
    return { pid: String(favorites.id), ids: (row.trackIds || []).map((track) => String(track.id)) };
  })().catch((error) => {
    if (favoriteIds === entry) favoriteIds = undefined;
    throw error;
  });
  favoriteIds = entry;
  return entry.result;
}

async function favoritePlaylist(auth) {
  const { playlist: rows } = await userPlaylists(auth, 0);
  return (rows || []).find((row) => row.specialType === 5 && String(row.userId ?? row.creator?.userId) === auth.userId);
}

export async function liked({ offset = 0 }) {
  const auth = needSession();
  // The built-in favorites playlist keeps the listener's order.
  const favorites = await favoriteTrackIds(auth, offset === 0);
  if (!favorites) return { tracks: [], more: false };
  const ids = favorites.ids.slice(offset, offset + pageSize);
  const tracks = await tracksById(ids, auth);
  if (session !== auth) return { tracks: [], more: false };
  return { tracks, more: offset + ids.length < favorites.ids.length };
}

function timedTranslations(lrc, lines) {
  const offset = Number(/^\[offset:([+-]?\d+)\]/im.exec(lrc)?.[1] || 0);
  const nearest = new Map();
  for (const raw of lrc.split("\n")) {
    const stamps = Array.from(raw.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g));
    if (!stamps.length) continue;
    const last = stamps[stamps.length - 1];
    const text = raw.slice(last.index + last[0].length).trim();
    if (!text) continue;
    for (const [, minutes, seconds, fraction = ""] of stamps) {
      const start = Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(fraction.padEnd(3, "0")) + offset;
      let best;
      let gap = 1500;
      for (const line of lines) {
        const distance = Math.abs(line.start - start);
        if (distance < gap) {
          best = line;
          gap = distance;
        }
      }
      if (best && gap < (nearest.get(best) ?? Infinity)) {
        best.translation = text;
        nearest.set(best, gap);
      }
    }
  }
}

function yrcLines(yrc, translation) {
  const lines = [];
  for (const raw of yrc.split("\n")) {
    const line = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trimEnd());
    if (!line) continue;
    const start = Number(line[1]);
    const body = line[3];
    const stamps = Array.from(body.matchAll(/\((\d+),(\d+),\d+\)/g));
    const words = stamps.map((stamp, index) => ({
      start: Number(stamp[1]),
      end: Number(stamp[1]) + Number(stamp[2]),
      text: body.slice(stamp.index + stamp[0].length, stamps[index + 1]?.index),
    })).filter((word) => word.text);
    const text = words.map((word) => word.text).join("").trim();
    if (text) lines.push({ start, end: start + Number(line[2]), text, words });
  }
  lines.sort((a, b) => a.start - b.start);
  if (lines.length && translation) timedTranslations(translation, lines);
  return lines;
}

export async function lyrics({ id }) {
  if (episodeIds(id)) return { lrc: "", translation: "" };
  const song = numericId(id);
  const data = await api("/api/song/lyric/v1", {
    id: String(song), cp: false, lv: 0, tv: 0, kv: 0, rv: 0, yv: 0, ytv: 0, yrv: 0,
  }).catch(() => null);
  if (data) {
    const translation = data.tlyric?.lyric || data.ytlrc?.lyric || "";
    const lines = yrcLines(data.yrc?.lyric || "", translation);
    if (lines.length || data.lrc?.lyric || data.nolyric) {
      return { lrc: data.lrc?.lyric || "", translation, lines };
    }
  }
  const fallback = await api("/api/song/lyric", { id: song, lv: -1, tv: -1, kv: -1, rv: -1 });
  return { lrc: fallback.lrc?.lyric || "", translation: fallback.tlyric?.lyric || "" };
}

function commentThread(trackId) {
  const episode = episodeIds(trackId);
  return episode ? "A_DJ_1_" + numericId(episode[1]) : "R_SO_4_" + numericId(trackId);
}

function toComment(row) {
  return {
    id: String(row.commentId),
    author: row.user?.nickname || "",
    avatarUrl: httpsImage(row.user?.avatarUrl),
    text: row.content,
    time: row.time,
    likes: row.likedCount || 0,
    liked: !!row.liked,
  };
}

export async function comments({ trackId, offset = 0 }) {
  const threadId = commentThread(trackId);
  if (offset === 0 || commentPage?.threadId !== threadId) commentPage = { threadId, posted: 0 };
  // The host prepends newly posted comments to the visible count, but they
  // do not occupy a position among the hot comments already fetched.
  const hotOffset = Math.max(0, offset - commentPage.posted);
  const { data } = await api("/api/v2/resource/comments", {
    threadId,
    pageNo: Math.floor(hotOffset / commentPageSize) + 1,
    pageSize: commentPageSize,
    cursor: "normalHot#" + hotOffset,
    sortType: 2,
    showInner: true,
  });
  const rows = data?.comments || [];
  return {
    comments: rows.map(toComment),
    total: data?.totalCount || 0,
    more: !!data?.hasMore && rows.length > 0,
  };
}

export async function postComment({ trackId, text }) {
  const auth = needSession();
  const content = text.trim();
  if (!content) fail("api", "Enter a comment first.");
  const threadId = commentThread(trackId);
  const page = commentPage;
  const { comment } = await api("/api/resource/comments/add", { threadId, content, e_r: false }, auth);
  if (!comment?.commentId) fail("api", "NetEase Cloud Music returned an unexpected response.");
  if (session === auth && commentPage === page && page?.threadId === threadId) page.posted++;
  return toComment(comment);
}

export async function likeComment({ trackId, commentId, on }) {
  await api(on ? "/api/v1/comment/like" : "/api/v1/comment/unlike", {
    threadId: commentThread(trackId),
    commentId: String(numericId(commentId)),
  }, needSession());
}

async function streamAt(id, level, auth) {
  const { data } = await api("/api/song/enhance/player/url/v1", {
    ids: JSON.stringify([id]),
    level,
    encodeType: ["lossless", "hires"].includes(level) ? "flac" : "mp3",
    e_r: false,
  }, auth);
  const audio = data?.[0];
  if (!audio?.url || audio.code !== 200 || (audio.freeTrialInfo && audio.freeTrialInfo !== "null")) return null;
  return audio;
}

export async function stream({ id, quality }) {
  const episode = episodeIds(id);
  const audioId = numericId(episode ? episode[2] : id);
  const preference = setting("quality");
  const defaultLevel = quality === "lossless" ? "lossless" : quality === "high" ? "exhigh" : "standard";
  let level = ["standard", "higher", "exhigh", "lossless", "hires"].includes(preference) ? preference : defaultLevel;
  const auth = currentSession();
  let audio = await streamAt(audioId, level, auth);
  // Try exhigh before standard so accounts without lossless keep 320k.
  const fallbacks = ["lossless", "hires"].includes(level) ? ["exhigh", "standard"] : level === "standard" ? [] : ["standard"];
  for (const lower of fallbacks) {
    if (audio || session !== auth) break;
    level = lower;
    audio = await streamAt(audioId, level, auth);
  }
  if (!audio) {
    fail("unavailable", "The full track is unavailable for this account or region.");
  }
  const url = new URL(audio.url);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname.endsWith(".music.126.net")) {
    fail("unavailable", "This item is unavailable.");
  }
  url.protocol = "https:";
  const format = (audio.type || "").toLowerCase();
  const type = format === "mp4" ? "m4a" : format;
  if (!["mp3", "flac", "ogg", "m4a", "aac"].includes(type)) {
    fail("unsupported", "This audio format is unsupported.");
  }
  return {
    url: url.href,
    type,
    quality: type === "flac" ? "lossless" :
      audio.level === "standard" || level === "standard" ? "standard" : "high",
    bitRate: audio.br || 0,
    size: audio.size || 0,
    gain: audio.gain || 0,
    peak: audio.peak || 0,
  };
}
