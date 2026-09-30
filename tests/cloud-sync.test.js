import test from "node:test";
import assert from "node:assert/strict";
import { emptyLibrary } from "../web/library.js";
import {
  syncDue,
  pendingLegacy,
  mergeRemoteChanges,
  pullLibraryChanges,
} from "../web/cloud-sync.js";
const cat = {
  id: "game",
  title: "Game",
  migratedLegacy: { old: 10 },
  completedPlaythroughs: [],
};
function fakeCloud(meta, records) {
  const reads = [],
    writes = [];
  return {
    reads,
    writes,
    db: {},
    doc: (_db, _users, _uid, type, id) => type + "/" + id,
    collection: (_db, _users, _uid, type) => ({ type }),
    query: (ref, condition) => ({ ...ref, condition }),
    where: (field, op, value) => ({ field, op, value }),
    Timestamp: class {
      constructor(seconds, nanoseconds) {
        this.seconds = seconds;
        this.nanoseconds = nanoseconds;
      }
    },
    serverTimestamp: () => "server-time",
    getDocFromServer: async (ref) => {
      reads.push(ref);
      return { exists: () => !!meta, data: () => meta };
    },
    getDocsFromServer: async (ref) => {
      reads.push(ref);
      return {
        docs: (records[ref.type] || []).map((data) => ({
          id: data.id,
          data: () => data,
        })),
      };
    },
    setDoc: async (...args) => writes.push(args),
  };
}
test("automatic sync is limited to one attempt every 24 hours, including failures", () => {
  assert.equal(syncDue(1000, 1001), false);
  assert.equal(syncDue(1000, 1000 + 24 * 60 * 60 * 1000), true);
  assert.equal(syncDue(0, 1000), true);
});
test("already migrated legacy records cause no migration work; only newer/new records qualify", () => {
  assert.deepEqual(
    pendingLegacy({ catalogue: [cat] }, [
      { id: "old", updatedAt: 10 },
      { id: "new", updatedAt: 1 },
      { id: "old", updatedAt: 11 },
    ]),
    [
      { id: "new", updatedAt: 1 },
      { id: "old", updatedAt: 11 },
    ],
  );
});
test("a daily pull queries only changed records and never scans legacy after migration", async () => {
  const cloud = fakeCloud(
    { migrationVersion: 2, updatedAt: { seconds: 20, nanoseconds: 42 } },
    { catalogue: [{ ...cat, title: "Changed" }], playthroughs: [] },
  );
  const cache = {
    initialized: true,
    cursor: { seconds: 10, nanoseconds: 9 },
    library: {
      ...emptyLibrary(),
      catalogue: [cat, { ...cat, id: "unrelated" }],
    },
  };
  const result = await pullLibraryChanges(cloud, "owner", cache);
  assert.equal(result.library.catalogue.length, 2);
  assert.equal(
    result.library.catalogue.find((c) => c.id === cat.id).title,
    "Changed",
  );
  assert.equal(cloud.writes.length, 0);
  assert.equal(cloud.reads.length, 3);
  for (const ref of cloud.reads.slice(1)) {
    assert.equal(ref.condition.field, "syncUpdatedAt");
    assert.equal(ref.condition.op, ">=");
    assert.equal(ref.condition.value.seconds, 10);
    assert.equal(ref.condition.value.nanoseconds, 9);
  }
  assert.deepEqual(result.cursor, { seconds: 20, nanoseconds: 42 });
});
test("first device pull loads complete collections once; later pulls use server watermark", async () => {
  const cloud = fakeCloud(
    { migrationVersion: 2, updatedAt: { seconds: 20, nanoseconds: 0 } },
    { catalogue: [cat] },
  );
  const result = await pullLibraryChanges(cloud, "owner", {
    initialized: false,
    library: emptyLibrary(),
  });
  assert.equal(result.initialized, true);
  assert.equal(cloud.reads[1].condition, undefined);
  assert.equal(result.library.catalogue.length, 1);
});
test("one-time migration skips processed documents and writes its completion marker only after success", async () => {
  const cloud = fakeCloud(null, {
    catalogue: [cat],
    games: [
      { id: "old", updatedAt: 10 },
      { id: "new", updatedAt: 1 },
    ],
  });
  let migrated;
  const result = await pullLibraryChanges(
    cloud,
    "owner",
    { library: emptyLibrary() },
    {
      migrate: async (state, rows) => {
        migrated = rows;
        return state;
      },
    },
  );
  assert.deepEqual(
    migrated.map((g) => g.id),
    ["new"],
  );
  assert.equal(cloud.writes.length, 1);
  assert.equal(cloud.writes[0][1].migrationVersion, 2);
  assert.deepEqual(result.cursor, { seconds: 0, nanoseconds: 0 });
  const failing = fakeCloud(null, { catalogue: [cat] });
  await assert.rejects(
    pullLibraryChanges(
      failing,
      "owner",
      { library: emptyLibrary() },
      {
        migrate: async () => {
          throw Error("quota exceeded");
        },
      },
    ),
  );
  assert.equal(failing.writes.length, 0);
});
test("completion deltas evict archived active records while keeping unrelated playthroughs", () => {
  const state = {
    ...emptyLibrary(),
    catalogue: [cat],
    playthroughs: [
      { id: "completed", catalogueId: cat.id },
      { id: "other", catalogueId: cat.id },
    ],
  };
  const changed = {
    catalogue: [{ ...cat, completedPlaythroughs: [{ id: "completed" }] }],
    playthroughs: [],
  };
  const result = mergeRemoteChanges(state, changed);
  assert.deepEqual(
    result.playthroughs.map((p) => p.id),
    ["other"],
  );
  assert.deepEqual(mergeRemoteChanges(result, changed), result);
});
test("quota failure stops before collection reads and leaves the cached input untouched", async () => {
  const cloud = fakeCloud(null, {});
  cloud.getDocFromServer = async () => {
    throw Error("quota exceeded");
  };
  const cache = {
    initialized: true,
    library: { ...emptyLibrary(), catalogue: [cat] },
  };
  await assert.rejects(pullLibraryChanges(cloud, "owner", cache), /quota/);
  assert.equal(cache.library.catalogue.length, 1);
  assert.equal(cloud.reads.length, 0);
});

