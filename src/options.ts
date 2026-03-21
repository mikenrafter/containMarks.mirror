import { DEFAULT_SETTINGS, hasRiskyTokenBehavior, loadSettings, saveSettings } from './settings'
import type { BookmarkNode, BrowserApi, ContainMarksSettings } from './models'

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

function collectFolderOptions(nodes: BookmarkNode[], parentPath: string): FolderOption[] {
	const options: FolderOption[] = []
	for (const node of nodes) {
		if (node.type !== 'folder') {
			continue
		}

		const title = node.title?.trim() || '(Untitled Folder)'
		const path = parentPath ? `${parentPath} / ${title}` : title
		options.push({ id: node.id, label: path })

		if (Array.isArray(node.children) && node.children.length > 0) {
			options.push(...collectFolderOptions(node.children, path))
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

	return {
		targetFolderId: folderSelect.value || DEFAULT_SETTINGS.targetFolderId,
		resetTokensOnStartup,
		regenerateTokenOnEveryUse,
		acknowledgeRiskyTokenBehavior
	}
}

function writeFormValues(settings: ContainMarksSettings): void {
	getElementById<HTMLSelectElement>('target-folder').value = settings.targetFolderId
	getElementById<HTMLInputElement>('reset-tokens-on-startup').checked = settings.resetTokensOnStartup
	getElementById<HTMLInputElement>('regenerate-token-on-use').checked = settings.regenerateTokenOnEveryUse
	getElementById<HTMLInputElement>('ack-risks').checked = settings.acknowledgeRiskyTokenBehavior
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

	getElementById<HTMLInputElement>('ack-risks').addEventListener('change', () => {
		updateRiskGating()
	})

	getElementById<HTMLFormElement>('options-form').addEventListener('submit', async (event) => {
		event.preventDefault()
		try {
			const formSettings = readFormValues()
			const saved = await saveSettings(browserApi, formSettings)
			writeFormValues(saved)
			updateRiskGating()
			setStatus(hasRiskyTokenBehavior(saved) ? 'Saved with custom token retention settings.' : 'Saved.')
		} catch (error) {
			setStatus(`Failed to save settings: ${String(error)}`, true)
		}
	})
}

void initializeOptionsPage(globalThis.browser)
