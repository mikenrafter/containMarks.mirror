import { DEFAULT_SETTINGS, hasRiskyTokenBehavior, loadSettings, saveSettings } from './settings'
import {
	LOCAL_MAPPING_STORAGE_KEY,
	SYNC_FOLDER_PARENT_ID,
	SYNC_FOLDER_TITLE,
	buildContainerMappingUrl,
	buildMappingTitle,
	parseContainerMappingBookmark,
	parseMappingRecord
} from './containerMappings'
import type { BookmarkNode, BrowserApi, ContainerMappingRecord, ContainMarksSettings } from './models'

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

function normalizeMappingRecords(records: ContainerMappingRecord[]): ContainerMappingRecord[] {
	const byIndex = new Map<number, ContainerMappingRecord>()
	for (const record of records) {
		byIndex.set(record.firstSeenIndex, record)
	}

	return [...byIndex.values()].sort((left, right) => left.firstSeenIndex - right.firstSeenIndex)
}

async function listSyncFolders(browserApi: BrowserApi): Promise<BookmarkNode[]> {
	const folders = await browserApi.bookmarks.search({ title: SYNC_FOLDER_TITLE })
	return folders.filter((node) => node.type === 'folder' && isSyncFolderAtOfficialPath(node))
}

async function readSyncedMappings(browserApi: BrowserApi): Promise<ContainerMappingRecord[]> {
	const folders = await listSyncFolders(browserApi)
	const records: ContainerMappingRecord[] = []

	for (const folder of folders) {
		const children = await browserApi.bookmarks.getChildren(folder.id)
		for (const child of children) {
			const parsed = parseContainerMappingBookmark(child)
			if (parsed) {
				records.push(parsed)
			}
		}
	}

	return normalizeMappingRecords(records)
}

async function readLocalMappings(browserApi: BrowserApi): Promise<ContainerMappingRecord[]> {
	const payload = await browserApi.storage.local.get(LOCAL_MAPPING_STORAGE_KEY)
	const rawValue = payload[LOCAL_MAPPING_STORAGE_KEY]
	if (!Array.isArray(rawValue)) {
		return []
	}

	const records = rawValue.map(parseMappingRecord).filter((record): record is ContainerMappingRecord => record !== null)
	return normalizeMappingRecords(records)
}

async function writeLocalMappings(browserApi: BrowserApi, records: ContainerMappingRecord[]): Promise<void> {
	await browserApi.storage.local.set({ [LOCAL_MAPPING_STORAGE_KEY]: normalizeMappingRecords(records) })
}

async function overwriteSyncedMappings(browserApi: BrowserApi, records: ContainerMappingRecord[]): Promise<void> {
	const syncFolders = await listSyncFolders(browserApi)

	for (const folder of syncFolders) {
		const children = await browserApi.bookmarks.getChildren(folder.id)
		for (const child of children) {
			if (parseContainerMappingBookmark(child)) {
				await browserApi.bookmarks.remove(child.id)
			}
		}
	}

	let targetFolder = syncFolders[0]
	if (!targetFolder) {
		targetFolder = await browserApi.bookmarks.create({
			parentId: SYNC_FOLDER_PARENT_ID,
			type: 'folder',
			title: SYNC_FOLDER_TITLE
		})
	}

	for (const record of normalizeMappingRecords(records)) {
		await browserApi.bookmarks.create({
			parentId: targetFolder.id,
			title: buildMappingTitle(record.backupName),
			url: buildContainerMappingUrl(record)
		})
	}
}

function updateMappingTransferUi(formDirty: boolean): void {
	const syncEnabled = getElementById<HTMLInputElement>('enable-bookmark-sync').checked
	const sourceLabel = syncEnabled ? 'local' : 'synced'
	const targetLabel = syncEnabled ? 'synced' : 'local'
	const transferButton = getElementById<HTMLButtonElement>('translate-mappings-button')

	transferButton.textContent = `Overwrite ${targetLabel} mappings with ${sourceLabel} mappings`
	getElementById<HTMLElement>('translate-target-label').textContent = targetLabel
	getElementById<HTMLElement>('translate-source-label').textContent = sourceLabel

	transferButton.disabled = formDirty
	transferButton.title = formDirty ? 'Save settings first to enable this action.' : ''
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
		enableBookmarkSync
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

	let formDirty = false
	updateMappingTransferUi(formDirty)

	getElementById<HTMLFormElement>('options-form').addEventListener('change', () => {
		formDirty = true
		updateRiskGating()
		updateMappingTransferUi(formDirty)
	})

	getElementById<HTMLButtonElement>('translate-mappings-button').addEventListener('click', async () => {
		try {
			const syncEnabled = getElementById<HTMLInputElement>('enable-bookmark-sync').checked
			const sourceRecords = syncEnabled
				? await readLocalMappings(browserApi)
				: await readSyncedMappings(browserApi)

			const previewList = getElementById<HTMLUListElement>('confirm-transfer-preview')
			previewList.innerHTML = ''
			if (sourceRecords.length === 0) {
				const li = document.createElement('li')
				li.textContent = '(no records to transfer)'
				previewList.appendChild(li)
			} else {
				for (const record of sourceRecords) {
					const li = document.createElement('li')
					li.textContent = `${record.firstSeenIndex}: ${record.backupName}`
					previewList.appendChild(li)
				}
			}

			const dialog = getElementById<HTMLDialogElement>('confirm-transfer-dialog')
			const confirmed = await new Promise<boolean>((resolve) => {
				const onCancel = () => { cleanup(); resolve(false) }
				const onOk = () => { cleanup(); resolve(true) }
				const cleanup = () => {
					getElementById('confirm-transfer-cancel').removeEventListener('click', onCancel)
					getElementById('confirm-transfer-ok').removeEventListener('click', onOk)
					dialog.close()
				}
				getElementById('confirm-transfer-cancel').addEventListener('click', onCancel)
				getElementById('confirm-transfer-ok').addEventListener('click', onOk)
				dialog.showModal()
			})

			if (!confirmed) return

			if (syncEnabled) {
				await overwriteSyncedMappings(browserApi, sourceRecords)
				setStatus(`Overwrote synced mappings with ${sourceRecords.length} local record(s).`)
			} else {
				await writeLocalMappings(browserApi, sourceRecords)
				setStatus(`Overwrote local mappings with ${sourceRecords.length} synced record(s).`)
			}
		} catch (error) {
			setStatus(`Failed to translate mappings: ${String(error)}`, true)
		}
	})

	getElementById<HTMLFormElement>('options-form').addEventListener('submit', async (event) => {
		event.preventDefault()
		try {
			const saved = await saveSettings(browserApi, readFormValues())
			writeFormValues(saved)
			updateRiskGating()
			formDirty = false
			updateMappingTransferUi(formDirty)
			setStatus(hasRiskyTokenBehavior(saved) ? 'Saved with custom token retention settings.' : 'Saved.')
		} catch (error) {
			setStatus(`Failed to save settings: ${String(error)}`, true)
		}
	})
}

void initializeOptionsPage(globalThis.browser)
