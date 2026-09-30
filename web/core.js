export const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function normalizePlatform(value = "") {
  const aliases = {
    pc: "PC / Steam",
    steam: "PC / Steam",
    "pc / steam": "PC / Steam",
    windows: "PC / Steam",
    ps5: "PlayStation 5",
    "playstation 5": "PlayStation 5",
    ps4: "PlayStation 4",
    "playstation 4": "PlayStation 4",
    switch: "Nintendo Switch",
    "nintendo switch": "Nintendo Switch",
    "switch 2": "Nintendo Switch 2",
    "nintendo switch 2": "Nintendo Switch 2",
  };
  return aliases[value.trim().toLowerCase()] || value.trim() || "Unknown";
}
export function normalizeReleaseDate(value = "") {
  const text = value.trim();
  if (!text) return "";
  if (/^\d{4}$/.test(text)) return text;
  const months = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  let parts = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)?.slice(1);
  const monthFirst = text.match(
    /^([a-z]+)\.?\s+(\d{1,2})(?:,\s*|\s+)(\d{4})$/i,
  );
  const dayFirst = text.match(/^(\d{1,2})\s+([a-z]+)\.?(?:,\s*|\s+)(\d{4})$/i);
  if (monthFirst)
    parts = [monthFirst[3], months[monthFirst[1].toLowerCase()], monthFirst[2]];
  else if (dayFirst)
    parts = [dayFirst[3], months[dayFirst[2].toLowerCase()], dayFirst[1]];
  if (parts) {
    const [y, m, d] = parts;
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    if (
      date.getUTCFullYear() === +y &&
      date.getUTCMonth() === +m - 1 &&
      date.getUTCDate() === +d
    )
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Ambiguous numeric dates and invalid calendar dates remain available for review.
  return text;
}
export function validReleaseDate(value) {
  return (
    !value ||
    /^\d{4}$/.test(value) ||
    (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      normalizeReleaseDate(value) === value &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value)
  );
}
export const key = (g) =>
  `${g.title.trim().toLowerCase()}|${normalizePlatform(g.platform).toLowerCase()}|${(g.edition || "").trim().toLowerCase()}`;
export function mergeMissingDetails(existing, incoming) {
  const merged = { ...existing };
  for (const field of ["genre", "releaseDate", "developer", "cover", "edition"])
    if (!merged[field] || ["Unsorted", "Unknown"].includes(merged[field]))
      merged[field] = incoming[field] || merged[field];
  return merged;
}
export function planImport(existing, incoming) {
  const seen = new Map(existing.map((g) => [key(g), g]));
  return incoming.map((g) => {
    const match = seen.get(key(g));
    if (!match) seen.set(key(g), g);
    return { game: g, match, action: match ? "duplicate" : "add" };
  });
}

export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell) throw Error("Unexpected quote in CSV");
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("Unclosed quote in CSV");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length < 2) throw Error("CSV needs headers and at least one game.");
  return { headers: rows[0].map((s) => s.trim()), rows: rows.slice(1) };
}
export const fields = {
  title: ["title", "game", "name"],
  platform: ["platform", "console", "system"],
  genre: ["genre", "genres"],
  releaseDate: ["release date", "released", "year"],
  developer: ["developer", "developers"],
  edition: ["edition"],
  collection: ["collection status", "collection", "list"],
  status: ["status", "completion status"],
};
export function guessMapping(headers) {
  return Object.fromEntries(
    Object.entries(fields).map(([field, aliases]) => [
      field,
      headers.findIndex((h) => aliases.includes(h.toLowerCase())),
    ]),
  );
}
export function importRows(csv, mapping) {
  if (mapping.title < 0) throw Error("Choose a title column.");
  return csv.rows
    .map((row) => {
      const get = (f) => (row[mapping[f]] ?? "").trim();
      const collection = /wish/i.test(get("collection")) ? "wishlist" : "owned";
      return {
        id: crypto.randomUUID(),
        title: get("title"),
        platform: normalizePlatform(get("platform")),
        genre: get("genre") || "Unsorted",
        releaseDate: normalizeReleaseDate(get("releaseDate")),
        developer: get("developer"),
        edition: get("edition"),
        collection,
        status: /complet|finish/i.test(get("status"))
          ? "completed"
          : "not-started",
        percent: /complet|finish/i.test(get("status")) ? 100 : 0,
        history: [],
        milestones: [],
        cover: "",
      };
    })
    .filter((g) => g.title);
}
export function deduplicate(existing, incoming) {
  const seen = new Set(existing.map(key));
  let skipped = 0;
  const added = incoming.filter((g) => {
    const k = key(g);
    if (seen.has(k)) {
      skipped++;
      return false;
    }
    seen.add(k);
    return true;
  });
  return { added, skipped };
}
export function interpretProgress(text, milestones = []) {
  if (/\b(not|haven['’]?t|didn['’]?t|almost|about to)\b/i.test(text))
    return {
      question:
        "What is the last main-story chapter or quest you have fully completed?",
      confirmed: false,
    };
  if (
    /\b(finished|completed|beat)\s+(the\s+)?(game|main story|story)\b/i.test(
      text,
    )
  )
    return { percent: 100, label: "Main story completed", confirmed: true };
  const chapter = text.match(
    /\b(?:finished|completed|cleared)\s+chapter\s+(\d+)\b/i,
  );
  if (chapter) {
    const m = milestones.find((x) => x.chapter === Number(chapter[1]));
    if (m) return { percent: m.percent, label: m.label, confirmed: true };
    return {
      question: `Which main-story milestone is chapter ${chapter[1]} in this edition? What is the chapter title or last main-story quest you completed?`,
      confirmed: false,
    };
  }
  const m = /\b(finished|completed|cleared)\b/i.test(text)
    ? milestones.find((x) => text.toLowerCase().includes(x.label.toLowerCase()))
    : null;
  return m
    ? { percent: m.percent, label: m.label, confirmed: true }
    : {
        question:
          "Which chapter or main-story quest did you finish? Include the chapter or quest name if you know it.",
        confirmed: false,
      };
}

export function calculatedProgress(result) {
  return Number.isFinite(result.percent) &&
    result.percent >= 0 &&
    result.percent <= 100
    ? Math.round(result.percent)
    : null;
}
