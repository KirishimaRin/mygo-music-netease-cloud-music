import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
const auth = { userId: "1", ticket: "mock-ticket" };
let runtime = 0;

async function loadPlugin(handle, account = auth) {
  globalThis.host = {
    t: (value) => value,
    storage: { get: () => account, remove() {} },
    setting: (key) => key === "syncHistory" ? "true" : "",
    crypto: {
      md5: () => "",
      aesEcbEncrypt: (_, value) => encodeURIComponent(value.split("-36cd479b6b5-")[1]),
    },
  };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const data = JSON.parse(new URLSearchParams(options.body).get("params"));
    const result = await handle(path, data);
    assert.ok(result, `Unexpected request: ${path}`);
    return new Response(JSON.stringify({ code: 200, ...result }));
  };
  const text = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${text}#${++runtime}`);
}

const song = (id) => ({ id, name: String(id) });
const playlist = (id, userId) => ({ id, userId, name: String(id), subscribed: true });
const trackIds = (result) => result.tracks.map((track) => Number(track.id));

test("cloud search keeps the server offset across a page with no matches", async () => {
  const plugin = await loadPlugin((path, { offset, limit }) => {
    assert.equal(path, "/eapi/v1/cloud/get");
    assert.equal(limit, 100);
    return offset === 0
      ? { data: [{ songId: 7, songName: "Other" }], hasMore: true }
      : { data: [{ songId: 12, songName: "Cloud Only", simpleSong: { t: 1 }, cover: 0 }], hasMore: false };
  });
  const first = await plugin.cloudTracks({ query: "cloud" });
  assert.deepEqual(first, { tracks: [], next: 1 });
  const second = await plugin.cloudTracks({ query: "cloud", offset: first.next });
  assert.deepEqual(trackIds(second), [12]);
  assert.equal(second.tracks[0].url, "");
  assert.equal(second.next, 0);
});

test("wiki keeps the mobile block order and maps native artist, song and playlist destinations", async () => {
  const plugin = await loadPlugin((path, { extJson }) => {
    assert.equal(path, "/eapi/link/page/parent/relation/construct/info");
    assert.equal(JSON.parse(extJson).states.playingResource.current, 12);
    return { data: { blocks: [
      { positionCode: "songDetailNewSongWiki", rnData: { blocks: [
        { blockInfo: { blockName: "Credits", wikiSubElementVos: [
          { title: "Composer", wikiSubMetaVos: [{ text: "Artist", jumpUrl: "orpheus://nm/artist/home?id=45" }] },
        ] } },
        { blockInfo: { blockName: "Empty", wikiSubElementVos: [] } },
      ] } },
      { positionCode: "songWikiSimSongs", rnData: { simSongs: [song(24)] } },
      { positionCode: "songWikiSimPlaylist", rnData: { simPlaylist: [{ playlistId: 56, name: "List" }] } },
    ] } };
  });
  const { sections } = await plugin.songWiki({ trackId: "12" });
  assert.deepEqual(sections.map((part) => part.title), ["Credits", "Similar Songs", "Related Playlists"]);
  assert.equal(sections[0].entries[0].artistId, "45");
  assert.equal(sections[1].tracks[0].id, "24");
  assert.equal(sections[2].entries[0].playlistId, "56");
});

function playlistBackend(ids, unavailable = new Set()) {
  const backend = { ids, updates: [], detailBatches: [], favoriteReads: 0 };
  backend.handle = (path, data) => {
    if (path === "/eapi/user/playlist") {
      backend.favoriteReads++;
      return { playlist: [{ ...playlist(99, 1), specialType: 5 }] };
    }
    if (path === "/eapi/v6/playlist/detail") {
      return { playlist: {
        ...playlist(99, 1), trackCount: backend.ids.length, trackIds: backend.ids.map(song),
      } };
    }
    if (path === "/eapi/v3/song/detail") {
      const requested = JSON.parse(data.c).map(({ id }) => Number(id));
      backend.detailBatches.push(requested);
      return { songs: requested.filter((id) => !unavailable.has(id)).map(song) };
    }
    if (path === "/eapi/playlist/manipulate/tracks") {
      const ids = JSON.parse(data.trackIds);
      if (data.op === "del") backend.ids = backend.ids.filter((id) => !ids.includes(id));
      if (data.op === "update") {
        backend.updates.push(ids);
        backend.ids = ids;
      }
      return {};
    }
  };
  return backend;
}

test("playlist search uses the account for every hit, including the first", async () => {
  const result = { result: { playlists: [playlist(10, 2), playlist(11, 1)], playlistCount: 2 } };
  const handle = (path) => path === "/eapi/cloudsearch/pc" ? result : undefined;
  const plugin = await loadPlugin(handle);
  const search = () => plugin.search({ query: "playlist", kind: "playlists" });
  const flags = ({ playlists }) => playlists.map(({ mine, saved }) => [mine, saved]);
  assert.deepEqual(flags(await search()), [[false, true], [true, true]]);

  const inFlight = search();
  plugin.signOut();
  assert.deepEqual(flags(await inFlight), [[false, false], [false, false]]);
  assert.deepEqual(flags(await search()), [[false, false], [false, false]]);
});

