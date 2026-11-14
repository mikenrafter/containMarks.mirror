import { TEMP_CONTAINERS_EXTENSION_IDS } from '../constants'
import { requestCooperationApproval } from '../preferences/cooperation'
import type { BrowserApi } from '../models'

/** The offer was recorded before this page opened, so every outcome here is final: close, connect, or decline. */
async function initializeOfferPage(browserApi: BrowserApi): Promise<void> {
	const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
	const connect = byId<HTMLButtonElement>('offer-connect')
	const decline = byId<HTMLButtonElement>('offer-decline')
	const status = byId('offer-status')
	const requested = new URLSearchParams(location.search).get('tc')
	const known = TEMP_CONTAINERS_EXTENSION_IDS.find(id => id === requested)
	const name = known ? (await browserApi.management.get(known).catch(() => null))?.name : undefined
	if (name) {
		byId('offer-title').textContent = `Connect ContainMarks to ${name}?`
		byId('offer-body').textContent = 'Connect the extensions so your container bookmarks open directly, with fewer extra tabs and delays.'
	}
	const done = (message: string) => {
		byId('offer-actions').remove()
		status.textContent = message
		window.close()
	}
	decline.addEventListener('click', () => done('No problem. You can connect later in ContainMarks settings.'))
	connect.addEventListener('click', async () => {
		connect.disabled = decline.disabled = true
		try {
			const approved = await requestCooperationApproval(browserApi)
			done(approved ? 'Already connected.' : 'Approve ContainMarks in the Temporary Containers tab to finish connecting.')
		} catch (error) {
			connect.disabled = decline.disabled = false
			status.textContent = error instanceof Error ? error.message : String(error)
		}
	})
}

void initializeOfferPage(globalThis.browser)
