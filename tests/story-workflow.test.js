import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { escapeHTML, calculatedProgress } from "../web/core.js";

// Exercise the actual handlers with isolated UI/service adapters. No live account or AI requests.
const source = await readFile(
  new URL("../web/app.js", import.meta.url),
  "utf8",
);
const handler = (start, end) =>
  source.slice(
    source.indexOf(start),
    source.indexOf(end, source.indexOf(start)),
  );
const game = {
  id: "game",
  title: "Game",
  platform: "PC",
  edition: "",
  history: [
    { id: "old", date: "2026-09-01", percent: 10, recap: "Earlier recap" },
  ],
  percent: 10,
  status: "playing",
};
function confirmationHarness(save, generate) {
  const button = { disabled: false, textContent: "" },
    form = { querySelector: () => button };
  const elements = {
    "#confirm-progress": form,
    "#return-game": {},
    "#revise-milestone": {},
  };
  const state = {
    game: structuredClone(game),
    games: [structuredClone(game)],
    crypto: { randomUUID },
    Date,
    Set,
    Number,
    Object,
    FormData: class {
      *[Symbol.iterator]() {
        yield ["notes", "My notes"];
      }
    },
    e: escapeHTML,
    calculatedProgress,
    $: (s) => elements[s],
    modal: () => {},
    modalVersion: 1,
    isCurrent: () => true,
    detail: () => {},
    toast: () => {},
    inlineError: () => {},
    keepDraft: () => {},
    saveGame: save,
    generateRecap: generate,
  };
  vm.runInNewContext(
    handler("function confirmProgress(", "function milestoneDialog(") +
      '\nconfirmProgress(game,"Finished chapter 8",{percent:42,label:"Chapter 8",confirmed:false,sources:[]});',
    state,
  );
  return () => form.onsubmit({ preventDefault() {}, target: form });
}
test("confirmed progress persists before recap starts and does not wait for a slow recap", async () => {
  const events = [];
  let stored;
  const submit = confirmationHarness(
    async (g) => {
      events.push("save");
      stored = g;
    },
    () => {
      events.push("recap");
      return new Promise(() => {});
    },
  );
  await submit();
  assert.deepEqual(events, ["save", "recap"]);
  assert.equal(stored.percent, 42);
  assert.equal(stored.history.length, 2);
  assert.equal(stored.history[0].recap, "Earlier recap");
  assert.equal(stored.history[1].recapStatus, "pending");
});
test("failed progress persistence never starts a recap request", async () => {
  let started = false;
  const submit = confirmationHarness(
    async () => {
      throw Error("Offline");
    },
    () => {
      started = true;
    },
  );
  await submit();
  assert.equal(started, false);
});
function recapHarness(api) {
  const h = {
    id: "new",
    label: "Chapter 8",
    notes: "",
    percent: 42,
    recap: "",
    sources: ["https://one.example"],
    date: "2026-09-30",
  };
  const state = {
    user: { uid: "owner" },
    demoGames: null,
    games: [
      {
        ...structuredClone(game),
        history: [...structuredClone(game.history), h],
      },
    ],
    recapJobs: new Map(),
    refreshRecap: () => {},
    api,
    saveGame: async (g) => {
      state.games = [g];
    },
    toast: () => {},
    Date,
    Set,
  };
  vm.runInNewContext(
    handler("async function generateRecap(", "async function resolveProgress("),
    state,
  );
  return { state, run: () => state.generateRecap("game", "new") };
}
test("recap failure retains saved progress and records a retryable error", async () => {
  const { state, run } = recapHarness(async () => {
    throw Error("Quota unavailable");
  });
  await run();
  const h = state.games[0].history.at(-1);
  assert.equal(h.percent, 42);
  assert.equal(h.recapStatus, "error");
  assert.equal(h.recapError, "Quota unavailable");
  assert.equal(state.games[0].history[0].recap, "Earlier recap");
  assert.equal(state.recapJobs.size, 0);
});
test("late recap fills only its own journal entry and preserves a newer update", async () => {
  let resolve;
  const { state, run } = recapHarness(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const task = run();
  state.games[0].history.push({
    id: "later",
    percent: 50,
    recap: "Newer recap",
    date: "2026-10-01",
  });
  state.games[0].percent = 50;
  resolve({ recap: "Chapter 8 recap", sources: ["https://two.example"] });
  await task;
  assert.equal(state.games[0].percent, 50);
  assert.equal(state.games[0].history.at(-1).recap, "Newer recap");
  assert.equal(state.games[0].history[1].recap, "Chapter 8 recap");
  assert.deepEqual(
    [...state.games[0].history[1].sources],
    ["https://one.example", "https://two.example"],
  );
});
test("recap response after sign-out never writes into another library", async () => {
  let resolve;
  const { state, run } = recapHarness(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  let writes = 0;
  state.saveGame = async () => {
    writes++;
  };
  const task = run();
  state.user = null;
  resolve({ recap: "Recap", sources: [] });
  await task;
  assert.equal(writes, 0);
  assert.equal(state.recapJobs.size, 0);
});
function persistenceHarness(remote) {
  let written;
  const state = {
    demoGames: null,
    user: { uid: "owner" },
    syncStatus: "synced",
    games: [structuredClone(game)],
    Date,
    Map,
    Error,
    $: () => ({ textContent: "" }),
    setSync: () => {},
    toast: () => {},
    localStorage: { setItem() {} },
    localKey: "test",
    cloud: {
      db: {},
      doc: () => ({}),
      runTransaction: async (db, run) =>
        run({
          get: async () => ({
            exists: () => !!remote,
            data: () => structuredClone(remote),
          }),
          set: (ref, g) => {
            written = g;
          },
        }),
    },
  };
  vm.runInNewContext(
    handler("async function saveGame(", "async function removeGame("),
    state,
  );
  return { state, written: () => written };
}
test("background recap sync preserves remote metadata and paused state", async () => {
  const remote = {
    ...structuredClone(game),
    title: "Renamed remotely",
    percent: 55,
    status: "paused",
  };
  const { state, written } = persistenceHarness(remote);
  await state.saveGame(
    {
      ...game,
      title: "Old title",
      history: game.history.map((h) => ({
        ...h,
        recap: "Updated recap",
        recapUpdatedAt: Date.now(),
      })),
    },
    { journalOnly: true },
  );
  assert.equal(written().title, "Renamed remotely");
  assert.equal(written().status, "paused");
  assert.equal(written().percent, 55);
  assert.equal(written().history[0].recap, "Updated recap");
});
test("late background recap cannot recreate a deleted game", async () => {
  const { state, written } = persistenceHarness(null);
  await assert.rejects(
    state.saveGame(structuredClone(game), { journalOnly: true }),
    /deleted/,
  );
  assert.equal(written(), undefined);
});
