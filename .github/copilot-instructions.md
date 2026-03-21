# Copilot instructions for `containMarks`

## Project scope and runtime
- This repo is a Firefox WebExtension (Manifest V2), not a generic web app. Entry points are `src/background.ts` and `src/options.ts`, bundled into `src/background.js` and `src/options.js`.
- Core behavior: bookmarks encode container assignment in URL form `about:<token>:<containerIndex>:<realUrl>` (see `src/containerMappings.ts`).

## Architecture you should keep in mind
- `src/backgroundApp.ts` is the orchestration layer. It wires Firefox APIs, startup migration, context menus, tab interception, and page-action bookmarking.
- `src/containerMappingStore.ts` is the source of truth for container-index mappings. It persists mappings as bookmarks under `Bookmarks Menu/menu________` in folder `ContainMarks Sync`.
- Mapping records are bookmark URLs shaped as `about:<firstSeenIndex>:<cookieStoreId>:<backupName>`; parse/build logic lives in `src/containerMappings.ts`.
- `src/settings.ts` owns settings schema/sanitization/validation and storage key `containMarks.settings`; options UI (`src/options.ts`) should use `loadSettings`/`saveSettings`, not direct storage writes.

## Data-flow rules that are easy to miss
- Container assignment is index-based for sync stability: bookmark URLs store `containerIndex`, then runtime resolves index -> container via `ContainerMappingStore.getByIndex`.
- On startup, `BackgroundApp.startup()` must run mapping-store init before flows that depend on index resolution.
- Legacy `localStorage` references are migrated in `migrateLegacyStorage()`; avoid reintroducing localStorage-based mapping state.
- `handleTabUpdated` opens encoded URLs in the mapped container, then optionally rotates token based on settings.

## Repo-specific coding patterns
- Keep logic in TypeScript sources under `src/*.ts`; compiled `src/*.js` are build artifacts produced by `npm run build`.
- Use the typed interfaces in `src/models.ts` when touching browser APIs and test doubles.
- Risky token-retention settings are gated by explicit acknowledgment (`acknowledgeRiskyTokenBehavior`); preserve this contract (`validateSettings`).
- Preserve constants and URL codec behavior in `src/containerMappings.ts` (`PREFIX`, `DELIMITER`, token length checks) because tests assert exact formats.

## Build/test workflow
- If unsure, check if nix is installed.
- Install deps: `npm install` (or `nix develop -c npm install`).
- Type-check: `npm run typecheck`.
- Run tests: `npm test` (Vitest with `tests/**/*.test.ts`).
- Build extension JS bundle: `npm run build`.
- Produce distributable artifact: `npm run build:firefox` (zip in `dist/`), or `npm run build:firefox:xpi` for unsigned `.xpi` copy.

## Test expectations and examples
- Add/adjust tests in `tests/` alongside changed behavior (`backgroundApp.test.ts`, `containerMappingStore.test.ts`, `containerMappings.test.ts`, `settings.test.ts`).
- Mock browser APIs using typed shapes similar to existing tests (see `createBrowserMock` and `createMappingStoreBrowserMock`).
- For URL changes, assert regex/shape compatibility with existing expectations like `^about:[^:]+:\d+:https://...$`.