import { emptyLibrary } from "./library.js";
// Every read precedes every write, including completion's archive/delete transaction.
export async function commitModels(
  cloud,
  uid,
  catalogueIds,
  playthroughIds,
  transition,
) {
  const cats = [...new Set(catalogueIds)],
    runs = [...new Set(playthroughIds)];
  let result;
  await cloud.runTransaction(cloud.db, async (tx) => {
    const refs = [
      ...cats.map((id) => cloud.doc(cloud.db, "users", uid, "catalogue", id)),
      ...runs.map((id) =>
        cloud.doc(cloud.db, "users", uid, "playthroughs", id),
      ),
    ];
    const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
    const current = {
      ...emptyLibrary(),
      catalogue: snapshots
        .slice(0, cats.length)
        .filter((s) => s.exists())
        .map((s) => s.data()),
      playthroughs: snapshots
        .slice(cats.length)
        .filter((s) => s.exists())
        .map((s) => s.data()),
    };
    result = transition(current);
    cats.forEach((id, i) => {
      const next = result.catalogue.find((c) => c.id === id);
      if (
        next &&
        JSON.stringify(next) !==
          JSON.stringify(snapshots[i].exists() ? snapshots[i].data() : null)
      )
        tx.set(refs[i], next);
    });
    runs.forEach((id, i) => {
      const next = result.playthroughs.find((p) => p.id === id),
        index = cats.length + i;
      if (next) {
        if (
          JSON.stringify(next) !==
          JSON.stringify(
            snapshots[index].exists() ? snapshots[index].data() : null,
          )
        )
          tx.set(refs[index], next);
      } else if (snapshots[index].exists()) tx.delete(refs[index]);
    });
  });
  return { state: result, catalogueIds: cats, playthroughIds: runs };
}
export function applyCommitted(
  current,
  { state, catalogueIds, playthroughIds },
) {
  return {
    ...current,
    catalogue: [
      ...current.catalogue.filter((c) => !catalogueIds.includes(c.id)),
      ...state.catalogue,
    ],
    playthroughs: [
      ...current.playthroughs.filter((p) => !playthroughIds.includes(p.id)),
      ...state.playthroughs,
    ],
  };
}
