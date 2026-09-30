import { normalizePlatform, mergeMissingDetails } from "./core.js";
export const titleKey = (title) =>
  title.trim().normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
export const catalogueId = (title) =>
  "game-" +
  btoa(String.fromCharCode(...new TextEncoder().encode(titleKey(title))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export const emptyLibrary = () => ({
  version: 2,
  catalogue: [],
  playthroughs: [],
});
export function mergeJournal(a = [], b = []) {
  return [
    ...new Map(
      [...a, ...b]
        .sort((x, y) => (x.recapUpdatedAt || 0) - (y.recapUpdatedAt || 0))
        .map((h) => [h.id, h]),
    ).values(),
  ].sort((x, y) => x.date.localeCompare(y.date));
}
const copyKey = (c) =>
  `${normalizePlatform(c.platform)}|${(c.edition || "").trim().toLowerCase()}`;
export function mergeCopies(a = [], b = []) {
  const copies = new Map(a.map((c) => [copyKey(c), c]));
  for (const input of b) {
    const c = {
      platform: normalizePlatform(input.platform),
      edition: input.edition || "",
      collection: input.collection === "wishlist" ? "wishlist" : "owned",
      releaseDate: input.releaseDate || "",
      deletedAt: input.deletedAt || null,
      ...(input.steamAppId ? { steamAppId: input.steamAppId } : {}),
    };
    const old = copies.get(copyKey(c));
    copies.set(
      copyKey(c),
      old
        ? {
            ...old,
            ...c,
            collection: old.collection === "owned" ? "owned" : c.collection,
            releaseDate: old.releaseDate || c.releaseDate,
          }
        : c,
    );
  }
  return [...copies.values()];
}
export function makeCatalogue(g) {
  const copies =
    g.recordType === "catalogue"
      ? g.copies
      : [
          {
            platform: g.platform,
            edition: g.edition,
            collection: g.collection,
            releaseDate: g.releaseDate,
            steamAppId: g.steamAppId,
            deletedAt: g.deletedAt,
          },
        ];
  return {
    id: g.recordType === "catalogue" ? g.id : catalogueId(g.title),
    recordType: "catalogue",
    title: g.title,
    genre: g.genre || "Unsorted",
    developer: g.developer || "",
    releaseDate: g.releaseDate || "",
    cover: g.cover || "",
    copies: mergeCopies([], copies),
    completed: !!g.completed,
    completedPlaythroughs: g.completedPlaythroughs || [],
    migratedLegacy: g.migratedLegacy || {},
    updatedAt: g.updatedAt || 0,
    ...(g.rawgId ? { rawgId: g.rawgId, rawgUrl: g.rawgUrl || "" } : {}),
    ...(g.deletedAt ? { deletedAt: g.deletedAt } : {}),
  };
}
export function playthroughRecord(g) {
  return {
    id: g.id,
    recordType: "playthrough",
    catalogueId: g.catalogueId,
    platform: normalizePlatform(g.platform),
    edition: g.edition || "",
    status: g.status || "playing",
    percent: g.percent || 0,
    history: g.history || [],
    milestones: g.milestones || [],
    milestoneSource: g.milestoneSource || "",
    createdAt: g.createdAt || g.history?.[0]?.date || new Date().toISOString(),
    updatedAt: g.updatedAt || 0,
    ...(g.completedAt ? { completedAt: g.completedAt } : {}),
  };
}
function mergedRun(old, incoming, journalOnly = false) {
  const history = mergeJournal(old?.history, incoming.history),
    latest = history.at(-1);
  const g = { ...(old || {}), ...incoming, history };
  if (journalOnly && old)
    Object.assign(g, {
      platform: old.platform,
      edition: old.edition,
      status: old.status,
      percent: old.percent,
      milestones: old.milestones,
      milestoneSource: old.milestoneSource || "",
    });
  else if (latest && latest.id !== incoming.history?.at(-1)?.id) {
    g.percent = latest.percent;
    g.status = latest.percent === 100 ? "completed" : "playing";
  }
  if (old?.status === "completed") {
    g.status = "completed";
    g.percent = 100;
  }
  return playthroughRecord(g);
}
export function mergeCatalogue(
  old,
  incoming,
  { replaceMetadata = false, replaceCopies = false } = {},
) {
  if (!old) return makeCatalogue(incoming);
  const metadata = replaceMetadata
    ? { ...old, ...incoming }
    : mergeMissingDetails(old, incoming);
  const archives = new Map(
    (old.completedPlaythroughs || []).map((p) => [p.id, p]),
  );
  for (const p of incoming.completedPlaythroughs || [])
    archives.set(
      p.id,
      mergedRun(archives.get(p.id), {
        ...p,
        status: "completed",
        percent: 100,
      }),
    );
  return {
    ...old,
    ...metadata,
    id: old.id,
    recordType: "catalogue",
    copies: replaceCopies
      ? mergeCopies([], incoming.copies)
      : mergeCopies(old.copies, incoming.copies),
    completed: !!(old.completed || incoming.completed || archives.size),
    completedPlaythroughs: [...archives.values()],
    migratedLegacy: { ...old.migratedLegacy, ...incoming.migratedLegacy },
    updatedAt: Math.max(old.updatedAt || 0, incoming.updatedAt || 0),
  };
}
export function applyPlaythrough(state, input, { journalOnly = false } = {}) {
  const incoming = playthroughRecord(input),
    cat = state.catalogue.find((c) => c.id === incoming.catalogueId);
  if (!cat || cat.deletedAt)
    throw Error(
      "This catalogue game was removed. Restore it before changing its story.",
    );
  const archived = cat.completedPlaythroughs?.find((p) => p.id === incoming.id),
    old = state.playthroughs.find((p) => p.id === incoming.id) || archived;
  if (journalOnly && !old)
    throw Error(
      "This playthrough no longer exists. Its recap cannot recreate it.",
    );
  const run = mergedRun(old, incoming, journalOnly);
  if (run.status === "completed" || run.percent === 100 || archived) {
    run.status = "completed";
    run.percent = 100;
    run.completedAt =
      archived?.completedAt ||
      incoming.completedAt ||
      run.history.at(-1)?.date ||
      new Date().toISOString();
    return {
      ...state,
      catalogue: state.catalogue.map((c) =>
        c.id !== cat.id
          ? c
          : {
              ...c,
              completed: true,
              updatedAt: Date.now(),
              completedPlaythroughs: [
                ...(c.completedPlaythroughs || []).filter(
                  (p) => p.id !== run.id,
                ),
                run,
              ],
            },
      ),
      playthroughs: state.playthroughs.filter((p) => p.id !== run.id),
    };
  }
  return {
    ...state,
    playthroughs: [...state.playthroughs.filter((p) => p.id !== run.id), run],
  };
}
export function migrateLegacy(state, legacy, { repairMissing = false } = {}) {
  state = structuredClone(state);
  for (const g of legacy) {
    const existing = state.catalogue.find(
      (c) => titleKey(c.title) === titleKey(g.title),
    );
    if (
      repairMissing &&
      (existing?.deletedAt ||
        existing?.copies?.some(
          (c) =>
            c.deletedAt &&
            normalizePlatform(c.platform) === normalizePlatform(g.platform) &&
            titleKey(c.edition || "") === titleKey(g.edition || ""),
        ))
    )
      continue;
    const cat = mergeCatalogue(existing, makeCatalogue(g));
    const stamp = g.updatedAt || 0;
    const runId = "run-" + g.id;
    const runExists =
      state.playthroughs.some((p) => p.id === runId) ||
      (cat.completedPlaythroughs || []).some((p) => p.id === runId);
    const hasProgress =
      (g.history || []).length ||
      g.percent > 0 ||
      ["playing", "paused", "completed"].includes(g.status);
    const needsRepair =
      repairMissing &&
      !runExists &&
      hasProgress &&
      !g.deletedAt &&
      !existing?.deletedAt;
    if (
      Object.hasOwn(cat.migratedLegacy, g.id) &&
      cat.migratedLegacy[g.id] >= stamp &&
      !needsRepair
    )
      continue;
    cat.migratedLegacy[g.id] = stamp;
    state.catalogue = [...state.catalogue.filter((c) => c.id !== cat.id), cat];
    const deletedAt = cat.copies.every((c) => c.deletedAt)
      ? Math.max(...cat.copies.map((c) => c.deletedAt))
      : null;
    if (deletedAt) cat.deletedAt = deletedAt;
    else delete cat.deletedAt;
    if (cat.deletedAt) delete cat.deletedAt;
    if (
      (g.history || []).length ||
      g.percent > 0 ||
      ["playing", "paused", "completed"].includes(g.status)
    ) {
      state = applyPlaythrough(state, {
        ...g,
        id: "run-" + g.id,
        catalogueId: cat.id,
        recordType: "playthrough",
        status: g.status === "not-started" ? "playing" : g.status,
      });
    }
    if (deletedAt)
      state.catalogue.find((c) => c.id === cat.id).deletedAt = deletedAt;
  }
  return state;
}
export function mergeLibraries(state, incoming) {
  let result = structuredClone(state);
  for (const cat of incoming.catalogue) {
    const existing = result.catalogue.find((c) => c.id === cat.id);
    result.catalogue = [
      ...result.catalogue.filter((c) => c.id !== cat.id),
      mergeCatalogue(existing, {
        ...cat,
        completedPlaythroughs: (cat.completedPlaythroughs || []).map((p) =>
          mergedRun(
            result.playthroughs.find((x) => x.id === p.id),
            p,
          ),
        ),
      }),
    ];
  }
  for (const run of incoming.playthroughs) {
    if (!result.catalogue.find((c) => c.id === run.catalogueId)?.deletedAt)
      result = applyPlaythrough(result, run);
  }
  const archived = new Set(
    result.catalogue.flatMap((c) =>
      (c.completedPlaythroughs || []).map((p) => p.id),
    ),
  );
  result.playthroughs = result.playthroughs.filter((p) => !archived.has(p.id));
  return result;
}
export function catalogueGame(c) {
  const owned = c.copies.filter(
      (p) => p.collection === "owned" && !p.deletedAt,
    ),
    copies = owned.length ? owned : c.copies.filter((p) => !p.deletedAt);
  return {
    ...c,
    platform:
      [...new Set(copies.map((p) => p.platform))].join(" · ") ||
      "No active platforms",
    edition: "",
    collection: owned.length ? "owned" : "wishlist",
    status: c.completed ? "completed" : "not-started",
    percent: c.completed ? 100 : 0,
    history: [],
    milestones: [],
  };
}
export function hydrateRun(p, c) {
  return {
    ...catalogueGame(c),
    ...p,
    recordType: "playthrough",
    collection: "owned",
    deletedAt: c.deletedAt || null,
  };
}
export function projectLibrary(state) {
  return [
    ...state.catalogue.map(catalogueGame),
    ...state.playthroughs
      .filter((p) => state.catalogue.some((c) => c.id === p.catalogueId))
      .map((p) =>
        hydrateRun(
          p,
          state.catalogue.find((c) => c.id === p.catalogueId),
        ),
      )
      .filter((g) => !g.deletedAt),
    ...state.catalogue.flatMap((c) =>
      (c.completedPlaythroughs || []).map((p) => hydrateRun(p, c)),
    ),
  ];
}
export function importCopies(state) {
  return state.catalogue
    .filter((c) => !c.deletedAt)
    .flatMap((c) =>
      c.copies
        .filter((p) => !p.deletedAt)
        .map((p) => ({
          ...catalogueGame(c),
          ...p,
          id: c.id + "|" + copyKey(p),
          history: [],
          percent: 0,
          status: "not-started",
          recordType: undefined,
          copies: undefined,
          completedPlaythroughs: undefined,
          migratedLegacy: undefined,
        })),
    );
}

export function validateLibrary(data) {
  const id = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 1500 &&
    !value.includes("/");
  const text = (value) => typeof value === "string";
  const history = (values) =>
    Array.isArray(values) &&
    values.every(
      (h) =>
        id(h.id) &&
        text(h.date) &&
        text(h.label) &&
        Number.isFinite(h.percent) &&
        h.percent >= 0 &&
        h.percent <= 100 &&
        (!h.sources || (Array.isArray(h.sources) && h.sources.every(text))),
    );
  const run = (p) =>
    id(p.id) &&
    id(p.catalogueId) &&
    text(p.platform) &&
    text(p.edition) &&
    ["playing", "paused", "completed"].includes(p.status) &&
    Number.isFinite(p.percent) &&
    p.percent >= 0 &&
    p.percent <= 100 &&
    history(p.history) &&
    Array.isArray(p.milestones);
  if (
    data?.version !== 2 ||
    !Array.isArray(data.catalogue) ||
    !Array.isArray(data.playthroughs) ||
    !data.catalogue.every(
      (c) =>
        id(c.id) &&
        text(c.title) &&
        c.title.trim().length > 0 &&
        c.title.length <= 200 &&
        text(c.genre) &&
        text(c.releaseDate) &&
        text(c.developer) &&
        text(c.cover) &&
        typeof c.completed === "boolean" &&
        Array.isArray(c.copies) &&
        c.copies.length > 0 &&
        c.copies.every(
          (p) =>
            text(p.platform) &&
            text(p.edition) &&
            ["owned", "wishlist"].includes(p.collection),
        ) &&
        Array.isArray(c.completedPlaythroughs) &&
        c.completedPlaythroughs.every(
          (p) => run(p) && p.catalogueId === c.id && p.status === "completed",
        ),
    )
  )
    throw Error("Invalid catalogue backup.");
  if (
    !data.playthroughs.every(
      (p) =>
        run(p) &&
        p.status !== "completed" &&
        data.catalogue.some((c) => c.id === p.catalogueId),
    )
  )
    throw Error("Backup contains an invalid or unlinked playthrough.");
  if (
    new Set(data.catalogue.map((c) => c.id)).size !== data.catalogue.length ||
    new Set(
      [
        ...data.playthroughs,
        ...data.catalogue.flatMap((c) => c.completedPlaythroughs),
      ].map((p) => p.id),
    ).size !==
      data.playthroughs.length +
        data.catalogue.reduce((n, c) => n + c.completedPlaythroughs.length, 0)
  )
    throw Error("Backup has duplicate record IDs.");
  return data;
}
