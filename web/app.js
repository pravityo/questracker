import { progressErrorHTML } from "./progress-ui.js";
import { enrichGame } from "./metadata.js";
import {
  escapeHTML as e,
  parseCSV,
  guessMapping,
  fields,
  importRows,
  deduplicate,
  interpretProgress,
  calculatedProgress,
  normalizePlatform,
  normalizeReleaseDate,
  validReleaseDate,
  key,
  planImport,
  mergeMissingDetails,
} from "./core.js";
import { config } from "./config.js";
const $ = (s) => document.querySelector(s);
let view = "owned",
  user = null,
  cloud = null,
  unsubscribe = null;
const localKey = "questtracker.local.v1";
let games = readLocal();
let toastTimer,
  modalVersion = 0,
  returnFocus = null,
  syncStatus = "local",
  syncError = "",
  demoGames = null,
  migrationDismissed = false;
const recapJobs = new Map();
let progressDrafts = {};
try {
  progressDrafts = JSON.parse(
    sessionStorage.getItem("questtracker.progress-drafts") || "{}",
  );
} catch {}
function keepDraft(g, text) {
  progressDrafts[key(g)] = text;
  sessionStorage.setItem(
    "questtracker.progress-drafts",
    JSON.stringify(progressDrafts),
  );
}
const filtersByView = {};
let detailTab = "story";
let authContinuation = null;
let metadataQueueActive = false;
const displayedGames = () => demoGames || games;
const percentLabel = (g) =>
  `${g.history.at(-1)?.estimated ? "~" : ""}${g.percent}%`;
