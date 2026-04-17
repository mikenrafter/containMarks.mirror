"use strict";
(() => {
  // src/preferences/settings.ts
  var SETTINGS_STORAGE_KEY = "containMarks.settings";
  var DEFAULT_TARGET_FOLDER_ID = "toolbar_____";
  var DEFAULT_SETTINGS = {
    targetFolderId: DEFAULT_TARGET_FOLDER_ID,
    resetTokensOnStartup: false,
    regenerateTokenOnEveryUse: true,
    acknowledgeRiskyTokenBehavior: false,
    showPageActionButton: true,
    enableBookmarkSync: true,
    allowEncodedBookmarkImport: false
  };
  function sanitizeSettings(value) {
    if (value === null || typeof value !== "object") {
      return { ...DEFAULT_SETTINGS };
    }
    const candidate = value;
    const targetFolderId = typeof candidate.targetFolderId === "string" && candidate.targetFolderId.length > 0 ? candidate.targetFolderId : DEFAULT_SETTINGS.targetFolderId;
    return {
      targetFolderId,
      resetTokensOnStartup: candidate.resetTokensOnStartup ?? DEFAULT_SETTINGS.resetTokensOnStartup,
      regenerateTokenOnEveryUse: candidate.regenerateTokenOnEveryUse ?? DEFAULT_SETTINGS.regenerateTokenOnEveryUse,
      acknowledgeRiskyTokenBehavior: candidate.acknowledgeRiskyTokenBehavior ?? DEFAULT_SETTINGS.acknowledgeRiskyTokenBehavior,
      showPageActionButton: candidate.showPageActionButton ?? DEFAULT_SETTINGS.showPageActionButton,
      enableBookmarkSync: candidate.enableBookmarkSync ?? DEFAULT_SETTINGS.enableBookmarkSync,
      allowEncodedBookmarkImport: candidate.allowEncodedBookmarkImport ?? DEFAULT_SETTINGS.allowEncodedBookmarkImport
    };
  }
  function hasRiskyTokenBehavior(settings) {
    return settings.resetTokensOnStartup || settings.regenerateTokenOnEveryUse === false;
  }
  function validateSettings(settings) {
    if (hasRiskyTokenBehavior(settings) && !settings.acknowledgeRiskyTokenBehavior) {
      return {
        ...settings,
        resetTokensOnStartup: DEFAULT_SETTINGS.resetTokensOnStartup,
        regenerateTokenOnEveryUse: DEFAULT_SETTINGS.regenerateTokenOnEveryUse,
        allowEncodedBookmarkImport: false
      };
    }
    if (settings.allowEncodedBookmarkImport && !settings.acknowledgeRiskyTokenBehavior) {
      return {
        ...settings,
        allowEncodedBookmarkImport: false
      };
    }
    return settings;
  }
  async function loadSettings(browserApi) {
    const payload = await browserApi.storage.local.get(SETTINGS_STORAGE_KEY);
    return sanitizeSettings(payload[SETTINGS_STORAGE_KEY]);
  }
  async function saveSettings(browserApi, settings) {
    const sanitized = validateSettings(sanitizeSettings(settings));
    await browserApi.storage.local.set({ [SETTINGS_STORAGE_KEY]: sanitized });
    return sanitized;
  }

  // src/urlCodec.ts
  var PREFIX = "about";
  var DELIMITER = ":";
  var TOKEN_SEGMENT_MIN_LENGTH = 6;
  var FRAGMENT_PREFIX = "cm";
  var v120Codec = {
    version: "v1.2.0",
    detect(url) {
      const hashIndex = url.indexOf("#");
      if (hashIndex < 0) return false;
      return url.slice(hashIndex + 1).startsWith(FRAGMENT_PREFIX + DELIMITER);
    },
    parse(url) {
      const hashIndex = url.indexOf("#");
      if (hashIndex < 0) return null;
      const fragment = url.slice(hashIndex + 1);
      const cmPrefix = FRAGMENT_PREFIX + DELIMITER;
      if (!fragment.startsWith(cmPrefix)) return null;
      const afterPrefix = fragment.slice(cmPrefix.length);
      const secondHashIndex = afterPrefix.indexOf("#");
      const encodingPart = secondHashIndex >= 0 ? afterPrefix.slice(0, secondHashIndex) : afterPrefix;
      const originalFragment = secondHashIndex >= 0 ? afterPrefix.slice(secondHashIndex + 1) : "";
      const parts = encodingPart.split(DELIMITER);
      if (parts.length !== 2) return null;
      const token = parts[0] ?? "";
      if (token.length < TOKEN_SEGMENT_MIN_LENGTH) return null;
      const index = Number(parts[1]);
      if (!Number.isInteger(index) || index < 0) return null;
      const baseUrl = url.slice(0, hashIndex);
      const realUrl = originalFragment ? `${baseUrl}#${originalFragment}` : baseUrl;
      return { url: realUrl, token, containerIndex: index };
    }
  };
  function parseBookmarkUrl(source) {
    const url = typeof source === "string" ? source : source.url;
    if (typeof url !== "string") return null;
    if (typeof source !== "string" && source.type !== "bookmark") return null;
    const parsed = v120Codec.parse(url);
    if (parsed !== null && (parsed.token.length > 0 || parsed.containerIndex !== null)) {
      return parsed;
    }
    return { url, token: "", containerIndex: null };
  }
  function decodeToRealUrl(url) {
    const parsed = v120Codec.parse(url);
    return parsed ? parsed.url : url;
  }

  // src/mappings/containerMappings.ts
  var SYNC_FOLDER_PARENT_ID = "menu________";
  var SYNC_FOLDER_TITLE = "ContainMarks Sync";
  var MAPPING_TITLE_PREFIX = "Mapping: ";
  var LOCAL_MAPPING_STORAGE_KEY = "containMarks.localMappings";
  function parseMappingRecord(value) {
    if (value === null || typeof value !== "object") {
      return null;
    }
    const candidate = value;
    if (!Number.isInteger(candidate.firstSeenIndex) || candidate.firstSeenIndex < 0 || typeof candidate.cookieStoreId !== "string" || candidate.cookieStoreId.length === 0 || typeof candidate.backupName !== "string") {
      return null;
    }
    return {
      firstSeenIndex: candidate.firstSeenIndex,
      cookieStoreId: candidate.cookieStoreId,
      backupName: candidate.backupName
    };
  }
  function parseContainerMappingUrl(url) {
    const [prefix, firstSeenIndex, cookieStoreId = "", ...backupNameSegments] = url.split(DELIMITER);
    const idNumber = Number(firstSeenIndex);
    const backupName = backupNameSegments.join(DELIMITER);
    if (prefix !== PREFIX || !Number.isInteger(idNumber) || idNumber < 0 || !(cookieStoreId || backupName)) {
      return null;
    }
    return {
      firstSeenIndex: idNumber,
      cookieStoreId,
      backupName: backupName ?? ""
    };
  }
  function buildContainerMappingUrl(record) {
    return [PREFIX, String(record.firstSeenIndex), record.cookieStoreId, record.backupName].join(DELIMITER);
  }
  function parseContainerMappingBookmark(bookmark) {
    if (bookmark.type !== "bookmark" || typeof bookmark.url !== "string") {
      return null;
    }
    return parseContainerMappingUrl(bookmark.url);
  }
  function buildMappingTitle(containerName) {
    return `${MAPPING_TITLE_PREFIX}${containerName}`;
  }

  // src/mappings/mappingMigration.ts
  function normalizeMappingRecords(records) {
    const byIndex = /* @__PURE__ */ new Map();
    for (const record of records) {
      byIndex.set(record.firstSeenIndex, record);
    }
    return [...byIndex.values()].sort((left, right) => left.firstSeenIndex - right.firstSeenIndex);
  }
  function isSyncFolderAtOfficialPath(node) {
    return node.parentId === SYNC_FOLDER_PARENT_ID && node.title?.trim() === SYNC_FOLDER_TITLE;
  }
  async function listSyncFolders(browserApi) {
    const folders = await browserApi.bookmarks.search({ title: SYNC_FOLDER_TITLE });
    return folders.filter((node) => node.type === "folder" && isSyncFolderAtOfficialPath(node));
  }
  async function readSyncedMappings(browserApi) {
    const folders = await listSyncFolders(browserApi);
    const records = [];
    for (const folder of folders) {
      const children = await browserApi.bookmarks.getChildren(folder.id);
      for (const child of children) {
        const parsed = parseContainerMappingBookmark(child);
        if (parsed) {
          records.push(parsed);
        }
      }
    }
    return normalizeMappingRecords(records);
  }
  async function readLocalMappings(browserApi) {
    const payload = await browserApi.storage.local.get(LOCAL_MAPPING_STORAGE_KEY);
    const rawValue = payload[LOCAL_MAPPING_STORAGE_KEY];
    if (!Array.isArray(rawValue)) {
      return [];
    }
    const records = rawValue.map(parseMappingRecord).filter((record) => record !== null);
    return normalizeMappingRecords(records);
  }
  async function writeLocalMappings(browserApi, records) {
    await browserApi.storage.local.set({ [LOCAL_MAPPING_STORAGE_KEY]: normalizeMappingRecords(records) });
  }
  async function scanOrphanedBookmarks(browserApi, targetRecords) {
    const resolvedIndices = new Set(targetRecords.map((r) => r.firstSeenIndex));
    const encoded = await browserApi.bookmarks.search({ query: `#${FRAGMENT_PREFIX}${DELIMITER}` });
    const orphans = [];
    for (const bookmark of encoded) {
      const parsed = parseBookmarkUrl(bookmark);
      if (!parsed || parsed.containerIndex === null) continue;
      if (!resolvedIndices.has(parsed.containerIndex)) {
        orphans.push(bookmark);
      }
    }
    return orphans;
  }
  async function resetOrphanedBookmarks(browserApi, orphans) {
    let resetCount = 0;
    for (const bookmark of orphans) {
      if (!bookmark.url) continue;
      const plainUrl = decodeToRealUrl(bookmark.url);
      if (plainUrl !== bookmark.url) {
        await browserApi.bookmarks.update(bookmark.id, { url: plainUrl });
        resetCount += 1;
      }
    }
    return resetCount;
  }
  async function overwriteSyncedMappings(browserApi, records) {
    const syncFolders = await listSyncFolders(browserApi);
    for (const folder of syncFolders) {
      const children = await browserApi.bookmarks.getChildren(folder.id);
      for (const child of children) {
        if (parseContainerMappingBookmark(child)) {
          await browserApi.bookmarks.remove(child.id);
        }
      }
    }
    let targetFolder = syncFolders[0];
    if (!targetFolder) {
      targetFolder = await browserApi.bookmarks.create({
        parentId: SYNC_FOLDER_PARENT_ID,
        type: "folder",
        title: SYNC_FOLDER_TITLE
      });
    }
    for (const record of normalizeMappingRecords(records)) {
      await browserApi.bookmarks.create({
        parentId: targetFolder.id,
        title: buildMappingTitle(record.backupName),
        url: buildContainerMappingUrl(record)
      });
    }
  }

  // src/preferences/options.ts
  var RISK_LINK = "https://gitlab.com/mikenrafter/containmarks#security";
  function isSyncFolderAtOfficialPath2(node) {
    return node.parentId === SYNC_FOLDER_PARENT_ID && node.title?.trim() === SYNC_FOLDER_TITLE;
  }
  function collectFolderOptions(nodes, parentPath) {
    const options = [];
    for (const node of nodes) {
      if (node.type !== "folder") {
        continue;
      }
      if (isSyncFolderAtOfficialPath2(node)) {
        continue;
      }
      const titleValue = node.title?.trim() ?? "";
      const isGlobalRoot = parentPath === "" && titleValue.length === 0;
      const title = isGlobalRoot ? "/" : titleValue || "(Untitled Folder)";
      const path = parentPath ? `${parentPath} / ${title}` : title;
      options.push({ id: node.id, label: path });
      if (Array.isArray(node.children) && node.children.length > 0) {
        const childParentPath = isGlobalRoot ? "" : path;
        options.push(...collectFolderOptions(node.children, childParentPath));
      }
    }
    return options;
  }
  async function getFolderOptions(browserApi) {
    const root = await browserApi.bookmarks.getTree();
    const options = collectFolderOptions(root, "");
    return options.sort((left, right) => left.label.localeCompare(right.label));
  }
  function getElementById(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }
  function readFormValues() {
    const folderSelect = getElementById("target-folder");
    const resetTokensOnStartup = getElementById("reset-tokens-on-startup").checked;
    const regenerateTokenOnEveryUse = getElementById("regenerate-token-on-use").checked;
    const acknowledgeRiskyTokenBehavior = getElementById("ack-risks").checked;
    const showPageActionButton = getElementById("show-page-action-button").checked;
    const enableBookmarkSync = getElementById("enable-bookmark-sync").checked;
    return {
      targetFolderId: folderSelect.value || DEFAULT_SETTINGS.targetFolderId,
      resetTokensOnStartup,
      regenerateTokenOnEveryUse,
      acknowledgeRiskyTokenBehavior,
      showPageActionButton,
      enableBookmarkSync,
      allowEncodedBookmarkImport: DEFAULT_SETTINGS.allowEncodedBookmarkImport
    };
  }
  function writeFormValues(settings) {
    getElementById("target-folder").value = settings.targetFolderId;
    getElementById("reset-tokens-on-startup").checked = settings.resetTokensOnStartup;
    getElementById("regenerate-token-on-use").checked = settings.regenerateTokenOnEveryUse;
    getElementById("ack-risks").checked = settings.acknowledgeRiskyTokenBehavior;
    getElementById("show-page-action-button").checked = settings.showPageActionButton;
    getElementById("enable-bookmark-sync").checked = settings.enableBookmarkSync;
  }
  function setStatus(message, isError = false) {
    const status = getElementById("save-status");
    status.textContent = message;
    status.style.color = isError ? "#a31515" : "#0a5f2d";
  }
  function updateSaveButtonDirtyState(lastSaved) {
    const current = readFormValues();
    const button = getElementById("options-form-submit");
    const isDirty = current.targetFolderId !== lastSaved.targetFolderId || current.resetTokensOnStartup !== lastSaved.resetTokensOnStartup || current.regenerateTokenOnEveryUse !== lastSaved.regenerateTokenOnEveryUse || current.acknowledgeRiskyTokenBehavior !== lastSaved.acknowledgeRiskyTokenBehavior || current.showPageActionButton !== lastSaved.showPageActionButton;
    button.disabled = !isDirty;
    button.textContent = isDirty ? "Save Settings *" : "Save Settings";
  }
  function updateRiskGating() {
    const ackRisks = getElementById("ack-risks").checked;
    const resetInput = getElementById("reset-tokens-on-startup");
    const regenInput = getElementById("regenerate-token-on-use");
    if (ackRisks) {
      resetInput.disabled = false;
      regenInput.disabled = false;
      return;
    }
    resetInput.checked = DEFAULT_SETTINGS.resetTokensOnStartup;
    regenInput.checked = DEFAULT_SETTINGS.regenerateTokenOnEveryUse;
    resetInput.disabled = true;
    regenInput.disabled = true;
  }
  async function showMigrationDialog(browserApi, switchingToSync) {
    const sourceLabel = switchingToSync ? "local" : "synced";
    const targetLabel = switchingToSync ? "synced" : "local";
    const capitalSourceLabel = switchingToSync ? "Local" : "Synced";
    const sourceRecords = switchingToSync ? await readLocalMappings(browserApi) : await readSyncedMappings(browserApi);
    const targetRecords = switchingToSync ? await readSyncedMappings(browserApi) : await readLocalMappings(browserApi);
    const orphans = await scanOrphanedBookmarks(browserApi, targetRecords);
    const mappingNoun = sourceRecords.length === 1 ? "mapping" : "mappings";
    getElementById("migrate-description").textContent = `Switching from ${sourceLabel} to ${targetLabel} storage.`;
    const orphanWarning = getElementById("migrate-orphan-warning");
    const resetButton = getElementById("migrate-reset");
    if (orphans.length > 0) {
      orphanWarning.style.display = "";
      getElementById("migrate-orphan-count").textContent = String(orphans.length);
      resetButton.style.display = "";
      resetButton.textContent = `Reset ${orphans.length} bookmark(s)`;
    } else {
      orphanWarning.style.display = "none";
      resetButton.style.display = "none";
    }
    const previewList = getElementById("migrate-records-preview");
    previewList.innerHTML = "";
    if (sourceRecords.length === 0) {
      getElementById("migrate-records-heading").textContent = `${capitalSourceLabel} has no mappings to transfer.`;
    } else {
      getElementById("migrate-records-heading").textContent = `${capitalSourceLabel} has ${sourceRecords.length} ${mappingNoun}:`;
      for (const record of sourceRecords) {
        const listItem = document.createElement("li");
        listItem.textContent = `#${record.firstSeenIndex}: ${record.backupName} (${record.cookieStoreId})`;
        previewList.appendChild(listItem);
      }
    }
    const dialog = getElementById("migrate-mappings-dialog");
    getElementById("migrate-overwrite").textContent = `Overwrite ${targetLabel} mappings`;
    return new Promise((resolve) => {
      function cleanup() {
        getElementById("migrate-cancel").removeEventListener("click", onCancel);
        getElementById("migrate-reset").removeEventListener("click", onStrip);
        getElementById("migrate-overwrite").removeEventListener("click", onOverwrite);
        dialog.close();
      }
      function onCancel() {
        cleanup();
        resolve("cancelled");
      }
      async function onStrip() {
        cleanup();
        await resetOrphanedBookmarks(browserApi, orphans);
        resolve("reset");
      }
      async function onOverwrite() {
        cleanup();
        if (switchingToSync) {
          await overwriteSyncedMappings(browserApi, sourceRecords);
        } else {
          await writeLocalMappings(browserApi, sourceRecords);
        }
        resolve("overwritten");
      }
      getElementById("migrate-cancel").addEventListener("click", onCancel);
      getElementById("migrate-reset").addEventListener("click", onStrip);
      getElementById("migrate-overwrite").addEventListener("click", onOverwrite);
      dialog.showModal();
    });
  }
  async function initializeOptionsPage(browserApi) {
    const riskLink = getElementById("risk-link");
    riskLink.href = RISK_LINK;
    const folderSelect = getElementById("target-folder");
    const options = await getFolderOptions(browserApi);
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.label;
      folderSelect.appendChild(element);
    }
    const settings = await loadSettings(browserApi);
    const selectedExists = options.some((option) => option.id === settings.targetFolderId);
    writeFormValues({
      ...settings,
      targetFolderId: selectedExists ? settings.targetFolderId : DEFAULT_SETTINGS.targetFolderId
    });
    updateRiskGating();
    let savedSyncEnabled = settings.enableBookmarkSync;
    let lastSavedSettings = { ...settings };
    getElementById("options-form").addEventListener("change", () => {
      updateRiskGating();
      updateSaveButtonDirtyState(lastSavedSettings);
    });
    getElementById("enable-bookmark-sync").addEventListener("change", async (event) => {
      const checkbox = event.target;
      const switchingToSync = checkbox.checked;
      try {
        const outcome = await showMigrationDialog(browserApi, switchingToSync);
        if (outcome === "cancelled") {
          checkbox.checked = savedSyncEnabled;
          setStatus("Migration cancelled.");
          updateSaveButtonDirtyState(lastSavedSettings);
          return;
        }
        const formValues = readFormValues();
        const saved = await saveSettings(browserApi, formValues);
        writeFormValues(saved);
        updateRiskGating();
        savedSyncEnabled = saved.enableBookmarkSync;
        lastSavedSettings = { ...saved };
        updateSaveButtonDirtyState(lastSavedSettings);
        if (outcome === "reset") {
          setStatus("Switched storage mode and reset orphaned bookmarks.");
        } else {
          setStatus("Switched storage mode and overwrote target mappings.");
        }
      } catch (error) {
        checkbox.checked = savedSyncEnabled;
        setStatus(`Migration failed: ${String(error)}`, true);
      }
    });
    getElementById("options-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const saved = await saveSettings(browserApi, readFormValues());
        writeFormValues(saved);
        updateRiskGating();
        savedSyncEnabled = saved.enableBookmarkSync;
        lastSavedSettings = { ...saved };
        updateSaveButtonDirtyState(lastSavedSettings);
        setStatus(hasRiskyTokenBehavior(saved) ? "Saved with custom token retention settings." : "Saved.");
      } catch (error) {
        setStatus(`Failed to save settings: ${String(error)}`, true);
      }
    });
  }
  if (typeof document !== "undefined") {
    void initializeOptionsPage(globalThis.browser);
  }
})();
