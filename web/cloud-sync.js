import { emptyLibrary } from "./library.js";
export const SYNC_INTERVAL = 24 * 60 * 60 * 1000;
export function syncDue(lastAttempt, now = Date.now()) {
  return !lastAttempt || now - lastAttempt >= SYNC_INTERVAL;
}
export function pendingLegacy(state, records) {
  const processed = new Map();
  for (const c of state.catalogue)
    for (const [id, stamp] of Object.entries(c.migratedLegacy || {}))
      processed.set(id, stamp);
  return records.filter(
    (g) => !processed.has(g.id) || processed.get(g.id) < (g.updatedAt || 0),
  );
}
export function mergeRemoteChanges(state, changes, full = false) {
  const base = full ? emptyLibrary() : state;
  const replace = (old, incoming) => [
    ...old.filter((g) => !incoming.some((n) => n.id === g.id)),
    ...incoming,
  ];
  const catalogue = replace(base.catalogue, changes.catalogue);
  const archived = new Set(
    catalogue.flatMap((c) => (c.completedPlaythroughs || []).map((p) => p.id)),
  );
  return {
    version: 2,
    catalogue,
    playthroughs: replace(base.playthroughs, changes.playthroughs).filter(
      (p) => !archived.has(p.id),
    ),
  };
}
// The server watermark is read BEFORE the queries. Changes arriving during a pull
// remain eligible for the next pull; inclusive boundaries are safe because IDs merge.
export async function pullLibraryChanges(
  cloud,
  uid,
  cache,
  { migrate, onInitial = () => {} } = {},
) {
  const metaRef = cloud.doc(cloud.db, "users", uid, "settings", "library");
  let metaSnap = await cloud.getDocFromServer(metaRef);
  let meta = metaSnap.exists() ? metaSnap.data() : {};
  const fetchRecords = async (name, full) => {
    let ref = cloud.collection(cloud.db, "users", uid, name);
    if (!full && cache.cursor)
      ref = cloud.query(
        ref,
        cloud.where(
          "syncUpdatedAt",
          ">=",
          new cloud.Timestamp(cache.cursor.seconds, cache.cursor.nanoseconds),
        ),
      );
    const snap = await cloud.getDocsFromServer(ref);
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  };
  const needsMigration = meta.migrationVersion !== 2;
  const full = !cache.initialized || !cache.cursor || needsMigration;
  const records = await Promise.all(
    ["catalogue", "playthroughs"].map((name) => fetchRecords(name, full)),
  );
  let state = mergeRemoteChanges(
    cache.library,
    { catalogue: records[0], playthroughs: records[1] },
    full,
  );
  if (needsMigration) {
    onInitial(state);
    const legacy = await fetchRecords("games", true);
    state = await migrate(state, pendingLegacy(state, legacy));
    await cloud.setDoc(
      metaRef,
      { migrationVersion: 2, updatedAt: cloud.serverTimestamp() },
      { merge: true },
    );
    // Keep the original watermark. Advancing past a concurrent edit could skip it.
    if (!meta.updatedAt) meta = { ...meta, updatedAt: null };
  }
  return {
    library: state,
    initialized: true,
    cursor: meta.updatedAt
      ? {
          seconds: meta.updatedAt.seconds,
          nanoseconds: meta.updatedAt.nanoseconds,
        }
      : cache.cursor || { seconds: 0, nanoseconds: 0 },
  };
}
