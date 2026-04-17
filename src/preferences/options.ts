import { DEFAULT_SETTINGS, hasRiskyTokenBehavior, loadSettings, saveSettings } from './settings'
import {
	SYNC_FOLDER_PARENT_ID,
	SYNC_FOLDER_TITLE
} from '../mappings/containerMappings'
import {
	readSyncedMappings,
	readLocalMappings,
	writeLocalMappings,
	overwriteSyncedMappings,
	scanOrphanedBookmarks,
	resetOrphanedBookmarks
} from '../mappings/mappingMigration'
import type { BookmarkNode, BrowserApi, ContainMarksSettings } from '../models'

const RISK_LINK = 'https://gitlab.com/mikenrafter/containmarks#security'

declare global {
	var browser: BrowserApi
	interface Window {
		browser: BrowserApi
	}
}

interface FolderOption {
	id: string
	label: string
}

function isSyncFolderAtOfficialPath(node: BookmarkNode): boolean {
	return node.parentId === SYNC_FOLDER_PARENT_ID && node.title?.trim() === SYNC_FOLDER_TITLE
}

function collectFolderOptions(nodes: BookmarkNode[], parentPath: string): FolderOption[] {
	const options: FolderOption[] = []
	for (const node of nodes) {
		if (node.type !== 'folder') {
			continue
		}

		if (isSyncFolderAtOfficialPath(node)) {
			continue
		}

		const titleValue = node.title?.trim() ?? ''
		const isGlobalRoot = parentPath === '' && titleValue.length === 0
		const title = isGlobalRoot ? '/' : titleValue || '(Untitled Folder)'
		const path = parentPath ? `${parentPath} / ${title}` : title
		options.push({ id: node.id, label: path })

		if (Array.isArray(node.children) && node.children.length > 0) {
			const childParentPath = isGlobalRoot ? '' : path
			options.push(...collectFolderOptions(node.children, childParentPath))
		}
	}
	return options
}

async function getFolderOptions(browserApi: BrowserApi): Promise<FolderOption[]> {
	const root = await browserApi.bookmarks.getTree()
	const options = collectFolderOptions(root, '')
	return options.sort((left, right) => left.label.localeCompare(right.label))
}


function getElementById<TElement extends HTMLElement>(id: string): TElement {
	const element = document.getElementById(id)
	if (!element) {
		throw new Error(`Missing required element: ${id}`)
	}
	return element as TElement
}

function readFormValues(): ContainMarksSettings {
	const folderSelect = getElementById<HTMLSelectElement>('target-folder')
	const resetTokensOnStartup = getElementById<HTMLInputElement>('reset-tokens-on-startup').checked
	const regenerateTokenOnEveryUse = getElementById<HTMLInputElement>('regenerate-token-on-use').checked
	const acknowledgeRiskyTokenBehavior = getElementById<HTMLInputElement>('ack-risks').checked
	const showPageActionButton = getElementById<HTMLInputElement>('show-page-action-button').checked
	const enableBookmarkSync = getElementById<HTMLInputElement>('enable-bookmark-sync').checked

	return {
		targetFolderId: folderSelect.value || DEFAULT_SETTINGS.targetFolderId,
		resetTokensOnStartup,
		regenerateTokenOnEveryUse,
		acknowledgeRiskyTokenBehavior,
		showPageActionButton,
		enableBookmarkSync,
		allowEncodedBookmarkImport: DEFAULT_SETTINGS.allowEncodedBookmarkImport
	}
}

function writeFormValues(settings: ContainMarksSettings): void {
	getElementById<HTMLSelectElement>('target-folder').value = settings.targetFolderId
	getElementById<HTMLInputElement>('reset-tokens-on-startup').checked = settings.resetTokensOnStartup
	getElementById<HTMLInputElement>('regenerate-token-on-use').checked = settings.regenerateTokenOnEveryUse
	getElementById<HTMLInputElement>('ack-risks').checked = settings.acknowledgeRiskyTokenBehavior
	getElementById<HTMLInputElement>('show-page-action-button').checked = settings.showPageActionButton
	getElementById<HTMLInputElement>('enable-bookmark-sync').checked = settings.enableBookmarkSync
}

