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
