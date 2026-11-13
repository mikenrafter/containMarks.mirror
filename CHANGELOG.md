# Changelog

## 1.2.2

### Added
- Added an optional folder picker for the bookmark button (`Ask where to save each time`), so you can choose the folder and name for each bookmark (#5).
- Added live tests that drive a real Firefox over Marionette (`npm run test:live`), and a script that regenerates every README/product-page screenshot and GIF (`npm run capture:readme`), both built on [firefox-addon-live](https://github.com/mikenrafter/firefox-addon-live). The settings capture is now a taller GIF that shows the whole page.

## 1.2.1

### Fixed
- Fixed container reassignment.
- Fixed an edge case when opening a bookmark while the active window has only one tab.

## 1.2.0

### Added
- Added an integration with Temporary Containers and Temporary Containers Plus: a new open-in option for a temporary container, temporary containers filtered from the assignment list, and more reliable bookmark opening with the TC extension installed.

### Changed
- Changed bookmark URL format to `https://...#cm:{token}:{containerIndex}` (the original fragment, if any, is kept after it) so bookmark favicons work again. Older `about:` URLs are migrated.
- Streamlined native bookmark editing by hot-swapping tokens in a way that is nearly invisible to the user.
- Reorganized the settings and options page.
- Improved migration when sync behavior changes, with a clearer orphan-mapping warning when saved mappings no longer match active containers.

### Fixed
- Fixed the page-action icon being forced visible by manifest URL matching, which could show it at the wrong times and make it flicker.

## 1.1.5

### Added
- Added an option to hide the "Bookmark this URL inside this container" button.
- Added an option to disable Firefox Sync features.
- Added explicit migration between the local and Firefox Sync formats in settings.

## 1.1.0

### Added
- Added options page with a bookmark-folder picker for page-action bookmark target selection.
- Added token retention toggles (`Reset tokens on startup`, `Regenerate token on every use`) with risk acknowledgement gating.
- Added sync-aware container mapping folder support in Bookmarks Menu via `ContainMarks Sync`.
- Added new icons.
- Added tests for settings, container mapping parsing, mapping store behavior, and sync opening paths.

### Changed
- Rewrote the extension in TypeScript.
- Changed bookmark URL format to `about:{token}:{containerIndex}:https://...` while retaining compatibility with legacy URLs.
- Changed container mapping format to `about:{firstSeenIndex}:{cookieStoreId}:{backupName}`.
- Changed menu item identity handling to use `cookieStoreId` and preserve stable first-seen container indices.
- Changed runtime resolution to bookmark-only token flow: prefixed URL detection + exact bookmark URL match + container lookup via mapping folder.
- Removed persistent localStorage token/mapping mirrors from active runtime logic.

### Fixed
- Fixed tokens being invalidated on browser restart.
- Fixed cross-device sync behavior where token-only validation could fail without local token storage.
- Fixed mapping rename/recreation handling to preserve first-seen index and remap intelligently.
- Fixed startup migration to transfer legacy localStorage references into bookmark URL + mapping-folder based format.

## 1.0.2

### Added
- Added recursive folder support.

## 1.0.1

### Added
- Added the address-bar bookmark button and new icons.

## 1.0.0

- First release.