test("reorder after removal preserves hidden entries and follows the visible indexes", async () => {
  const backend = playlistBackend([11, 12, 13, 14], new Set([12]));
  const plugin = await loadPlugin(backend.handle);
  assert.deepEqual(trackIds(await plugin.playlist({ id: "99" })), [11, 13, 14]);
  await plugin.removeFromPlaylist({ id: "99", trackIds: ["11"] });
  await plugin.movePlaylistTrack({ id: "99", from: 1, to: 0 });
  assert.deepEqual(backend.updates, [[12, 14, 13]]);
});

test("reorder rejects a missing or remotely changed snapshot before writing", async () => {
  const backend = playlistBackend([11, 12, 13, 14]);
  const plugin = await loadPlugin(backend.handle);
  const move = () => plugin.movePlaylistTrack({ id: "99", from: 1, to: 0 });
  await assert.rejects(move(), /This playlist changed/);
  await plugin.playlist({ id: "99" });
  await plugin.removeFromPlaylist({ id: "99", trackIds: ["14"] });
  backend.ids = [13, 11, 12];
  await assert.rejects(move(), /This playlist changed/);
  assert.deepEqual(backend.updates, []);
});

test("liked pages use visible offsets even across a full batch of missing details", async () => {
  const ids = Array.from({ length: 95 }, (_, i) => i + 1);
  const unavailable = new Set([1, ...ids.slice(30, 60), 95]);
  const backend = playlistBackend(ids, unavailable);
  const plugin = await loadPlugin(backend.handle);
  const expected = ids.filter((id) => !unavailable.has(id));
  const first = await plugin.liked({});
  assert.deepEqual(trackIds(first), expected.slice(0, 30));
  assert.equal(first.more, true);

  const offset = first.tracks.length;
  const [second, replay] = await Promise.all([plugin.liked({ offset }), plugin.liked({ offset })]);
  assert.deepEqual(trackIds(second), expected.slice(30, 60));
  assert.deepEqual(replay, second);
  assert.equal(second.more, true);
  const last = await plugin.liked({ offset: offset + second.tracks.length });
  assert.deepEqual(trackIds(last), expected.slice(60));
  assert.equal(last.more, false);
  assert.deepEqual(backend.detailBatches.flat(), ids);
  assert.equal(backend.favoriteReads, 1);
});

test("a failed liked detail request can be retried at the same visible offset", async () => {
  const ids = Array.from({ length: 35 }, (_, i) => i + 1);
  const backend = playlistBackend(ids);
  let failNext = false;
  const plugin = await loadPlugin((path, data) => {
    if (failNext && path === "/eapi/v3/song/detail") {
      failNext = false;
      return { code: 500 };
    }
    return backend.handle(path, data);
  });
  const first = await plugin.liked({});
  failNext = true;
  const offset = first.tracks.length;
  await assert.rejects(plugin.liked({ offset }));
  const next = await plugin.liked({ offset });
  assert.deepEqual(trackIds(next), ids.slice(30));
  assert.equal(next.more, false);
  assert.equal(backend.favoriteReads, 1);
});

test("each pass of a locally looping song reports a start and a natural end", async () => {
  const logs = [];
  const plugin = await loadPlugin((path, data) => {
    assert.equal(path, "/eapi/feedback/weblog");
    logs.push(...JSON.parse(data.logs));
    return {};
  });
  for (let pass = 0; pass < 2; pass++) {
    await plugin.played({ id: "42" });
    await plugin.playEnded({ id: "42", seconds: 3.4, reason: "ended" });
  }
  assert.deepEqual(logs.map(({ action, json }) => [action, json.id, json.time, json.end]), [
    ["startplay", 42, undefined, undefined],
    ["play", 42, 3, "playend"],
    ["startplay", 42, undefined, undefined],
    ["play", 42, 3, "playend"],
  ]);
});

test("a remote jump followed by a pause reports only the host's heard seconds", async () => {
  const logs = [];
  const plugin = await loadPlugin((path, data) => {
    assert.equal(path, "/eapi/feedback/weblog");
    logs.push(...JSON.parse(data.logs));
    return {};
  });
  await plugin.played({ id: "42" });
  await plugin.playEnded({ id: "42", seconds: 11, reason: "quit" });
  assert.deepEqual(logs.map(({ action, json }) => [action, json.id, json.time, json.end]), [
    ["startplay", 42, undefined, undefined],
    ["play", 42, 11, "ui"],
  ]);
});
