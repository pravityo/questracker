# QuestTracker

A personal game library, wishlist and main-story progress journal. Static frontend for GitHub Pages; Google authentication and Firestore for private cross-device sync; a Cloudflare Worker for OpenAI and Steam requests.

## Try locally

Node 22+, no frontend dependencies or installation required:

```sh
npm run dev
```

Open http://127.0.0.1:5173. Add games or import CSV immediately. Local mode uses browser storage and does not sync. The optional sample library is explicitly labeled sample data. Google, Steam, and AI buttons report configuration requirements instead of pretending to work.

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
5. Sign in. Local games stay separate; use Connections & settings → Import this device’s local games to preview and migrate them into your account.

Each game is its own document. Transactions merge progress entries by ID to preserve concurrent journals. Game metadata is last-write-wins. Cloud saves require a connection; errors are shown and can be retried. Firestore documents have a size limit; unusually long journals may eventually need a subcollection migration.

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

Enter secret values into the CLI prompts, never source files or chat. Ensure your OpenAI project has billing and access to the selected model and Responses web search. Default model: `gpt-4.1-mini`. This can be changed with `OPENAI_MODEL`.

3. Set `apiBase` in `web/config.js` to the deployed Worker URL. Configure OpenAI spending controls in your API account as well as this app’s quota. The daily limit counts API calls, not updates: a researched update can use three calls (milestone lookup, evidence retrieval, recap). It resets at midnight UTC. Failed requests still consume the reserved count.

The Worker verifies the Firebase ID token through Firebase’s project-specific identity lookup, checks the verified owner email and Google provider, validates CORS, limits payload size and output tokens, and uses `store:false` for OpenAI requests. No credentials are returned to the browser. CORS complements authentication; it does not replace it.

## Publish on GitHub Pages

1. Create a public repository (for GitHub Free), upload this project, and push to `main`.
2. In the repository, Settings → Pages → Source: **GitHub Actions**.
3. The included `.github/workflows/pages.yml` checks syntax, runs tests, builds static assets, and deploys `dist`.
4. The app works at `https://YOUR_USERNAME.github.io/REPOSITORY/` because assets use relative paths. You can also use a `YOUR_USERNAME.github.io` repository for the root domain. There is no client-side routing to break refreshes.
5. Configure the Firebase authorized domain and Worker allowed origin for that hostname. Personal library data is never committed to the repository.

No GitHub repository, Firebase project, Cloudflare Worker, or OpenAI account has been created or deployed by this initial build. Live integrations require the above account configuration and an end-to-end smoke test.

## Imports

CLZ CSV import supports UTF-8 BOM, quoted commas, escaped quotes, multiline values and CRLF. Map title, platform, genre, release date, developer, edition, collection and status. Review before saving. Duplicates are identified by case-insensitive title + platform; existing progress is preserved. Different editions on the same platform currently count as duplicates. Steam import requires a 17-digit Steam ID, public game details and a server-side Steam key. It imports owned titles and covers; genres/release dates can be edited afterward. PlayStation and Nintendo are supported through CLZ imports/manual entry, not direct account sync.

CSV export includes metadata and current percentage. Full JSON backup includes journals, recaps and milestones. Backup restore previews additions and skips duplicates; it does not overwrite existing records.

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