function setStatus(message: string, isError = false): void {
	const status = getElementById<HTMLParagraphElement>('save-status')
	status.textContent = message
	status.style.color = isError ? '#a31515' : '#0a5f2d'
}

function updateRiskGating(): void {
	const ackRisks = getElementById<HTMLInputElement>('ack-risks').checked
	const resetInput = getElementById<HTMLInputElement>('reset-tokens-on-startup')
	const regenInput = getElementById<HTMLInputElement>('regenerate-token-on-use')
	if (ackRisks) {
		resetInput.disabled = false
		regenInput.disabled = false
		return
	}

	resetInput.checked = DEFAULT_SETTINGS.resetTokensOnStartup
	regenInput.checked = DEFAULT_SETTINGS.regenerateTokenOnEveryUse
	resetInput.disabled = true
	regenInput.disabled = true
}

/**
 * Migration result from the sync-toggle dialog. Each outcome maps to a distinct user action:
 * - `cancelled`: User dismissed dialog — revert checkbox to previous state, no save.
 * - `stripped`: User chose to strip orphaned bookmarks and proceed with the toggle.
 * - `overwritten`: User chose to overwrite target mappings and proceed with the toggle.
 */
type MigrationOutcome = 'cancelled' | 'reset' | 'overwritten'

/**
 * Shows the migration dialog when the user toggles `enableBookmarkSync`.
 *
 * Scans for orphaned bookmarks (encoded with indices that don't resolve in the target store),
 * presents a preview of source mappings, and offers three choices:
 * - Cancel and revert the toggle
 * - Strip encoding from orphaned bookmarks, then proceed
 * - Overwrite target store with source mappings, then proceed
 *
 * Returns the chosen outcome so the caller can decide whether to save settings.
 */
async function showMigrationDialog(browserApi: BrowserApi, switchingToSync: boolean): Promise<MigrationOutcome> {
	const sourceLabel = switchingToSync ? 'local' : 'synced'
	const targetLabel = switchingToSync ? 'synced' : 'local'
	const capitalSourceLabel = switchingToSync ? 'Local' : 'Synced'

	const sourceRecords = switchingToSync
		? await readLocalMappings(browserApi)
		: await readSyncedMappings(browserApi)

	const targetRecords = switchingToSync
		? await readSyncedMappings(browserApi)
		: await readLocalMappings(browserApi)

	const orphans = await scanOrphanedBookmarks(browserApi, targetRecords)

	// Populate dialog
	const mappingNoun = sourceRecords.length === 1 ? 'mapping' : 'mappings'
	getElementById<HTMLElement>('migrate-description').textContent =
		`Switching from ${sourceLabel} to ${targetLabel} storage.`

	const orphanWarning = getElementById<HTMLElement>('migrate-orphan-warning')
	const resetButton = getElementById<HTMLButtonElement>('migrate-reset')

	if (orphans.length > 0) {
		orphanWarning.style.display = ''
		getElementById<HTMLElement>('migrate-orphan-count').textContent = String(orphans.length)
		resetButton.style.display = ''
		resetButton.textContent = `Reset ${orphans.length} bookmark(s)`
	} else {
		orphanWarning.style.display = 'none'
		resetButton.style.display = 'none'
	}

	const previewList = getElementById<HTMLUListElement>('migrate-records-preview')
	previewList.innerHTML = ''
	if (sourceRecords.length === 0) {
		getElementById<HTMLElement>('migrate-records-heading').textContent = `${capitalSourceLabel} has no mappings to transfer.`
	} else {
		getElementById<HTMLElement>('migrate-records-heading').textContent = `${capitalSourceLabel} has ${sourceRecords.length} ${mappingNoun}:`
		for (const record of sourceRecords) {
			const listItem = document.createElement('li')
			listItem.textContent = `#${record.firstSeenIndex}: ${record.backupName} (${record.cookieStoreId})`
			previewList.appendChild(listItem)
		}
	}

	const dialog = getElementById<HTMLDialogElement>('migrate-mappings-dialog')
	getElementById<HTMLButtonElement>('migrate-overwrite').textContent = `Overwrite ${targetLabel} mappings`

	return new Promise<MigrationOutcome>((resolve) => {
		function cleanup() {
			getElementById('migrate-cancel').removeEventListener('click', onCancel)
			getElementById('migrate-reset').removeEventListener('click', onStrip)
			getElementById('migrate-overwrite').removeEventListener('click', onOverwrite)
			dialog.close()
		}

		function onCancel() { cleanup(); resolve('cancelled') }

		async function onStrip() {
			cleanup()
			await resetOrphanedBookmarks(browserApi, orphans)
			resolve('reset')
		}

		async function onOverwrite() {
			cleanup()
			if (switchingToSync) {
				await overwriteSyncedMappings(browserApi, sourceRecords)
			} else {
				await writeLocalMappings(browserApi, sourceRecords)
			}
			resolve('overwritten')
		}

		getElementById('migrate-cancel').addEventListener('click', onCancel)
		getElementById('migrate-reset').addEventListener('click', onStrip)
		getElementById('migrate-overwrite').addEventListener('click', onOverwrite)
		dialog.showModal()
	})
}

