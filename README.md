# QuestTracker

A personal game library, wishlist and main-story progress journal. Static frontend for GitHub Pages; Google authentication and Firestore for private cross-device sync; a Cloudflare Worker for OpenAI and Steam requests.

## Try locally

Node 22+, no frontend dependencies or installation required:

```sh
npm run dev
```

Open http://127.0.0.1:5173. Add games or import CSV immediately. Local mode uses browser storage and does not sync. The optional sample library is isolated and read-only; Exit demo returns to your real library. Google, Steam, and AI buttons report configuration requirements instead of pretending to work.

## Configure Google login and sync

1. Create a Firebase project on the Spark plan, register a Web app, enable Google under Authentication → Sign-in method, and create a Firestore database.
2. Add `localhost`, `127.0.0.1` and `YOUR_USERNAME.github.io` to Authentication → Settings → Authorized domains. Use the correct Google support email.
3. Copy the public Web app configuration into `web/config.js`:

```js
export const config = {
  firebase: {
    apiKey: 'YOUR_FIREBASE_PUBLIC_WEB_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    projectId: 'YOUR_PROJECT',
    appId: 'YOUR_WEB_APP_ID'
  },
  apiBase: 'https://questtracker-api.YOUR_SUBDOMAIN.workers.dev'
};
```

Firebase web configuration is public by design; Firestore rules enforce access. Never place OpenAI or Steam secrets here.

4. Replace `YOUR_GOOGLE_EMAIL` in `firestore.rules` with your Google account email and publish these rules in the Firestore console. Only that verified Google account can read or write its library. If using the CLI, run `npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT`.
5. Sign in. Local games stay separate; after signing in, use the Review local games banner (or Connections & settings) to preview and migrate them into your account.

Catalogue games and active playthroughs have separate documents. One catalogue entry stores all owned platforms and editions. Start a playthrough from its catalogue entry to track a particular platform. Completing the main story archives its journal under the catalogue entry, marks the game completed, and removes that playthrough from the active list. Other active playthroughs remain independent. Existing platform records consolidate automatically on sign-in; original records are retained for recovery. Transactions merge progress entries by ID to preserve concurrent journals. Each changed record receives a Firestore server timestamp, and the same transaction updates the account sync watermark. Each device performs one initial load, then pulls only changes at most once every 24 hours or through Settings → Sync now. A browser cache displays games immediately on return visits. Completion deltas remove archived active playthroughs. Migration has an account-level completion marker and never rescans legacy records after success. Game metadata is last-write-wins. Cloud saves require a connection; errors are shown and can be retried. Firestore documents have a size limit; unusually long journals may eventually need a subcollection migration.

## Configure the secure backend

The backend uses native fetch/Web Crypto-compatible APIs and a SQLite Durable Object for an atomic daily AI request quota. A Cloudflare account is required; use Workers Free if eligible. OpenAI usage, including web search, is separately paid.

1. Update `backend/wrangler.toml`: your Google email, Firebase public Web API key, allowed website origins (origin only, no path), model, and daily AI limit. The backend fails closed without account configuration. For local backend testing, include the exact frontend origin.
2. From `backend/`, deploy and set secrets using the official Wrangler CLI:

```sh
npx wrangler deploy
npx wrangler secret put OPENAI_API_KEY
# Optional, for Steam owned-game import:
npx wrangler secret put STEAM_API_KEY
```

Enter secret values into the CLI prompts, never source files or chat. Ensure your OpenAI project has billing and access to the selected model and Responses web search. Default model: `gpt-6.1-sol`, with low reasoning effort and additional output-token allowance for reasoning. This can be changed with `OPENAI_MODEL`.

3. Set `apiBase` in `web/config.js` to the deployed Worker URL. Configure OpenAI spending controls in your API account as well as this app’s quota. The daily limit counts API calls, not updates: a researched update can use three calls (milestone lookup, evidence retrieval, recap). It resets at midnight UTC. Failed requests still consume the reserved count.

The Worker verifies the Firebase ID token through Firebase’s project-specific identity lookup, checks the verified owner email and Google provider, validates CORS, limits payload size and output tokens, and uses `store:false` for OpenAI requests. No credentials are returned to the browser. CORS complements authentication; it does not replace it.

## Publish on GitHub Pages

1. Create a public repository (for GitHub Free), upload this project, and push to `main`.
2. In the repository, Settings → Pages → Source: **GitHub Actions**.
3. The included `.github/workflows/pages.yml` checks syntax, runs tests, builds static assets, and deploys `dist`.
4. The app works at `https://YOUR_USERNAME.github.io/REPOSITORY/` because assets use relative paths. You can also use a `YOUR_USERNAME.github.io` repository for the root domain. There is no client-side routing to break refreshes.
5. Configure the Firebase authorized domain and Worker allowed origin for that hostname. Personal library data is never committed to the repository.

The deployed app is available at https://pravityo.github.io/questracker/. Account-specific integrations still require the configuration above.

## Imports

CLZ CSV import supports UTF-8 BOM, quoted commas, escaped quotes, multiline values and CRLF. Map title, platform, genre, release date, developer, edition, collection and status. Review before saving. Catalogue entries consolidate by normalized title; ownership copies are distinguished by platform and edition. Existing progress is preserved. Distinct titles, including remasters with different names, remain separate. Steam import requires a 17-digit Steam ID, public game details and a server-side Steam key. It imports owned titles and covers; genres/release dates can be edited afterward. PlayStation and Nintendo are supported through CLZ imports/manual entry, not direct account sync.

CSV export includes one row per active ownership copy and its metadata. Full JSON backups include catalogue entries, active playthroughs, archived journals, recaps, milestones and removed games. Restore merges matching records and journal entries without discarding existing progress. Large restores commit in batches.