function setSync(status, message = "") {
  syncStatus = status;
  syncError = message;
  render();
}
function clearFilters() {
  for (const id of ["search", "platform", "genre", "status", "year"])
    $("#" + id).value = "";
  $("#sort").value = "title";
  render();
}
function isCurrent(version) {
  return $("#modal").open && modalVersion === version;
}
function inlineError(message) {
  const el = $("#dialog-error");
  if (el) {
    el.textContent = message;
    el.hidden = false;
  } else toast(message);
}
function draftGame() {
  return {
    title: "",
    platform: "",
    genre: "",
    releaseDate: "",
    developer: "",
    edition: "",
    collection: view === "wishlist" ? "wishlist" : "owned",
    cover: "",
    milestones: [],
  };
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(localKey) || "[]");
  } catch {
    return [];
  }
}
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").style.display = "none"), 5000);
}
function modal(html) {
  const dialog = $("#modal");
  if (!dialog.open) returnFocus = document.activeElement;
  modalVersion++;
  $("#modal-body").innerHTML = html;
  const heading = $("#modal-body h2");
  if (heading) {
    heading.id = "dialog-title";
    dialog.setAttribute("aria-labelledby", "dialog-title");
  }
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  const focus =
    [
      ...document.querySelectorAll(
        "#modal-body [autofocus],#modal-body input:not([type=file]),#modal-body textarea",
      ),
    ].find(
      (el) =>
        !el.closest("[hidden],details:not([open])") &&
        el.getClientRects().length,
    ) || heading;
  if (focus) {
    if (focus === heading) focus.tabIndex = -1;
    focus.focus({ preventScroll: true });
  }
  return modalVersion;
}
$(".close").onclick = () => $("#modal").close();
$("#modal").addEventListener("close", () => {
  modalVersion++;
  metadataQueueActive = false;
  const target = returnFocus?.isConnected
    ? returnFocus
    : returnFocus?.dataset?.game
      ? document.querySelector(
          `[data-game="${CSS.escape(returnFocus.dataset.game)}"]`,
        )
      : null;
  (target || $("#add-btn")).focus();
});
// Backdrop clicks do not silently discard forms or submitted updates.
async function saveGame(g, { journalOnly = false } = {}) {
  if (demoGames) throw Error("Exit the demo to change your library.");
  if (user && syncStatus === "loading")
    throw Error("Wait for your synced library to load.");
  const ownerUid = user?.uid || null;
  g = { ...g, updatedAt: Date.now() };
  if (user && cloud) {
    try {
      await cloud.runTransaction(cloud.db, async (tx) => {
        const ref = cloud.doc(cloud.db, "users", ownerUid, "games", g.id),
          snap = await tx.get(ref);
        if (snap.exists()) {
          const remote = snap.data();
          const merged = [
            ...new Map(
              [...(remote.history || []), ...g.history]
                .sort(
                  (a, b) => (a.recapUpdatedAt || 0) - (b.recapUpdatedAt || 0),
                )
                .map((h) => [h.id, h]),
            ).values(),
          ].sort((a, b) => a.date.localeCompare(b.date));
          const last = merged.at(-1),
            own = g.history.at(-1);
          g = journalOnly
            ? { ...remote, id: g.id, history: merged, updatedAt: Date.now() }
            : { ...g, history: merged };
          if (!journalOnly && last && last.id !== own?.id) {
            g.percent = last.percent;
            g.status = last.percent === 100 ? "completed" : "playing";
          }
        }
        if (journalOnly && !snap.exists())
          throw Error("This game was deleted. Its recap will not recreate it.");
        tx.set(ref, g);
      });
      $("#sync-state").textContent = "Synced across devices";
    } catch (err) {
      setSync("error", "Could not save your changes. " + err.message);
      throw err;
    }
  }
  if ((user?.uid || null) !== ownerUid)
    throw Error(
      "Your account changed. Reopen your library to check the saved game.",
    );
  const index = games.findIndex((x) => x.id === g.id);
  if (index < 0) games.push(g);
  else games[index] = g;
  if (!user) localStorage.setItem(localKey, JSON.stringify(games));
  setSync(user ? "synced" : "local");
  $("#sync-state").textContent = user
    ? "Synced across devices"
    : "Local library · this device only";
}
async function removeGame(id) {
  if (user && cloud)
    await cloud.deleteDoc(cloud.doc(cloud.db, "users", user.uid, "games", id));
  games = games.filter((g) => g.id !== id);
  if (!user) localStorage.setItem(localKey, JSON.stringify(games));
  render();
}
function filtered() {
  return displayedGames()
    .filter(
      (g) =>
        (view === "progress"
          ? g.collection === "owned" && ["playing", "paused"].includes(g.status)
          : g.collection === view) &&
        (!$("#search").value ||
          [g.title, g.developer, g.genre, g.edition]
            .join(" ")
            .toLowerCase()
            .includes($("#search").value.toLowerCase())) &&
        (!$("#platform").value || g.platform === $("#platform").value) &&
        (!$("#genre").value ||
          g.genre
            .split(",")
            .map((x) => x.trim())
            .includes($("#genre").value)) &&
        (!$("#status").value || g.status === $("#status").value) &&
        (!$("#year").value ||
          (g.releaseDate || "").slice(0, 4) === $("#year").value),
    )
    .sort((a, b) =>
      $("#sort").value === "release"
        ? b.releaseDate.localeCompare(a.releaseDate)
        : $("#sort").value === "progress"
          ? b.percent - a.percent
          : a.title.localeCompare(b.title),
    );
}
const labels = {
  "not-started": "Not started",
  playing: "Playing",
  paused: "Paused",
  completed: "Main story completed",
};
function options(id, values, label) {
  const el = $(id),
    selected = el.value;
  el.innerHTML =
    `<option value="">${label}</option>` +
    [...new Set(values.filter(Boolean))]
      .sort()
      .map((v) => `<option value="${e(v)}">${e(v)}</option>`)
      .join("");
  if ([...el.options].some((o) => o.value === selected)) el.value = selected;
}
function render() {
  const library = displayedGames();
  const owned = library.filter((g) => g.collection === "owned"),
    playing = owned.filter((g) => ["playing", "paused"].includes(g.status)),
    wish = library.filter((g) => g.collection === "wishlist"),
    complete = owned.filter((g) => g.status === "completed");
  $("#owned-count").textContent = owned.length;
  $("#wish-count").textContent = wish.length;
  $("#progress-count").textContent = playing.length;
  $("#page-title").innerHTML =
    {
      owned: "Your library",
      wishlist: "Your wishlist",
      progress: "Your adventures",
    }[view] + "<span>.</span>";
  $("#page-subtitle").textContent = {
    owned: "Every world you own. Every story waiting to be finished.",
    wishlist: "Keep your next adventure in sight.",
    progress: "Remember the story. Find your next chapter.",
  }[view];
  $("#stats").innerHTML = [
    ["Games owned", owned.length],
    ["In progress", playing.length],
    ["Stories finished", complete.length],
    ["On your wishlist", wish.length],
  ]
    .map(
      ([label, n]) =>
        `<div class="stat"><span>${label}</span><strong>${n.toString().padStart(2, "0")}</strong></div>`,
    )
    .join("");
  const resume = [...playing].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  )[0];
  $("#resume").innerHTML =
    resume && view !== "wishlist"
      ? `<div class="resume-card"><div><div class="eyebrow">CONTINUE YOUR JOURNEY</div><h2>${e(resume.title)}</h2><p>${e(resume.history.at(-1)?.label || "Ready for the next chapter")} · ${percentLabel(resume)} main story</p></div><button class="primary" data-game="${e(resume.id)}">Story so far ↗</button></div>`
      : "";
  options(
    "#platform",
    library.map((g) => g.platform),
    "All platforms",
  );
  options(
    "#genre",
    library.flatMap((g) => g.genre.split(",").map((x) => x.trim())),
    "All genres",
  );
  options(
    "#year",
    library.map((g) => (g.releaseDate || "").slice(0, 4)),
    "All years",
  );
  $("#collection-title").textContent =
    view === "progress"
      ? "Currently playing"
      : view === "wishlist"
        ? "Want to play"
        : "All games";
  const list = filtered();
  $("#results-count").textContent =
    `${list.length} game${list.length !== 1 ? "s" : ""}`;
  $("#games").innerHTML = list.length
    ? list
        .map(
          (g, i) =>
            `<button class="game-card" data-game="${e(g.id)}"><div class="cover" style="--c1:${["#65663b", "#486a61", "#75624c", "#625778", "#3e6380", "#804f48"][[...g.title].reduce((n, c) => n + c.charCodeAt(0), 0) % 6]}">${g.cover && /^https:\/\//.test(g.cover) ? `<img src="${e(g.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="cover-title">${e(g.title)}</span>`}<span class="pill">${e(g.platform)}</span></div><div class="card-info"><h3>${e(g.title)}</h3><p class="card-platform">${e(g.platform)}</p>${g.edition ? `<p class="card-edition">${e(g.edition)}</p>` : ""}<p>${e(g.genre)}${g.releaseDate ? " · " + e((g.releaseDate || "").slice(0, 4)) : ""}</p><div class="progress-row"><span>${g.collection === "wishlist" ? "On your wishlist" : labels[g.status]}</span><span>${g.collection === "owned" ? percentLabel(g) : ""}</span></div>${g.collection === "owned" ? `<progress max="100" value="${g.percent}" aria-label="Main story progress"></progress>` : ""}</div></button>`,
        )
        .join("")
    : `<div class="empty"><div class="eyebrow">A NEW SAVE FILE</div><h2>${library.length ? "No games match your filters." : "Your adventures belong here."}</h2><p>${library.length ? "Try another search or filter." : "Import your CLZ collection or add your first game."}</p>${!library.length ? '<button class="primary" id="empty-import">Import CLZ CSV</button><button id="demo">Explore a sample library</button>' : '<button id="empty-clear">Clear filters</button>'}</div>`;
  document
    .querySelectorAll("[data-game]")
    .forEach((b) => (b.onclick = () => detail(b.dataset.game, "", "story")));
  $("#empty-import")?.addEventListener("click", importDialog);
  $("#demo")?.addEventListener("click", loadDemo);
  $("#empty-clear")?.addEventListener("click", clearFilters);
  const active = ["search", "platform", "genre", "status", "year"].filter(
    (id) => $("#" + id).value,
  );
  $("#active-filters").innerHTML = active
    .map(
      (id) =>
        `<button class="filter-chip" data-clear="${id}" aria-label="Remove ${id} filter">${e($("#" + id).value)} ×</button>`,
    )
    .join("");
  document.querySelectorAll("[data-clear]").forEach(
    (b) =>
      (b.onclick = () => {
        $("#" + b.dataset.clear).value = "";
        render();
      }),
  );
  $("#clear-filters").hidden = !active.length;
  $("#filter-toggle").textContent =
    `Filters${active.filter((id) => id !== "search").length ? " (" + active.filter((id) => id !== "search").length + ")" : ""}`;
  $("#status").disabled = view === "wishlist";
  $("#status").closest("label").hidden = view === "wishlist";
  $("#app-notice").hidden =
    !demoGames &&
    syncStatus !== "error" &&
    !(
      user &&
      readLocal().length &&
      !migrationDismissed &&
      syncStatus !== "loading"
    );
  $("#app-notice").innerHTML = demoGames
    ? '<strong>Sample library</strong><span>Explore freely. Your real library is unchanged.</span><button id="exit-demo">Exit demo</button>'
    : syncStatus === "error"
      ? `<strong>Sync unavailable</strong><span>${e(syncError || "Your library could not be loaded. Retry before making changes.")}</span><button id="retry-sync">Retry sync</button>`
      : user &&
          readLocal().length &&
          !migrationDismissed &&
          syncStatus !== "loading"
        ? `<strong>${readLocal().length} games are saved on this device</strong><span>Review them before adding them to your synced library.</span><button id="review-local">Review local games</button><button id="dismiss-migration" class="quiet">Later</button>`
        : "";
  $("#exit-demo")?.addEventListener("click", () => {
    demoGames = null;
    clearFilters();
  });
  $("#retry-sync")?.addEventListener("click", () =>
    user ? subscribeLibrary() : initCloud(),
  );
  $("#review-local")?.addEventListener("click", () =>
    reviewImport(readLocal(), settings, true),
  );
  $("#dismiss-migration")?.addEventListener("click", () => {
    migrationDismissed = true;
    render();
  });
  for (const id of ["add-btn", "import-btn", "enrich-btn"])
    $("#" + id).disabled = !!demoGames || syncStatus === "loading";
  if (syncStatus === "loading" && !demoGames) {
    $("#games").innerHTML =
      '<div class="empty" role="status" aria-live="polite"><h2>Loading your synced library…</h2><p>Your games will appear here shortly.</p></div>';
    $("#results-count").textContent = "Loading…";
  }
  if (syncStatus === "error" && !games.length && !demoGames)
    $("#games").innerHTML =
      '<div class="empty"><h2>Your library couldn’t be loaded</h2><p>Use Retry sync above to reconnect.</p></div>';
  document.querySelectorAll(".cover img").forEach(
    (img) =>
      (img.onerror = () => {
        const title = document.createElement("span");
        title.className = "cover-title";
        title.textContent = img
          .closest("button")
          .querySelector("h3").textContent;
        img.replaceWith(title);
      }),
  );
}
document.querySelectorAll("[data-view]").forEach(
  (b) =>
    (b.onclick = () => {
      filtersByView[view] = Object.fromEntries(
        ["search", "platform", "genre", "status", "year", "sort"].map((id) => [
          id,
          $("#" + id).value,
        ]),
      );
      view = b.dataset.view;
      for (const id of [
        "search",
        "platform",
        "genre",
        "status",
        "year",
        "sort",
      ])
        $("#" + id).value =
          filtersByView[view]?.[id] || (id === "sort" ? "title" : "");
      if (view === "wishlist") $("#status").value = "";
      document.querySelectorAll("[data-view]").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      render();
    }),
);
["search", "platform", "genre", "status", "year", "sort"].forEach((id) =>
  $("#" + id).addEventListener(id === "search" ? "input" : "change", render),
);
$("#clear-filters").onclick = clearFilters;
$("#filter-toggle").onclick = () => {
  const open = $("#filter-panel").classList.toggle("is-open");
  $("#filter-toggle").setAttribute("aria-expanded", String(open));
};
function addDialog(original) {
  const g = original || {
    title: "",
    platform: "PC / Steam",
    genre: "",
    releaseDate: "",
    developer: "",
    edition: "",
    collection: view === "wishlist" ? "wishlist" : "owned",
    cover: "",
    milestones: [],
  };
  modal(
    `<h2>${original?.id ? "Edit game" : "Add a game"}</h2><button id="lookup-game">⌕ Find details on RAWG</button><p class="muted">Search to fill missing details. Your existing fields and progress are preserved.</p><form id="game-form"><label>Title<input name="title" required maxlength="200" value="${e(g.title)}"></label><div class="form-row"><label>Platform<input name="platform" required list="platforms" value="${e(g.platform)}"><datalist id="platforms"><option>PC / Steam</option><option>PlayStation 5</option><option>PlayStation 4</option><option>Nintendo Switch</option><option>Nintendo Switch 2</option></datalist></label><label>Genre<input name="genre" value="${e(g.genre)}" placeholder="Action RPG"></label></div><div class="form-row"><label>Release date<input name="releaseDate" placeholder="YYYY or YYYY-MM-DD" pattern="[0-9]{4}(-[0-9]{2}-[0-9]{2})?" value="${e(g.releaseDate)}"></label><label>Developer<input name="developer" value="${e(g.developer)}"></label></div><div class="form-row"><label>Edition / route<input name="edition" value="${e(g.edition)}" placeholder="Standard edition"></label><label>Collection<select name="collection"><option value="owned" ${g.collection === "owned" ? "selected" : ""}>Owned</option><option value="wishlist" ${g.collection === "wishlist" ? "selected" : ""}>Wishlist</option></select></label></div><details><summary>Custom cover image</summary><label>Cover image URL<input name="cover" type="url" value="${e(g.cover)}" placeholder="https://…"></label></details><div id="dialog-error" role="alert" hidden></div><button class="primary">Save game</button></form>`,
  );
  $("#lookup-game").onclick = () => {
    const values = Object.fromEntries(new FormData($("#game-form")));
    const draft = { ...g, ...values };
    if (!g.id && draft.platform === "PC / Steam") draft.platform = "";
    lookupGame(draft);
  };
  $("#game-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button.primary"),
      version = modalVersion;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const values = Object.fromEntries(new FormData(ev.target));
      values.platform = normalizePlatform(values.platform);
      values.releaseDate = normalizeReleaseDate(values.releaseDate);
      if (
        games.some((x) => x.id !== g.id && key(x) === key({ ...g, ...values }))
      )
        throw Error(
          "This game, platform and edition are already in your library.",
        );
      if (!validReleaseDate(values.releaseDate))
        throw Error("Enter a valid date as YYYY or YYYY-MM-DD.");
      if (values.cover && !values.cover.startsWith("https://"))
        throw Error("Use an HTTPS cover URL.");
      await saveGame({
        ...g,
        ...values,
        id: g.id || crypto.randomUUID(),
        genre: values.genre || "Unsorted",
        history: g.history || [],
        status: g.status || "not-started",
        percent: g.percent || 0,
      });
      if (isCurrent(version)) {
        if (metadataQueueActive) metadataQueue();
        else $("#modal").close();
      }
      toast("Game saved");
    } catch (err) {
      if (isCurrent(version)) {
        inlineError(err.message);
        btn.disabled = false;
        btn.textContent = "Save game";
      }
    }
  };
}
$("#add-btn").onclick = () => lookupGame(draftGame());
$("#enrich-btn").onclick = () => {
  metadataQueueActive = true;
  metadataQueue();
};
function metadataQueue() {
  const missing = games.filter(
    (g) =>
      !g.cover ||
      !g.developer ||
      !g.releaseDate ||
      !g.genre ||
      g.genre === "Unsorted",
  );
  if (!missing.length) {
    modal(
      '<h2>Game details complete</h2><p>All games now have their details.</p><button id="queue-done" class="primary">Done</button>',
    );
    $("#queue-done").onclick = () => $("#modal").close();
    return;
  }
  modal(
    `<h2>Fill missing game details</h2><p>${missing.length} games remaining. Choose a game and review its RAWG match. You’ll return here after saving.</p><button id="queue-done" class="quiet">Done for now</button><div class="lookup-results">${missing.map((g) => `<button data-enrich="${e(g.id)}">${e(g.title)} <span class="muted">${e(g.platform)}</span></button>`).join("")}</div>`,
  );
  $("#queue-done").onclick = () => $("#modal").close();
  document
    .querySelectorAll("[data-enrich]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          lookupGame(games.find((g) => g.id === b.dataset.enrich))),
    );
}
function recapContent(g) {
  const latest = [...g.history].reverse().find((h) => h.recap);
  return latest
    ? `<p class="muted">Through ${e(latest.label)} · ${e(new Date(latest.date).toLocaleDateString())}${latest !== g.history.at(-1) ? " · this recap predates your latest update" : ""}</p><div class="recap">${e(latest.recap)}</div>`
    : '<p class="muted">Your story recap will appear here after a confirmed progress update.</p>';
}
function recapStatus(g) {
  const h = g.history.at(-1);
  if (!h || demoGames) return "";
  const running = recapJobs.has(`${user?.uid || "local"}:${g.id}:${h.id}`);
  if (running)
    return '<div class="notice" role="status">Progress saved. Generating your story recap… You can close this screen.</div>';
  if (!h.recap)
    return `<div class="notice" role="status"><strong>Progress saved · recap unavailable</strong><p>${e(h.recapError || (h.recapStatus === "pending" ? "Recap generation was interrupted. Retry when you’re ready." : "Generate a recap for this stopping point."))}</p>${user && config.apiBase ? '<button id="retry-recap">Retry recap</button>' : '<button id="recap-signin">Sign in to generate a recap</button>'}</div>`;
  return h.recapWarning
    ? `<div class="notice" role="status">${e(h.recapWarning)}</div>`
    : "";
}
function bindRecap(g) {
  $("#retry-recap")?.addEventListener("click", () =>
    generateRecap(g.id, g.history.at(-1).id),
  );
  $("#recap-signin")?.addEventListener("click", () =>
    signIn(() => detail(g.id)),
  );
}
function refreshRecap(id) {
  const g = games.find((x) => x.id === id);
  if ($("#game-detail")?.dataset.id !== id || !g) return;
  $("#recap-content").innerHTML = recapContent(g);
  $("#recap-status").innerHTML = recapStatus(g);
  bindRecap(g);
}
function detail(id, draft = "", tab = detailTab) {
  const g = displayedGames().find((x) => x.id === id);
  if (!g) return;
  draft = draft || progressDrafts[key(g)] || "";
  detailTab = tab;
  modal(`<div id="game-detail" data-id="${e(id)}"><div class="eyebrow">${g.collection === "owned" ? "YOUR ADVENTURE" : "YOUR NEXT ADVENTURE"}</div><h2>${e(g.title)}</h2><div class="detail-meta"><span class="badge">${e(g.platform)}</span><span class="badge">${e(g.genre)}</span>${g.edition ? `<span class="badge">${e(g.edition)}</span>` : ""}</div>${
    g.collection === "owned"
      ? `
 <div class="detail-progress"><div class="progress-row"><span>${labels[g.status]}</span><strong>${percentLabel(g)} main story${g.history.at(-1)?.estimated ? " · estimated" : ""}</strong></div><progress value="${g.percent}" max="100" aria-label="Main story progress"></progress></div>
 <div class="dialog-tabs" role="tablist" aria-label="Game story"><button role="tab" id="tab-story" aria-controls="panel-story" aria-selected="${tab === "story"}" tabindex="${tab === "story" ? 0 : -1}" data-tab="story">Story so far</button><button role="tab" id="tab-update" aria-controls="panel-update" aria-selected="${tab === "update"}" tabindex="${tab === "update" ? 0 : -1}" data-tab="update">Update progress</button><button role="tab" id="tab-journal" aria-controls="panel-journal" aria-selected="${tab === "journal"}" tabindex="${tab === "journal" ? 0 : -1}" data-tab="journal">Journal</button></div>
 <div id="recap-status" aria-live="polite">${recapStatus(g)}</div>
 <section role="tabpanel" id="panel-story" aria-labelledby="tab-story" ${tab === "story" ? "" : "hidden"}><div id="recap-content">${recapContent(g)}</div></section>
 <section role="tabpanel" id="panel-update" aria-labelledby="tab-update" ${tab === "update" ? "" : "hidden"}>${demoGames ? "<p>This sample library is read-only. Exit demo to update your own games.</p>" : `${!user ? '<div class="notice"><p>Automatic chapter lookup and story recaps need Google sign-in. You can record a completed main story offline.</p><button id="progress-signin" type="button">Sign in with Google</button></div>' : ""}<form id="progress-form"><label>Where did you leave off?<textarea name="update" required maxlength="2000" placeholder="I just finished chapter 8…">${e(draft)}</textarea></label><p class="muted">Describe your last completed chapter, quest, or in-game date. The app calculates main-story progress.</p><div id="dialog-error" role="alert" hidden></div><button class="primary">Calculate progress</button></form><div class="detail-actions">${g.status !== "completed" ? `<button id="pause">${g.status === "paused" ? "Resume playing" : "Pause game"}</button>` : ""}</div><details class="advanced"><summary>Advanced story milestones</summary><p class="muted">Optional: use your own verified chapter list.</p><button id="milestones">Manage milestones</button></details>`}</section>
 <section role="tabpanel" id="panel-journal" aria-labelledby="tab-journal" ${tab === "journal" ? "" : "hidden"}>${
   [...g.history]
     .reverse()
     .map(
       (h) =>
         `<div class="history-item"><small>${e(new Date(h.date).toLocaleDateString())} · ${h.estimated ? "~" : ""}${h.percent}%${h.estimated ? " estimated" : ""}</small><p><strong>${e(h.label)}</strong></p><p>${e(h.update)}</p>${
           h.sources
             ?.filter((url) => /^https:\/\//.test(url))
             .map(
               (url) =>
                 `<a class="link source" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(sourceName(url))} ↗</a>`,
             )
             .join(" ") || ""
         }</div>`,
     )
     .join("") || '<p class="muted">No progress updates yet.</p>'
 }</section>`
      : demoGames
        ? "<p>Sample wishlist game.</p>"
        : '<p>Move this game to your library when you get it.</p><button id="move" class="primary">Move to library</button>'
  }
 ${demoGames ? "" : `<div class="detail-actions"><button id="edit">Edit details</button><button id="rawg-details">Find missing details</button><button id="delete" class="quiet">Delete game</button></div>`}</div>`);
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.onclick = () => {
      detailTab = b.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((t) => {
        const active = t === b;
        t.setAttribute("aria-selected", String(active));
        t.tabIndex = active ? 0 : -1;
        $("#panel-" + t.dataset.tab).hidden = !active;
      });
      if (detailTab === "update") $("#progress-form textarea")?.focus();
    };
    b.onkeydown = (ev) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) return;
      ev.preventDefault();
      const tabs = [...document.querySelectorAll("[data-tab]")],
        i = tabs.indexOf(b),
        next =
          ev.key === "Home"
            ? 0
            : ev.key === "End"
              ? tabs.length - 1
              : (i + (ev.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                tabs.length;
      tabs[next].click();
      tabs[next].focus();
    };
  });
  bindRecap(g);
  $("#progress-form textarea")?.addEventListener("input", (ev) =>
    keepDraft(g, ev.target.value),
  );
  $("#progress-signin")?.addEventListener("click", () =>
    signIn(() => {
      toast(
        "Your draft is kept. Review local games to add them to your synced library.",
      );
    }),
  );
  $("#rawg-details")?.addEventListener("click", () => lookupGame(g));
  $("#edit")?.addEventListener("click", () => addDialog(g));
  $("#delete")?.addEventListener("click", () => {
    modal(
      `<h2>Delete ${e(g.title)}?</h2><p>This removes the game and its progress journal. Download a full backup in Settings if you want to keep a copy.</p><div class="detail-actions"><button id="confirm-delete">Delete game</button><button id="cancel-delete">Back to game</button></div>`,
    );
    $("#cancel-delete").onclick = () => detail(id);
    $("#confirm-delete").onclick = async () => {
      try {
        await removeGame(id);
        $("#modal").close();
      } catch (err) {
        inlineError(err.message);
      }
    };
  });
  $("#move")?.addEventListener("click", async () => {
    try {
      await saveGame({ ...g, collection: "owned" });
      detail(id);
    } catch (err) {
      inlineError(err.message);
    }
  });
  $("#pause")?.addEventListener("click", async () => {
    try {
      await saveGame({
        ...g,
        status: g.status === "paused" ? "playing" : "paused",
      });
      detail(id);
    } catch (err) {
      inlineError(err.message);
    }
  });
  $("#milestones")?.addEventListener("click", () => milestoneDialog(g));
  $("#progress-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const update = new FormData(ev.target).get("update"),
      button = ev.target.querySelector("button"),
      version = modalVersion;
    button.disabled = true;
    button.textContent = "Finding your place…";
    try {
      const result = await resolveProgress(g, update);
      if (isCurrent(version)) confirmProgress(g, update, result);
    } catch (err) {
      if (isCurrent(version)) {
        inlineError(err.message);
        button.disabled = false;
        button.textContent = "Calculate progress";
      }
    }
  });
  if (tab === "update") $("#progress-form textarea")?.focus();
}
function sourceName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
}
async function generateRecap(gameId, historyId) {
  const owner = user?.uid || "local",
    jobKey = `${owner}:${gameId}:${historyId}`;
  if (recapJobs.has(jobKey) || demoGames) return;
  const original = games.find((g) => g.id === gameId),
    entry = original?.history.find((h) => h.id === historyId);
  if (!entry) return;
  recapJobs.set(jobKey, true);
  refreshRecap(gameId);
  try {
    const r = await api("/recap", {
      game: {
        title: original.title,
        platform: original.platform,
        edition: original.edition,
      },
      milestone: entry.label,
      notes: entry.notes || "",
    });
    if ((user?.uid || "local") !== owner) return;
    const current = games.find((g) => g.id === gameId);
    if (!current) return;
    await saveGame(
      {
        ...current,
        history: current.history.map((h) =>
          h.id === historyId
            ? {
                ...h,
                recap: r.recap,
                sources: [
                  ...new Set([...(h.sources || []), ...(r.sources || [])]),
                ],
                recapStatus: "ready",
                recapError: "",
                recapWarning: r.warning || "",
                recapUpdatedAt: Date.now(),
              }
            : h,
        ),
      },
      { journalOnly: true },
    );
  } catch (err) {
    if ((user?.uid || "local") === owner) {
      const current = games.find((g) => g.id === gameId);
      if (current)
        try {
          await saveGame(
            {
              ...current,
              history: current.history.map((h) =>
                h.id === historyId
                  ? {
                      ...h,
                      recapStatus: "error",
                      recapError: err.message,
                      recapUpdatedAt: Date.now(),
                    }
                  : h,
              ),
            },
            { journalOnly: true },
          );
        } catch {
          toast(
            "Progress is saved. Recap could not be synced. Retry after reconnecting.",
          );
        }
    }
  } finally {
    recapJobs.delete(jobKey);
    if ((user?.uid || "local") === owner) refreshRecap(gameId);
  }
}
async function resolveProgress(g, update) {
  let result = interpretProgress(update, g.milestones);
  if (!result.confirmed) {
    if (!user)
      return {
        ...result,
        lookupError: "Sign in with Google to calculate progress automatically.",
      };
    if (!config.apiBase)
      return {
        ...result,
        lookupError: "The progress service is not configured yet.",
      };
    try {
      return await api("/progress", {
        game: { title: g.title, platform: g.platform, edition: g.edition },
        update,
      });
    } catch (err) {
      return { ...result, lookupError: err.message };
    }
  }
  return result;
}
function progressError(g, update, message) {
  modal(progressErrorHTML(update, message));
  $("#return-game").onclick = () => detail(g.id, update, "update");
  $("#retry-progress").onclick = async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = "Retrying…";
    const version = modalVersion;
    try {
      const r = await resolveProgress(g, update);
      if (isCurrent(version)) confirmProgress(g, update, r);
    } catch (err) {
      if (isCurrent(version)) progressError(g, update, err.message);
    }
  };
}
function confirmProgress(g, update, result) {
  if (result.lookupError) {
    progressError(g, update, result.lookupError);
    return;
  }
  const percent = calculatedProgress(result);
  if (percent === null) {
    modal(
      `<h2>A little more story context</h2><div class="notice">${e(result.question || "What is the last main-story chapter or quest you fully completed?")}</div><p>The app will calculate your percentage from the story milestone.</p><form id="clarify-progress"><label>Chapter, quest, or route details<textarea name="clarification" maxlength="2000" required placeholder="The chapter title, last completed quest, or route I am playing…"></textarea></label><button class="primary">Calculate progress</button></form><button id="return-game" class="quiet">Back to game</button>`,
    );
    $("#return-game").onclick = () => detail(g.id, update, "update");
    $("#clarify-progress").onsubmit = async (ev) => {
      ev.preventDefault();
      const clarification = new FormData(ev.target).get("clarification").trim(),
        next = update + "\nClarification: " + clarification,
        btn = ev.target.querySelector("button"),
        version = modalVersion;
      btn.disabled = true;
      btn.textContent = "Calculating story progress…";
      try {
        const r = await resolveProgress(g, next);
        if (isCurrent(version)) confirmProgress(g, next, r);
      } catch (err) {
        if (isCurrent(version)) progressError(g, next, err.message);
      }
    };
    return;
  }
  const sources =
    result.sources ||
    (result.confirmed && g.milestoneSource ? [g.milestoneSource] : []);
  modal(
    `<h2>Your stopping point</h2><div class="detail-progress"><p>${e(result.label || update)}</p><div class="progress-row"><span>${result.confirmed ? "Main-story progress" : "Estimated main-story progress"}</span><strong>${result.confirmed ? "" : "~"}${percent}%</strong></div><progress max="100" value="${percent}" aria-label="Calculated main-story progress"></progress></div><p class="muted">Calculated from your completed story milestone. Main-story completion is 100%.</p>${
      sources.filter((url) => /^https:\/\//.test(url)).length
        ? `<p>Sources: ${sources
            .filter((url) => /^https:\/\//.test(url))
            .map(
              (url) =>
                `<a class="link source" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(sourceName(url))} ↗</a>`,
            )
            .join(" · ")}</p>`
        : ""
    }<form id="confirm-progress"><details><summary>Add story notes (optional)</summary><label>Events up to this stopping point<textarea name="notes" maxlength="12000" placeholder="Events you remember, or a chapter-limited excerpt."></textarea></label></details><div id="dialog-error" role="alert" hidden></div><button class="primary">Save progress & generate recap</button></form><div class="detail-actions"><button id="revise-milestone" class="quiet">Clarify stopping point</button><button id="return-game" class="quiet">Back to game</button></div>`,
  );
  $("#return-game").onclick = () => detail(g.id, update, "update");
  $("#revise-milestone").onclick = () =>
    confirmProgress(g, update, {
      question:
        "What is the last chapter or main-story quest you fully completed?",
    });
  $("#confirm-progress").onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target)),
      btn = ev.target.querySelector("button"),
      version = modalVersion;
    btn.disabled = true;
    btn.textContent = "Saving progress…";
    const h = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      label: result.label || update,
      percent,
      update,
      notes: data.notes || "",
      recap: "",
      sources,
      estimated: !result.confirmed,
      recapStatus: "pending",
      recapUpdatedAt: Date.now(),
    };
    try {
      const current = games.find((x) => x.id === g.id);
      if (!current) throw Error("This game is no longer in your library.");
      await saveGame({
        ...current,
        percent,
        status: percent === 100 ? "completed" : "playing",
        history: [...current.history, h],
      });
      keepDraft(g, "");
      if (isCurrent(version)) detail(g.id, "", "story");
      toast("Progress saved. Your recap will appear when ready.");
      void generateRecap(g.id, h.id);
    } catch (err) {
      if (isCurrent(version)) {
        inlineError(err.message);
        btn.disabled = false;
        btn.textContent = "Save progress & generate recap";
      }
    }
  };
}