async function initializeOptionsPage(browserApi: BrowserApi): Promise<void> {
	const riskLink = getElementById<HTMLAnchorElement>('risk-link')
	riskLink.href = RISK_LINK

	const folderSelect = getElementById<HTMLSelectElement>('target-folder')
	const options = await getFolderOptions(browserApi)
	for (const option of options) {
		const element = document.createElement('option')
		element.value = option.id
		element.textContent = option.label
		folderSelect.appendChild(element)
	}

	const settings = await loadSettings(browserApi)
	const selectedExists = options.some((option) => option.id === settings.targetFolderId)
	writeFormValues({
		...settings,
		targetFolderId: selectedExists ? settings.targetFolderId : DEFAULT_SETTINGS.targetFolderId
	})
	updateRiskGating()

	/** Tracks the last-saved value of `enableBookmarkSync` so the dialog can revert on cancel. */
	let savedSyncEnabled = settings.enableBookmarkSync

	getElementById<HTMLFormElement>('options-form').addEventListener('change', () => {
		updateRiskGating()
	})

	/**
	 * Auto-trigger migration dialog when the sync checkbox changes.
	 * On cancel, reverts the checkbox to its previous saved state without saving.
	 */
	getElementById<HTMLInputElement>('enable-bookmark-sync').addEventListener('change', async (event) => {
		const checkbox = event.target as HTMLInputElement
		const switchingToSync = checkbox.checked

		try {
			const outcome = await showMigrationDialog(browserApi, switchingToSync)

			if (outcome === 'cancelled') {
				checkbox.checked = savedSyncEnabled
				setStatus('Migration cancelled.')
				return
			}

			// Save the settings with the new sync toggle value
			const formValues = readFormValues()
			const saved = await saveSettings(browserApi, formValues)
			writeFormValues(saved)
			updateRiskGating()
			savedSyncEnabled = saved.enableBookmarkSync

			if (outcome === 'reset') {
				setStatus('Switched storage mode and reset orphaned bookmarks.')
			} else {
				setStatus('Switched storage mode and overwrote target mappings.')
			}
		} catch (error) {
			checkbox.checked = savedSyncEnabled
			setStatus(`Migration failed: ${String(error)}`, true)
		}
	})

	getElementById<HTMLFormElement>('options-form').addEventListener('submit', async (event) => {
		event.preventDefault()
		try {
			const saved = await saveSettings(browserApi, readFormValues())
			writeFormValues(saved)
			updateRiskGating()
			savedSyncEnabled = saved.enableBookmarkSync
			setStatus(hasRiskyTokenBehavior(saved) ? 'Saved with custom token retention settings.' : 'Saved.')
		} catch (error) {
			setStatus(`Failed to save settings: ${String(error)}`, true)
		}
	})
}

if (typeof document !== 'undefined') {
	void initializeOptionsPage(globalThis.browser)
}
