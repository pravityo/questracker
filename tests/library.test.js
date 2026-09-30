import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyLibrary,
  migrateLegacy,
  applyPlaythrough,
  mergeLibraries,
  projectLibrary,
  catalogueId,
  validateLibrary,
} from "../web/library.js";
import { commitModels, applyCommitted } from "../web/library-repository.js";
const legacy = (id, platform, extra = {}) => ({
  id,
  title: "Same game",
  platform,
  edition: "",
  genre: "RPG",
  developer: "Studio",
  cover: "",
  releaseDate: "2020",
  collection: "owned",
  percent: 0,
  status: "not-started",
  history: [],
  milestones: [],
  updatedAt: 1,
  ...extra,
});
const entry = (id, percent, date = "2026-01-01") => ({
  id,
  date,
  label: "Chapter",
  update: "Chapter completed",
  percent,
  recap: "Story so far",
  sources: [],
});
test("migration consolidates platforms and editions but keeps distinct game titles separate", () => {
  const state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam"),
    legacy("ps", "PS5"),
    legacy("deluxe", "PS5", { edition: "Deluxe" }),
    { ...legacy("other", "Switch"), title: "Same game Remastered" },
  ]);
  assert.equal(state.catalogue.length, 2);
  assert.equal(state.catalogue[0].copies.length, 3);
  assert.equal(state.playthroughs.length, 0);
});
test("migration preserves independent platform progress and is idempotent", () => {
  const old = [
    legacy("pc", "Steam", {
      percent: 35,
      status: "paused",
      history: [entry("pc-entry", 35)],
    }),
    legacy("ps", "PS5", {
      percent: 70,
      status: "playing",
      history: [entry("ps-entry", 70)],
    }),
  ];
  const state = migrateLegacy(emptyLibrary(), old);
  assert.equal(state.catalogue.length, 1);
  assert.equal(state.playthroughs.length, 2);
  assert.deepEqual(
    state.playthroughs.map((p) => p.percent),
    [35, 70],
  );
  assert.deepEqual(migrateLegacy(state, old), state);
});
test("completion atomically archives the entire journal and removes only that active playthrough", () => {
  let state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      percent: 35,
      status: "paused",
      history: [entry("early", 35)],
    }),
    legacy("ps", "PS5", { status: "playing" }),
  ]);
  state = applyPlaythrough(state, {
    ...state.playthroughs[0],
    percent: 100,
    status: "completed",
    history: [
      ...state.playthroughs[0].history,
      entry("end", 100, "2026-02-01"),
    ],
  });
  assert.equal(state.catalogue[0].completed, true);
  assert.equal(state.playthroughs.length, 1);
  assert.equal(state.playthroughs[0].platform, "PlayStation 5");
  assert.equal(state.catalogue[0].completedPlaythroughs[0].history.length, 2);
  assert.equal(
    projectLibrary(state).filter((g) => g.recordType === "catalogue").length,
    1,
  );
});
test("a late recap updates an archived journal without recreating active progress", () => {
  let state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      percent: 100,
      status: "completed",
      history: [entry("end", 100)],
    }),
  ]);
  const archived = state.catalogue[0].completedPlaythroughs[0];
  state = applyPlaythrough(
    state,
    {
      ...archived,
      history: [
        {
          ...archived.history[0],
          recap: "Detailed ending recap",
          recapUpdatedAt: 4,
        },
      ],
    },
    { journalOnly: true },
  );
  assert.equal(state.playthroughs.length, 0);
  assert.equal(
    state.catalogue[0].completedPlaythroughs[0].history[0].recap,
    "Detailed ending recap",
  );
});
test("new playthroughs keep the catalogue completion mark and completed history", () => {
  let state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      status: "completed",
      percent: 100,
      history: [entry("end", 100)],
    }),
  ]);
  state = applyPlaythrough(state, {
    id: "replay",
    catalogueId: state.catalogue[0].id,
    platform: "PC / Steam",
    edition: "New route",
    status: "playing",
    percent: 0,
    history: [],
    milestones: [],
  });
  assert.equal(state.catalogue[0].completed, true);
  assert.equal(state.catalogue[0].completedPlaythroughs.length, 1);
  assert.equal(state.playthroughs.length, 1);
});
test("recap-only changes preserve remote progress and paused state", () => {
  let state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      status: "paused",
      percent: 60,
      history: [entry("early", 20), entry("newer", 60, "2026-02-01")],
    }),
  ]);
  state = applyPlaythrough(
    state,
    {
      ...state.playthroughs[0],
      status: "playing",
      percent: 20,
      history: [
        { ...entry("early", 20), recap: "New recap", recapUpdatedAt: 10 },
      ],
    },
    { journalOnly: true },
  );
  assert.equal(state.playthroughs[0].status, "paused");
  assert.equal(state.playthroughs[0].percent, 60);
  assert.equal(state.playthroughs[0].history.length, 2);
});
test("removed catalogue games reject late recap writes and preserve removed legacy journals", () => {
  const state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      deletedAt: 100,
      status: "playing",
      percent: 40,
      history: [entry("early", 40)],
    }),
  ]);
  assert.equal(state.catalogue[0].deletedAt, 100);
  assert.equal(state.playthroughs.length, 1);
  assert.throws(
    () => applyPlaythrough(state, state.playthroughs[0], { journalOnly: true }),
    /removed/,
  );
  assert.throws(
    () =>
      applyPlaythrough(
        emptyLibrary(),
        { id: "gone", catalogueId: "gone", history: [] },
        { journalOnly: true },
      ),
    /removed/,
  );
});
test("one removed platform does not hide another owned platform during migration", () => {
  const state = migrateLegacy(emptyLibrary(), [
    legacy("removed", "PS5", { deletedAt: 100 }),
    legacy("active", "Steam"),
  ]);
  assert.equal(state.catalogue.length, 1);
  assert.ok(!state.catalogue[0].deletedAt);
  const card = projectLibrary(state)[0];
  assert.equal(card.platform, "PC / Steam");
  assert.equal(state.catalogue[0].copies.length, 2);
});
test("backup merge keeps newer active journal entries when restoring a completion archive", () => {
  const state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      status: "playing",
      percent: 60,
      history: [entry("newer", 60, "2026-02-01")],
    }),
  ]);
  const backup = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", {
      status: "completed",
      percent: 100,
      history: [entry("end", 100, "2026-03-01")],
    }),
  ]);
  const restored = mergeLibraries(state, backup);
  assert.equal(restored.playthroughs.length, 0);
  assert.equal(
    restored.catalogue[0].completedPlaythroughs[0].history.length,
    2,
  );
  assert.deepEqual(mergeLibraries(restored, backup), restored);
  validateLibrary(restored);
});
test("catalogue IDs are platform independent and safe for unicode and slash-containing titles", () => {
  assert.equal(catalogueId("Same Game"), catalogueId(" same   game "));
  assert.ok(!catalogueId("A/B 日本語").includes("/"));
});
test("cloud completion reads all documents first and archives/deletes in one transaction", async () => {
  const state = migrateLegacy(emptyLibrary(), [
      legacy("pc", "Steam", {
        status: "playing",
        percent: 60,
        history: [entry("early", 60)],
      }),
    ]),
    cat = state.catalogue[0],
    run = state.playthroughs[0],
    events = [];
  const documents = new Map([
    ["catalogue/" + cat.id, cat],
    ["playthroughs/" + run.id, run],
  ]);
  const cloud = {
    db: {},
    doc: (_db, _users, _uid, type, id) => type + "/" + id,
    runTransaction: async (_db, fn) =>
      fn({
        get: async (ref) => {
          events.push("read");
          return {
            exists: () => documents.has(ref),
            data: () => structuredClone(documents.get(ref)),
          };
        },
        set: (ref, value) => {
          events.push("set");
          documents.set(ref, value);
        },
        delete: (ref) => {
          events.push("delete");
          documents.delete(ref);
        },
      }),
  };
  const result = await commitModels(cloud, "owner", [cat.id], [run.id], (s) =>
    applyPlaythrough(s, {
      ...run,
      status: "completed",
      percent: 100,
      history: [...run.history, entry("end", 100, "2026-03-01")],
    }),
  );
  assert.deepEqual(events, ["read", "read", "set", "delete"]);
  assert.equal(documents.get("catalogue/" + cat.id).completed, true);
  assert.ok(!documents.has("playthroughs/" + run.id));
  assert.equal(applyCommitted(state, result).playthroughs.length, 0);
});
test("a newer legacy update cannot reopen a completed playthrough", () => {
  const old = legacy("pc", "Steam", {
    status: "playing",
    percent: 30,
    history: [entry("early", 30)],
  });
  let state = migrateLegacy(emptyLibrary(), [old]);
  state = applyPlaythrough(state, {
    ...state.playthroughs[0],
    status: "completed",
    percent: 100,
    history: [
      ...state.playthroughs[0].history,
      entry("end", 100, "2026-03-01"),
    ],
  });
  state = migrateLegacy(state, [{ ...old, updatedAt: 2 }]);
  assert.equal(state.playthroughs.length, 0);
  assert.equal(state.catalogue[0].completedPlaythroughs[0].percent, 100);
  assert.equal(state.catalogue[0].completedPlaythroughs[0].history.length, 2);
});
test("backup validation rejects duplicate and unlinked playthroughs", () => {
  const state = migrateLegacy(emptyLibrary(), [
    legacy("pc", "Steam", { status: "playing" }),
  ]);
  assert.doesNotThrow(() => validateLibrary(state));
  assert.throws(() =>
    validateLibrary({
      ...state,
      playthroughs: [...state.playthroughs, state.playthroughs[0]],
    }),
  );
  assert.throws(() =>
    validateLibrary({
      ...state,
      playthroughs: [{ ...state.playthroughs[0], catalogueId: "missing" }],
    }),
  );
});