function milestoneDialog(g) {
  modal(
    `<h2>Story milestones</h2><p>Use a verified list for this edition or route. One row per chapter: chapter number | title | cumulative percentage. Avoid future plot details in titles.</p><form id="milestone-form"><label>Milestone list<textarea name="list" rows="8" placeholder="1 | Chapter 1 | 5\n2 | Chapter 2 | 12">${e(g.milestones.map((m) => `${m.chapter} | ${m.label} | ${m.percent}`).join("\n"))}</textarea></label><label>Source URL<input name="source" type="url" value="${e(g.milestoneSource || "")}" placeholder="https://…"></label><button class="primary">Save milestones</button></form>`,
  );
  $("#milestone-form").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(ev.target));
      const milestones = data.list.trim()
        ? data.list
            .trim()
            .split("\n")
            .map((line) => {
              const [n, label, p] = line.split("|").map((s) => s.trim()),
                chapter = Number(n),
                percent = Number(p);
              if (
                !Number.isInteger(chapter) ||
                chapter < 1 ||
                !label ||
                !Number.isFinite(percent) ||
                percent < 0 ||
                percent > 100
              )
                throw Error(
                  "Use: chapter number | title | percentage (0–100).",
                );
              return { chapter, label, percent };
            })
        : [];
      if (new Set(milestones.map((m) => m.chapter)).size !== milestones.length)
        throw Error("Chapter numbers must be unique.");
      await saveGame({ ...g, milestones, milestoneSource: data.source });
      detail(g.id);
    } catch (err) {
      toast(err.message);
    }
  };
}
function importDialog() {
  if (demoGames) {
    toast("Exit demo to import into your library.");
    return;
  }
  modal(
    `<h2>Bring your games along.</h2><p>Import a CLZ Games CSV export. You’ll choose the columns and review games before adding them.</p><label>CSV file<input id="csv-file" type="file" accept=".csv,text/csv"></label><div class="dialog-tabs"><button id="steam-import">Import from Steam</button></div><p class="muted">PlayStation and Nintendo collections can be imported from CLZ CSV or added manually.</p>`,
  );
  $("#csv-file").onchange = async (ev) => {
    try {
      const file = ev.target.files[0];
      if (!file) return;
      if (file.size > 5_000_000) throw Error("Choose a CSV smaller than 5 MB.");
      const version = modalVersion,
        text = await file.text();
      if (isCurrent(version)) mapImport(parseCSV(text));
    } catch (err) {
      toast(err.message);
    }
  };
  $("#steam-import").onclick = steamDialog;
}
function mapImport(csv) {
  let mapping = guessMapping(csv.headers);
  modal(
    `<h2>Match your CLZ columns</h2><p>${csv.rows.length} rows found. You’ll review dates, platforms and editions before importing.</p><form id="mapping-form"><div class="mapping">${Object.keys(
      fields,
    )
      .map(
        (f) =>
          `<label>${e(f.replace(/([A-Z])/g, " $1"))}${f === "title" ? " *" : ""}<select name="${f}"><option value="-1">Not included</option>${csv.headers.map((h, i) => `<option value="${i}" ${mapping[f] === i ? "selected" : ""}>${e(h)}</option>`).join("")}</select></label>`,
      )
      .join(
        "",
      )}</div><div id="dialog-error" role="alert" hidden></div><button class="primary">Preview import</button></form><button id="import-back" class="quiet">Choose another file</button>`,
  );
  $("#import-back").onclick = importDialog;
  $("#mapping-form").onsubmit = (ev) => {
    ev.preventDefault();
    try {
      mapping = Object.fromEntries(
        [...new FormData(ev.target)].map(([k, v]) => [k, Number(v)]),
      );
      reviewImport(importRows(csv, mapping), () => mapImport(csv));
    } catch (err) {
      inlineError(err.message);
    }
  };
}
function reviewImport(incoming, back = settings, localMigration = false) {
  incoming = incoming.map((g) => ({
    ...g,
    platform: normalizePlatform(g.platform),
    releaseDate: normalizeReleaseDate(g.releaseDate || ""),
  }));
  modal(
    `<h2>Review your import</h2><p>Review every game. Matches use title, platform and edition. Existing progress and recaps are preserved.</p><label>Search preview<input id="import-search" type="search" placeholder="Title, platform or edition"></label><label>When a game already exists<select id="duplicate-policy"><option value="skip">Skip duplicate games</option><option value="fill">Fill missing details only</option></select></label><p id="import-summary" role="status" aria-live="polite"></p><div id="import-preview" class="import-preview"></div><div id="dialog-error" role="alert" hidden></div><div class="sticky-actions"><button id="confirm-import" class="primary">Import games</button><button id="import-back">Back</button></div>`,
  );
  const refresh = () => {
    const plan = planImport(games, incoming),
      fill = $("#duplicate-policy").value === "fill",
      newCount = plan.filter((p) => p.action === "add").length,
      invalid = incoming.filter(
        (g) => !g.title.trim() || !validReleaseDate(g.releaseDate),
      ).length;
    $("#import-summary").textContent =
      `${newCount} new · ${plan.length - newCount} duplicates ${fill ? "to fill missing details" : "skipped"}${invalid ? " · " + invalid + " rows need correction" : ""}`;
    $("#confirm-import").disabled = !!invalid || (!newCount && !fill);
    $("#confirm-import").textContent = fill
      ? "Import & fill missing details"
      : `Import ${newCount} games`;
    document.querySelectorAll(".import-row").forEach((el) => {
      const { game: g, action } = plan[Number(el.dataset.previewRow)];
      el.querySelector("summary strong").textContent =
        g.title || "Missing title";
      el.querySelector("summary span").textContent =
        g.platform + (g.edition ? " · " + g.edition : "");
      el.querySelector(".badge").textContent =
        (action === "add"
          ? "New"
          : fill
            ? "Fill missing only"
            : "Skip duplicate") +
        (!validReleaseDate(g.releaseDate) ? " · Check date" : "");
      const warning = el.querySelector("[data-row-warning]");
      warning.hidden = !!g.title.trim() && validReleaseDate(g.releaseDate);
      warning.textContent = !g.title.trim()
        ? "Enter a game title."
        : "This date is ambiguous or invalid. Enter YYYY or YYYY-MM-DD, or leave it blank.";
    });
  };
  const draw = () => {
    const openRows = new Set(
      [...document.querySelectorAll(".import-row[open]")].map(
        (el) => el.dataset.previewRow,
      ),
    );
    const plan = planImport(games, incoming),
      q = $("#import-search").value.toLowerCase(),
      invalid = incoming.filter(
        (g) => !g.title.trim() || !validReleaseDate(g.releaseDate),
      ).length,
      newCount = plan.filter((p) => p.action === "add").length,
      duplicates = plan.length - newCount,
      fill = $("#duplicate-policy").value === "fill";
    $("#import-summary").textContent =
      `${newCount} new · ${duplicates} duplicates ${fill ? "to review for missing details" : "skipped"}${invalid ? " · " + invalid + " rows need correction" : ""}`;
    $("#confirm-import").disabled = !!invalid || (!newCount && !fill);
    $("#confirm-import").textContent = fill
      ? "Import & fill missing details"
      : `Import ${newCount} games`;
    $("#import-preview").innerHTML =
      plan
        .map((p, i) => ({ ...p, i }))
        .filter((p) =>
          [p.game.title, p.game.platform, p.game.edition]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
        .map(
          ({ game: g, action, i }) =>
            `<details class="import-row" data-preview-row="${i}" ${openRows.has(String(i)) ? "open" : ""}><summary><strong>${e(g.title || "Missing title")}</strong><span>${e(g.platform)}${g.edition ? " · " + e(g.edition) : ""}</span><span class="badge">${action === "add" ? "New" : fill ? "Fill missing only" : "Skip duplicate"}${!validReleaseDate(g.releaseDate) ? " · Check date" : ""}</span></summary><div class="mapping">${[
              ["title", "Title"],
              ["platform", "Platform"],
              ["edition", "Edition"],
              ["releaseDate", "Release date (YYYY or YYYY-MM-DD)"],
              ["genre", "Genre"],
              ["developer", "Developer"],
            ]
              .map(
                ([field, label]) =>
                  `<label>${label}<input data-row="${i}" data-field="${field}" value="${e(g[field] || "")}" ${field === "title" ? "required" : ""}></label>`,
              )
              .join(
                "",
              )}<label>Collection<select data-row="${i}" data-field="collection"><option value="owned" ${g.collection === "owned" ? "selected" : ""}>Owned</option><option value="wishlist" ${g.collection === "wishlist" ? "selected" : ""}>Wishlist</option></select></label></div><p class="warning" data-row-warning ${validReleaseDate(g.releaseDate) ? "hidden" : ""}>This date is ambiguous or invalid. Enter YYYY or YYYY-MM-DD, or leave it blank.</p></details>`,
        )
        .join("") || "<p>No preview rows match your search.</p>";
    document.querySelectorAll("[data-row]").forEach(
      (el) =>
        (el.onchange = () => {
          const row = incoming[Number(el.dataset.row)],
            field = el.dataset.field;
          row[field] =
            field === "platform"
              ? normalizePlatform(el.value)
              : field === "releaseDate"
                ? normalizeReleaseDate(el.value)
                : el.value.trim();
          refresh();
        }),
    );
  };
  $("#import-search").oninput = draw;
  $("#duplicate-policy").onchange = draw;
  $("#import-back").onclick = back;
  draw();
  $("#confirm-import").onclick = async (ev) => {
    const button = ev.target,
      version = modalVersion,
      owner = user?.uid || "local",
      fill = $("#duplicate-policy").value === "fill";
    button.disabled = true;
    $("#import-back").disabled = true;
    let added = 0,
      updated = 0;
    try {
      for (const incomingGame of incoming) {
        if ((user?.uid || "local") !== owner)
          throw Error(
            "Your account changed. Review the remaining games before importing.",
          );
        const existing = games.find((g) => key(g) === key(incomingGame));
        if (existing) {
          if (fill) {
            const merged = mergeMissingDetails(existing, incomingGame);
            if (JSON.stringify(merged) !== JSON.stringify(existing)) {
              await saveGame(merged);
              updated++;
            }
          }
        } else {
          await saveGame(incomingGame);
          added++;
        }
        button.textContent = `Importing… ${added + updated} saved`;
      }
      if (localMigration) {
        migrationDismissed = true;
        render();
      }
      if (isCurrent(version)) {
        $("#modal").close();
      }
      toast(`${added} games added · ${updated} updated`);
    } catch (err) {
      if (isCurrent(version)) {
        inlineError(
          `${added} added, ${updated} updated before interruption. ${err.message} Retry safely; saved games will be matched as duplicates.`,
        );
        button.disabled = false;
        button.textContent = "Retry remaining games";
        $("#import-back").disabled = false;
      }
    }
  };
}
function steamDialog() {
  if (!user) {
    modal(
      '<h2>Import from Steam</h2><p>Sign in with Google to import and sync your Steam library.</p><button id="steam-signin" class="primary">Sign in with Google</button><button id="steam-back" class="quiet">Back to imports</button>',
    );
    $("#steam-signin").onclick = () => signIn(steamDialog);
    $("#steam-back").onclick = importDialog;
    return;
  }
  modal(
    `<h2>Import your Steam library</h2><p>Your Steam game details must be public. Enter your 17-digit Steam ID; the import previews owned games before saving.</p><form id="steam-form"><label>Steam ID<input name="steamId" required pattern="[0-9]{17}" placeholder="7656119…"></label><button class="primary">Find owned games</button></form><p class="muted">Requires Google sign-in and a backend configured with a Steam Web API key.</p>`,
  );
  $("#steam-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button"),
      version = modalVersion;
    btn.disabled = true;
    try {
      const r = await api(
        "/steam",
        Object.fromEntries(new FormData(ev.target)),
      );
      if (!isCurrent(version)) return;
      reviewImport(
        r.games.map((g) => ({
          ...g,
          id: crypto.randomUUID(),
          collection: "owned",
          status: "not-started",
          percent: 0,
          history: [],
          milestones: [],
          edition: "",
          developer: "",
          releaseDate: "",
          genre: "Unsorted",
        })),
      );
    } catch (err) {
      if (isCurrent(version)) {
        toast(err.message);
        btn.disabled = false;
      }
    }
  };
}
$("#import-btn").onclick = importDialog;
$("#export-btn").onclick = () => {
  const quote = (s) =>
    '"' +
    String(s ?? "")
      .replace(/^[=+@-]/, (m) => "'" + m)
      .replaceAll('"', '""') +
    '"';
  const content = [
    [
      "Title",
      "Platform",
      "Genre",
      "Release Date",
      "Developer",
      "Edition",
      "Collection",
      "Status",
      "Progress",
    ],
    ...games.map((g) => [
      g.title,
      g.platform,
      g.genre,
      g.releaseDate,
      g.developer,
      g.edition,
      g.collection,
      g.status,
      g.percent,
    ]),
  ]
    .map((row) => row.map(quote).join(","))
    .join("\r\n");
  download(content, "questtracker.csv", "text/csv");
};
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function settings() {
  if (demoGames) {
    toast("Exit demo to manage your library and backups.");
    return;
  }
  modal(
    `<h2>Connections & settings</h2><div class="notice">${user ? "Google account connected." : "Sign in with Google for device sync and automatic details."} ${syncStatus === "error" ? "Sync needs attention." : user ? "Library sync is connected." : "Your library is stored on this device."}</div><p>Google sync keeps each game and its progress journal in your private account. Without sign-in, changes stay on this device.</p>${!user ? '<button id="settings-signin" class="primary">Sign in with Google</button>' : ""}<div class="detail-actions"><button id="backup">Download full backup</button>${user && readLocal().length ? '<button id="migrate">Import this device’s local games</button>' : ""}<label>Restore backup<input id="restore" type="file" accept=".json,application/json"></label></div><p class="muted">CSV exports contain game details. Full backups also include progress history and recaps.</p>`,
  );
  $("#settings-signin")?.addEventListener("click", () => signIn(settings));
  $("#migrate")?.addEventListener("click", () =>
    reviewImport(readLocal(), settings, true),
  );
  $("#backup").onclick = () =>
    download(
      JSON.stringify({ version: 1, games }, null, 2),
      "questtracker-backup.json",
      "application/json",
    );
  $("#restore").onchange = async (ev) => {
    try {
      const file = ev.target.files[0];
      if (file.size > 10_000_000) throw Error("Backup is too large.");
      if (!file) return;
      const version = modalVersion;
      const data = JSON.parse(await file.text());
      if (!isCurrent(version)) return;
      if (data.version !== 1 || !Array.isArray(data.games))
        throw Error("Invalid backup.");
      const valid = data.games.every(
        (g) =>
          typeof g.title === "string" &&
          typeof g.platform === "string" &&
          typeof g.genre === "string" &&
          typeof g.releaseDate === "string" &&
          ["owned", "wishlist"].includes(g.collection) &&
          Object.hasOwn(labels, g.status) &&
          Number.isFinite(g.percent) &&
          g.percent >= 0 &&
          g.percent <= 100 &&
          Array.isArray(g.history) &&
          Array.isArray(g.milestones) &&
          g.history.every(
            (h) =>
              typeof h.id === "string" &&
              typeof h.date === "string" &&
              typeof h.update === "string" &&
              typeof h.label === "string" &&
              Number.isFinite(h.percent) &&
              h.percent >= 0 &&
              h.percent <= 100 &&
              (!h.sources || Array.isArray(h.sources)),
          ) &&
          g.milestones.every(
            (m) =>
              Number.isInteger(m.chapter) &&
              typeof m.label === "string" &&
              Number.isFinite(m.percent) &&
              m.percent >= 0 &&
              m.percent <= 100,
          ),
      );
      if (!valid) throw Error("Backup contains invalid games.");
      reviewImport(data.games.map((g) => ({ ...g, id: crypto.randomUUID() })));
    } catch (err) {
      toast(err.message);
    }
  };
}
$("#settings").onclick = settings;
async function api(route, body) {
  if (!user) throw Error("Sign in with Google first.");
  if (!config.apiBase)
    throw Error("The backend service is not configured yet.");
  let r;
  try {
    r = await fetch(config.apiBase.replace(/\/$/, "") + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (await user.getIdToken()),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150000),
    });
  } catch (err) {
    throw Error(
      err.name === "TimeoutError"
        ? "The service took too long to respond. Please retry."
        : "Could not reach the service. Check your connection and retry.",
    );
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("The service returned an unreadable response. Please retry.");
  }
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}
function subscribeLibrary() {
  if (!user || !cloud) return;
  unsubscribe?.();
  const uid = user.uid;
  setSync("loading");
  $("#sync-state").textContent = "Loading your synced library…";
  unsubscribe = cloud.onSnapshot(
    cloud.collection(cloud.db, "users", uid, "games"),
    (snap) => {
      if (user?.uid !== uid) return;
      games = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      syncStatus = snap.metadata.hasPendingWrites ? "syncing" : "synced";
      syncError = "";
      $("#sync-state").textContent = snap.metadata.hasPendingWrites
        ? "Syncing changes…"
        : "Synced across devices";
      render();
    },
    (err) => {
      if (user?.uid !== uid) return;
      $("#sync-state").textContent = "Sync unavailable";
      setSync(
        "error",
        "Your saved library could not be reached. " + err.message,
      );
    },
  );
}
async function initCloud() {
  if (!config.firebase) return;
  try {
    const base = "https://www.gstatic.com/firebasejs/12.4.0/";
    const [fb, auth, db] = await Promise.all([
      import(base + "firebase-app.js"),
      import(base + "firebase-auth.js"),
      import(base + "firebase-firestore.js"),
    ]);
    const app = fb.initializeApp(config.firebase),
      a = auth.getAuth(app),
      database = db.getFirestore(app);
    cloud = { ...db, db: database, auth: a, ...auth };
    auth.onAuthStateChanged(a, (u) => {
      unsubscribe?.();
      const changed = (user?.uid || null) !== (u?.uid || null);
      user = u;
      if (changed) {
        migrationDismissed = false;
        demoGames = null;
        $("#modal").close();
      }
      $("#login").textContent = u
        ? "Sign out · " + (u.displayName || u.email)
        : "G · Sign in with Google";
      if (u) {
        games = [];
        subscribeLibrary();
      } else {
        games = readLocal();
        syncStatus = "local";
        syncError = "";
        $("#sync-state").textContent = "Local library · this device only";
        render();
      }
      if (u && authContinuation) {
        const next = authContinuation;
        authContinuation = null;
        next();
      }
    });
  } catch (err) {
    $("#sync-state").textContent = "Google sign-in unavailable";
    syncError = "Google sign-in could not load. " + err.message;
    setSync("error", syncError);
  }
}
async function signIn(continuation) {
  if (!config.firebase) {
    settings();
    return;
  }
  if (!cloud) {
    toast("Google sign-in is still loading. Please retry shortly.");
    return;
  }
  try {
    if (user) {
      continuation?.();
      return;
    }
    authContinuation = continuation;
    await cloud.signInWithPopup(cloud.auth, new cloud.GoogleAuthProvider());
    if (authContinuation && user) {
      const next = authContinuation;
      authContinuation = null;
      next();
    }
  } catch (err) {
    authContinuation = null;
    inlineError("Could not sign in. " + err.message);
  }
}
$("#login").onclick = async () => {
  if (user) {
    try {
      await cloud.signOut(cloud.auth);
    } catch (err) {
      toast(err.message);
    }
  } else await signIn();
};
function loadDemo() {
  const samples = [
    [
      "The Legend of Zelda: Tears of the Kingdom",
      "Nintendo Switch",
      "Adventure",
      "2023-05-12",
      "Nintendo",
      35,
      "playing",
    ],
    [
      "Final Fantasy VII Rebirth",
      "PlayStation 5",
      "Action RPG",
      "2024-02-29",
      "Square Enix",
      42,
      "paused",
    ],
    [
      "Baldur’s Gate 3",
      "PC / Steam",
      "RPG",
      "2023-08-03",
      "Larian Studios",
      0,
      "not-started",
    ],
    [
      "God of War Ragnarök",
      "PlayStation 5",
      "Action Adventure",
      "2022-11-09",
      "Santa Monica Studio",
      100,
      "completed",
    ],
    [
      "Elden Ring",
      "PC / Steam",
      "Action RPG",
      "2022-02-25",
      "FromSoftware",
      0,
      "not-started",
    ],
    [
      "Persona 5 Royal",
      "Nintendo Switch",
      "JRPG",
      "2022-10-21",
      "Atlus",
      0,
      "not-started",
    ],
  ];
  demoGames = samples.map(
    ([title, platform, genre, releaseDate, developer, percent, status], i) => ({
      id: "demo-" + i,
      title,
      platform,
      genre,
      releaseDate,
      developer,
      percent,
      status,
      collection: "owned",
      edition: "Sample data",
      cover: "",
      history: [],
      milestones: [],
    }),
  );
  clearFilters();
}
const desktopQuery = matchMedia("(min-width:851px)");
$("#overview").open = desktopQuery.matches;
desktopQuery.addEventListener("change", (ev) => {
  $("#overview").open = ev.matches;
});
$("#view-toggle").onclick = () => {
  const compact = $("#games").classList.toggle("compact");
  $("#view-toggle").setAttribute("aria-pressed", String(compact));
  $("#view-toggle").textContent = compact ? "Card view" : "List view";
};
render();
initCloud();

