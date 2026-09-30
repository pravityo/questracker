import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCSV,
  guessMapping,
  importRows,
  deduplicate,
  interpretProgress,
  escapeHTML,
  calculatedProgress,
} from "../web/core.js";
test("CLZ CSV handles BOM, quoted commas, escaped quotes, CRLF and multiline cells", () => {
  const csv = parseCSV(
    '\uFEFFTitle,Platform,Genre\r\n"Game, Deluxe",PS5,"Action\nRPG"\r\n"A ""Great"" Game",Switch,Adventure\r\n',
  );
  assert.equal(csv.rows.length, 2);
  assert.equal(csv.rows[0][0], "Game, Deluxe");
  assert.equal(csv.rows[0][2], "Action\nRPG");
  assert.equal(csv.rows[1][0], 'A "Great" Game');
  assert.throws(() => parseCSV('Title\n"unterminated'), /Unclosed/);
});
test("mapping imports wishlist and completed owned games without duplicate loss across platforms", () => {
  const csv = parseCSV(
    "Title,Console,Collection Status,Status\nZelda,Switch,Wishlist,\nZelda,PS5,Owned,Completed",
  );
  const imported = importRows(csv, guessMapping(csv.headers));
  assert.equal(imported[0].collection, "wishlist");
  assert.equal(imported[1].percent, 100);
  const r = deduplicate([imported[0]], imported);
  assert.equal(r.added.length, 1);
  assert.equal(r.skipped, 1);
});
test("unknown chapter requires clarification and never invents a percentage", () => {
  assert.equal(interpretProgress("I just finished chapter 8").confirmed, false);
  assert.equal(
    interpretProgress("I just started chapter 8").percent,
    undefined,
  );
  assert.equal(
    interpretProgress("I finished chapter 8", [
      { chapter: 8, label: "Chapter 8", percent: 42 },
    ]).percent,
    42,
  );
  assert.equal(interpretProgress("I finished the main story").percent, 100);
});
test("imported HTML is escaped", () =>
  assert.equal(
    escapeHTML('<img onerror="bad">'),
    "&lt;img onerror=&quot;bad&quot;&gt;",
  ));

test("incomplete or negated milestones never count as complete", () => {
  assert.equal(
    interpretProgress("I have not finished the main story").confirmed,
    false,
  );
  assert.equal(
    interpretProgress("I almost finished chapter 8", [
      { chapter: 8, label: "Chapter 8", percent: 42 },
    ]).confirmed,
    false,
  );
  assert.equal(
    interpretProgress("I started The Rescue", [
      { chapter: 1, label: "The Rescue", percent: 5 },
    ]).confirmed,
    false,
  );
});

test("unresolved percentages cannot become zero or be saved as guessed numbers", () => {
  assert.equal(calculatedProgress({ percent: null }), null);
  assert.equal(calculatedProgress({}), null);
  assert.equal(calculatedProgress({ percent: NaN }), null);
  assert.equal(calculatedProgress({ percent: 101 }), null);
  assert.equal(calculatedProgress({ percent: 42.4 }), 42);
  assert.equal(calculatedProgress({ percent: 100 }), 100);
  assert.ok(
    !interpretProgress("I finished chapter 8").question.includes("percentage"),
  );
});

test("platform aliases match duplicates while distinct editions remain separate", async () => {
  const { normalizePlatform, planImport } = await import("../web/core.js");
  assert.equal(normalizePlatform("PS5"), "PlayStation 5");
  assert.equal(normalizePlatform("Switch"), "Nintendo Switch");
  const existing = [
    { title: "Zelda", platform: "Nintendo Switch", edition: "Standard" },
  ];
  const plan = planImport(existing, [
    { title: "Zelda", platform: "Switch", edition: "Standard" },
    { title: "Zelda", platform: "Switch", edition: "Deluxe" },
  ]);
  assert.deepEqual(
    plan.map((p) => p.action),
    ["duplicate", "add"],
  );
});
test("date import normalizes year-first dates without guessing ambiguous dates", async () => {
  const { normalizeReleaseDate, validReleaseDate } =
    await import("../web/core.js");
  assert.equal(normalizeReleaseDate("2024/2/9"), "2024-02-09");
  assert.equal(validReleaseDate("2024-02-29"), true);
  for (const date of ["2024-02-30", "09/02/2024", "2024-13-01"])
    assert.equal(validReleaseDate(date), false);
  assert.equal(normalizeReleaseDate("09/02/2024"), "09/02/2024");
  assert.equal(validReleaseDate(""), true);
});
test("duplicate enrichment never replaces progress, recaps or existing metadata", async () => {
  const { mergeMissingDetails } = await import("../web/core.js");
  const history = [{ id: "saved", recap: "Existing story", percent: 42 }];
  const existing = {
    title: "Game",
    platform: "PS5",
    genre: "Unsorted",
    releaseDate: "",
    developer: "Original",
    percent: 42,
    status: "paused",
    history,
  };
  const merged = mergeMissingDetails(existing, {
    genre: "RPG",
    releaseDate: "2024-02-29",
    developer: "Other",
    percent: 0,
    status: "not-started",
    history: [],
  });
  assert.equal(merged.genre, "RPG");
  assert.equal(merged.releaseDate, "2024-02-29");
  assert.equal(merged.developer, "Original");
  assert.equal(merged.percent, 42);
  assert.equal(merged.status, "paused");
  assert.equal(merged.history, history);
});

test("CLZ named-month dates import automatically without bypassing calendar validation", async () => {
  const { normalizeReleaseDate, validReleaseDate } =
    await import("../web/core.js");
  for (const [input, expected] of [
    ["Nov 13, 2020", "2020-11-13"],
    ["February 29, 2024", "2024-02-29"],
    ["13 November 2020", "2020-11-13"],
    ["Sept. 03, 2026", "2026-09-03"],
  ]) {
    assert.equal(normalizeReleaseDate(input), expected);
    assert.equal(validReleaseDate(normalizeReleaseDate(input)), true);
  }
  for (const input of [
    "Feb 29, 2023",
    "Feb 30, 2024",
    "Smarch 13, 2020",
    "09/02/2024",
  ])
    assert.equal(validReleaseDate(normalizeReleaseDate(input)), false);
  const csv = parseCSV(
    'Platform,Title,Release Date,Publisher,Genre\nPlayStation 5,Test game,"Nov 13, 2020",Test publisher,RPG\nNintendo Switch,Other game,"Feb 29, 2024",Other publisher,Adventure\nNintendo 3DS,Undated game,,,Adventure',
  );
  const games = importRows(csv, guessMapping(csv.headers));
  assert.equal(games.length, 3);
  assert.deepEqual(
    games.map((g) => g.releaseDate),
    ["2020-11-13", "2024-02-29", ""],
  );
  assert.ok(games.every((g) => validReleaseDate(g.releaseDate)));
  assert.ok(games.every((g) => g.developer === ""));
});
