import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { buildImportWork, mergeMissingDetails, key } from "../web/core.js";
const source = await readFile(
  new URL("../web/app.js", import.meta.url),
  "utf8",
);
const handler = (a, b) =>
  source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const game = {
  id: "one",
  title: "Game",
  platform: "PC / Steam",
  edition: "",
  genre: "Unsorted",
  developer: "",
  cover: "",
  releaseDate: "",
  collection: "owned",
  status: "paused",
  percent: 40,
  history: [{ id: "entry", date: "2026-09-01", percent: 40, recap: "Keep me" }],
  milestones: [],
};
test("import work coalesces repeated identities and resume omits already saved games", () => {
  const incoming = [
    { ...game, id: "new", title: "Other" },
    { ...game, id: "duplicate", title: "Other", developer: "Studio" },
  ];
  const work = buildImportWork([game], incoming, true);
  assert.equal(work.length, 1);
  assert.equal(work[0].game.id, "new");
  assert.equal(work[0].game.developer, "Studio");
  assert.equal(
    buildImportWork([game, work[0].game], incoming, false).length,
    0,
  );
});
test("import filling a duplicate preserves ownership and story journal", () => {
  const [p] = buildImportWork(
    [game],
    [
      {
        ...game,
        id: "incoming",
        collection: "wishlist",
        percent: 0,
        history: [],
        developer: "Studio",
      },
    ],
    true,
  );
  assert.equal(p.game.id, "one");
  assert.equal(p.game.percent, 40);
  assert.deepEqual(p.game.history, game.history);
  assert.equal(p.game.collection, "owned");
});
test("chunk reads all cloud documents before writes and preserves newer remote journal", async () => {
  const operations = [],
    remote = {
      ...game,
      percent: 75,
      history: [{ id: "new", date: "2026-09-05", percent: 75, recap: "Newer" }],
    };
  const context = {
    user: { uid: "owner" },
    games: [],
    Date,
    Promise,
    mergeMissingDetails,
    cloud: {
      db: {},
      doc: (_db, ...parts) => parts.at(-1),
      runTransaction: async (_db, fn) =>
        fn({
          get: async (ref) => {
            operations.push("read:" + ref);
            return {
              exists: () => ref === "one",
              data: () => structuredClone(remote),
            };
          },
          set: (ref, g) => operations.push({ ref, g }),
        }),
    },
  };
  vm.runInNewContext(
    handler(
      "async function saveImportChunk",
      "async function continueStoryAfterSignIn",
    ) + "\nglobalThis.save=saveImportChunk;",
    context,
  );
  await context.save([game, { ...game, id: "two" }], true);
  assert.deepEqual(operations.slice(0, 2), ["read:one", "read:two"]);
  assert.equal(context.games[0].percent, 75);
  assert.equal(context.games[0].history[0].recap, "Newer");
});
test("local chunk serializes the library once rather than once per game", async () => {
  let writes = 0;
  const context = {
    user: null,
    games: [],
    Date,
    localKey: "library",
    localStorage: { setItem: () => writes++ },
  };
  vm.runInNewContext(
    handler(
      "async function saveImportChunk",
      "async function continueStoryAfterSignIn",
    ) + "\nglobalThis.save=saveImportChunk;",
    context,
  );
  await context.save(
    Array.from({ length: 25 }, (_, i) => ({ ...game, id: String(i) })),
    false,
  );
  assert.equal(writes, 1);
  assert.equal(context.games.length, 25);
});
test("sign-in continuation waits until synced library has loaded and executes only once", () => {
  let calls = 0;
  const context = {
    user: { uid: "owner" },
    authContinuation: () => calls++,
    syncStatus: "loading",
  };
  vm.runInNewContext(
    handler("function finishSignIn", "function filtered") +
      "\nglobalThis.finish=finishSignIn;",
    context,
  );
  context.finish();
  assert.equal(calls, 0);
  context.syncStatus = "synced";
  context.finish();
  context.finish();
  assert.equal(calls, 1);
});