function lookupGame(draft = draftGame()) {
  modal(
    `<h2>${draft.id ? "Find game details" : "Add a game"}</h2><p>Search for a game, choose your platform, then review its details.</p>${!user ? '<div class="notice"><strong>Sign in for automatic game details</strong><p>Your library will also sync across devices. You can add games manually on this device.</p><button id="lookup-signin" class="primary">Sign in with Google</button></div>' : ""}<form id="rawg-search"><label>Game title<input name="query" autofocus required minlength="2" maxlength="200" value="${e(draft.title || "")}" placeholder="Search by game title…"></label><button class="primary" ${!user ? "disabled" : ""}>Search games</button></form><div id="rawg-results" class="lookup-results" aria-live="polite"></div><div class="detail-actions"><button id="manual-game">${draft.id ? "Back to details" : "Enter details manually"}</button></div><p class="muted">Game data and images from <a class="link" href="https://rawg.io" target="_blank" rel="noopener noreferrer">RAWG</a>.</p>`,
  );
  $("#manual-game").onclick = () =>
    draft.id
      ? detail(draft.id)
      : addDialog({ ...draft, title: $("#rawg-search input").value });
  $("#lookup-signin")?.addEventListener("click", () => {
    const next = { ...draft, title: $("#rawg-search input").value };
    signIn(() => lookupGame(next));
  });
  $("#rawg-search").onsubmit = async (ev) => {
    ev.preventDefault();
    const query = new FormData(ev.target).get("query"),
      btn = ev.target.querySelector("button"),
      version = modalVersion;
    btn.disabled = true;
    $("#rawg-results").textContent = "Searching…";
    $("#rawg-results").setAttribute("aria-busy", "true");
    try {
      const result = await api("/rawg/search", { query });
      if (!isCurrent(version)) return;
      $("#rawg-results").innerHTML = result.games.length
        ? result.games
            .map(
              (g) =>
                `<button data-rawg="${g.rawgId}"><strong>${e(g.title)}</strong><span class="muted">${e(g.releaseDate || "Release date unknown")} · ${e(g.platforms.map((p) => p.name).join(", "))}</span></button>`,
            )
            .join("")
        : "No matches. Try a shorter title or another spelling, or enter details manually.";
      document.querySelectorAll("[data-rawg]").forEach(
        (b) =>
          (b.onclick = async () => {
            b.disabled = true;
            try {
              const { game } = await api("/rawg/details", {
                id: Number(b.dataset.rawg),
              });
              if (isCurrent(version))
                reviewMetadata(draft, game, () => {
                  lookupGame({ ...draft, title: query });
                  $("#rawg-search").requestSubmit();
                });
            } catch (err) {
              if (isCurrent(version)) {
                const error = document.createElement("p");
                error.className = "warning";
                error.setAttribute("role", "alert");
                error.textContent = err.message;
                b.after(error);
                b.disabled = false;
              }
            }
          }),
      );
    } catch (err) {
      if (isCurrent(version))
        $("#rawg-results").innerHTML =
          `<div class="notice" role="alert">${e(err.message)}<p>Retry your search, or enter the details manually.</p></div>`;
    } finally {
      if (isCurrent(version)) {
        btn.disabled = false;
        $("#rawg-results").setAttribute("aria-busy", "false");
      }
    }
  };
}
function reviewMetadata(draft, metadata, back = () => lookupGame(draft)) {
  modal(
    `<h2>Review RAWG match</h2><h3>${e(metadata.title)}</h3><div class="form-row">${metadata.cover ? `<img class="match-cover" src="${e(metadata.cover)}" alt="${e(metadata.title)} cover" referrerpolicy="no-referrer">` : ""}<div><p>Genre: ${e(metadata.genre || "Unknown")}<br>Developer: ${e(metadata.developer || "Unknown")}<br>First release: ${e(metadata.releaseDate || "Unknown")}</p><a class="link" href="${e(metadata.rawgUrl)}" target="_blank" rel="noopener noreferrer">View on RAWG ↗</a></div></div><form id="rawg-review"><label>Platform<select name="platform">${metadata.platforms.length ? metadata.platforms.map((p, i) => `<option value="${i}">${e(p.name)}${p.releaseDate ? " · " + e(p.releaseDate) : ""}</option>`).join("") : '<option value="-1">Unknown</option>'}</select></label>${draft.platform && draft.platform !== "Unknown" ? `<p class="muted">Your saved platform (${e(draft.platform)}) will be kept. Select the matching platform for its release date.</p>` : ""}<p class="muted">Only missing fields will be filled. Review and edit the form before saving.</p><button class="primary">Use these details</button></form><button id="match-back" class="quiet">Back to search results</button>`,
  );
  $("#match-back").onclick = back;
  const sel = $("#rawg-review select");
  const index = metadata.platforms.findIndex(
    (p) =>
      p.name.toLowerCase() === draft.platform?.toLowerCase() ||
      (draft.platform === "PC / Steam" && p.name === "PC"),
  );
  if (index >= 0) sel.value = String(index);
  $("#rawg-review").onsubmit = (ev) => {
    ev.preventDefault();
    addDialog(
      enrichGame(draft, metadata, metadata.platforms[Number(sel.value)]),
    );
  };
}