// Exercise the application's actual cache/throttle handler, not just sync helpers.
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { makeCatalogue, validateLibrary } from "../web/library.js";
const appSource = await readFile(
  new URL("../web/app.js", import.meta.url),
  "utf8",
);
function cacheHarness(cached, pull) {
  const storage = new Map(
    cached ? [["questtracker.cloud-cache.owner", JSON.stringify(cached)]] : [],
  );
  const ctx = {
    user: { uid: "owner" },
    cloud: {},
    unsubscribe: null,
    syncGeneration: 0,
    syncCache: null,
    library: emptyLibrary(),
    syncStatus: "local",
    emptyLibrary,
    validateLibrary,
    syncDue,
    pullLibraryChanges: pull,
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    rebuildLibrary() {},
    render() {},
    finishSignIn() {},
    $: () => ({ textContent: "" }),
    setSync: (status, message) => {
      ctx.syncStatus = status;
      ctx.syncError = message;
    },
    setTimeout,
    clearTimeout,
  };
  const start = appSource.indexOf("function readSyncCache");
  const end = appSource.indexOf("async function initCloud()", start);
  vm.runInNewContext(
    appSource.slice(start, end) + "\nglobalThis.sync = subscribeLibrary;",
    ctx,
  );
  return { ctx, storage };
}
const cachedGame = makeCatalogue({
  title: "Cached game",
  platform: "PC / Steam",
  collection: "owned",
});
const cachedLibrary = { ...emptyLibrary(), catalogue: [cachedGame] };
test("opening a warm cached app performs zero cloud calls; manual sync bypasses the interval", async () => {
  let calls = 0;
  const cache = {
    library: cachedLibrary,
    initialized: true,
    cursor: { seconds: 10, nanoseconds: 0 },
    lastAttempt: Date.now(),
  };
  const { ctx } = cacheHarness(cache, async () => {
    calls++;
    return cache;
  });
  await ctx.sync();
  assert.equal(calls, 0);
  assert.equal(ctx.library.catalogue[0].title, "Cached game");
  await ctx.sync({ force: true });
  assert.equal(calls, 1);
});
test("a quota error preserves the cache and reopening does not retry automatically", async () => {
  let calls = 0;
  const cache = {
    library: cachedLibrary,
    initialized: true,
    cursor: { seconds: 10, nanoseconds: 0 },
    lastAttempt: 0,
  };
  const { ctx, storage } = cacheHarness(cache, async () => {
    calls++;
    throw Object.assign(Error("Quota exceeded"), {
      code: "resource-exhausted",
    });
  });
  await ctx.sync();
  assert.equal(ctx.syncStatus, "error");
  assert.equal(ctx.library.catalogue.length, 1);
  assert.match(
    JSON.parse(storage.get("questtracker.cloud-cache.owner")).error,
    /quota is exhausted/,
  );
  await ctx.sync();
  assert.equal(calls, 1);
  assert.equal(ctx.library.catalogue.length, 1);
});
test("cached libraries are isolated by account", async () => {
  const cache = {
    library: cachedLibrary,
    initialized: true,
    lastAttempt: Date.now(),
  };
  const { ctx } = cacheHarness(cache, async () => {
    throw Error("offline");
  });
  ctx.user = { uid: "different-account" };
  await ctx.sync();
  assert.equal(ctx.library.catalogue.length, 0);
});
