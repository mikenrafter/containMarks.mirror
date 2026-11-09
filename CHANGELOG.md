# Changelog

## 1.2.2

### Added
- Added an optional folder picker for the bookmark button (`Ask where to save each time`), so you can choose the folder and name for each bookmark (#5).
- Added live tests that drive a real Firefox over Marionette (`npm run test:live`), and a script that regenerates every README/product-page screenshot and GIF (`npm run capture:readme`), both built on [firefox-addon-live](https://github.com/mikenrafter/firefox-addon-live). The settings capture is now a taller GIF that shows the whole page.
- Added options page with a bookmark-folder picker for page-action bookmark target selection.
- Added token retention toggles (`Reset tokens on startup`, `Regenerate token on every use`) with risk acknowledgement gating.
- Added sync-aware container mapping folder support in Bookmarks Menu via `ContainMarks Sync`.
- Added tests for settings, container mapping parsing, mapping store behavior, and sync opening paths.

### Changed
- Changed bookmark URL format to `about:{token}:{containerID}:https://...` while retaining compatibility with legacy URLs.
- Changed container mapping format to `about:{firstSeenIndex}:{cookieStoreId}:{backupName}`.
- Changed menu item identity handling to use `cookieStoreId` and preserve stable first-seen container indices.
- Changed runtime resolution to bookmark-only token flow: prefixed URL detection + exact bookmark URL match + container lookup via mapping folder.
- Removed persistent localStorage token/mapping mirrors from active runtime logic.

### Fixed
- Fixed cross-device sync behavior where token-only validation could fail without local token storage.
- Fixed mapping rename/recreation handling to preserve first-seen index and remap intelligently.
- Fixed startup migration to transfer legacy localStorage references into bookmark URL + mapping-folder based format.