## Progress and spoiler boundaries

- “Finished chapter 8” matches a user-supplied verified milestone list when available.
- Otherwise the AI searches story structure and asks for clarification when ambiguous. Web percentages are estimates; the stopping point always requires confirmation.
- Main-story completion is 100%. Achievements, playtime, collectibles and side quests do not determine completion.
- Recaps are generated from supplied story notes or searched evidence that the model identifies as at/before the confirmed milestone. If evidence is insufficient, no recap is generated; progress still saves.
- Web-derived evidence classification and AI generation are probabilistic: spoiler exclusion and factual accuracy cannot be guaranteed. For the strongest control, provide your own chapter-bounded story notes. This initial build has not yet been evaluated with live game recaps.
- Each journal entry preserves the raw update, confirmed milestone, percentage, notes, recap and cited source URLs. An older recap is explicitly labeled when the newest update has none.

## Validation

```sh
npm run check
npm test
npm run build
```

Tests cover CLZ quoting, column mapping, platform-sensitive duplicates, safe HTML escaping, chapter ambiguity, main-story completion, owner authentication and daily request limits. Firebase rules and live Firebase/OpenAI/Steam calls still require integration testing after configuration.

## Official references

- [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin)
- [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth)
- [OpenAI Responses API](https://developers.openai.com/api/docs/quickstart)
- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## RAWG metadata lookup

Get a personal API key from https://rawg.io/apidocs (Free plan). In `backend/`, run `npx wrangler secret put RAWG_API_KEY` and enter the key at the hidden prompt. The key stays server-side. Redeploy with `npx wrangler deploy` after backend source updates.

Add game → Find details on RAWG searches titles. Choose the correct edition, select its platform, and review the editable form before saving. Existing games have Find missing details; the library also has Fill missing details for selecting imported games that need enrichment. This is a per-game review workflow, not an unattended bulk match. Existing populated fields, ownership and journals are preserved; Unknown platforms and Unsorted genres count as missing. Multi-genre results are individually filterable. Descriptions are deliberately excluded from provider responses to avoid importing plot spoilers. RAWG release dates may be first-release dates when platform-specific dates are absent.

RAWG requests require the verified Google owner and have a separate 100-request daily cap, independent of the AI quota. RAWG attribution is shown in the app and lookup dialogs. Search and detail selection each consume one provider request. Live RAWG access must be tested after adding the secret.

## Interaction and recovery

- Add game starts with RAWG title search. Google sign-in is explained before searching; manual entry remains available locally.
- Confirmed progress saves before recap generation. A persistent status shows generation or failure, and Retry recap uses the saved stopping point. Closing the dialog does not cancel generation; reloading may interrupt it, and the saved entry can be retried.
- Story, Update progress and Journal tabs keep long recaps separate from updates. Estimated percentages use `~` consistently. Draft updates stay in session storage until saved.
- Import review includes every row, normalizes known platform aliases and year-first dates, and flags ambiguous dates for correction. Matching includes edition. Duplicate handling either skips records or fills missing metadata while preserving progress.
- Mobile uses collapsible overview and filters, touch-sized controls, and full-screen dialogs. Card and compact list views are available. Dialog headings, focus restoration, keyboard tab navigation and reduced motion are supported.


### Collection recovery, appearance and bulk review

- CSV review displays 25 rows per page. When collection status is absent, choose Library or Wishlist before saving. Imports commit up to 25 games per transaction and serialize a local batch once. Pause waits for the current batch; resume matches saved games safely. Closing the page interrupts the job: select the CSV again to resume through duplicate matching.
- Removed games stay in **Settings → Recently removed games**, including their journals and recaps. Restore them there. Full backups include removed games; CSV exports contain active games.
- Appearance offers Light and Dark. The initial choice follows the device, and an explicit choice is remembered on that browser. Compact list mode is remembered too.
- Fill missing details can propose 20 RAWG matches at a time. Only unique exact title/platform matches are proposed. Review and select suggestions; unmatched games remain available for manual lookup. This can use up to 40 of the 100 daily metadata lookup calls. Existing fields, ownership and journals are preserved.
- New recaps cover the main story from the beginning to the confirmed stopping point, summarizing earlier arcs and detailing the latest three completed chapters (or equivalent recent segment). Source evidence must cover both arcs. Story notes supplement the research; they do not limit the recap to recent events. A full recap waits if evidence for earlier chapters is unavailable. Use **Refresh full story recap** to update an existing recap.
- Steam import is available under **Import games → Import from Steam**. Set a personal Steam Web API key as the Cloudflare secret `STEAM_API_KEY` (`npx wrangler secret put STEAM_API_KEY` from `backend/`). Enter SteamID64 with public game details, then review and import. Re-import later for newly owned games; playtime does not change story progress. No background polling is performed.

### Compact navigation and efficient loading

Appearance is under Connections & settings. Mobile uses two compact navigation rows, a single search/filter row, and an icon for card/list view. Collection overview is available in settings on mobile. Games render 24 at a time; Load more adds the next 24, while search and filters still cover the complete cached catalogue. Covers load lazily. This limits rendering and image requests; the initial account download still retrieves complete metadata so filtering, imports and backups remain correct.

Each device checks remote changes once every 24 hours; edits save immediately. Manual Sync now bypasses that interval. Quota failures preserve the cache and pause automatic retries. Clearing browser storage or using a new device requires an initial complete download again. Firebase quota exhaustion must clear before server operations can succeed; caching cannot increase the quota.

A failed sync with no cached playthroughs displays an unavailable state rather than claiming the progress list is empty. A signed-in catalogue game offers Recover earlier progress: it reads only that game’s retained legacy records and restores missing journals. Existing active and archived playthroughs are preserved, and completed or removed stories are not reopened. Recovery requires available Firestore quota.
