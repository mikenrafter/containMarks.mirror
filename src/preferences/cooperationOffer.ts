import type { BrowserApi } from '../models'

/**
 * Per-TC record of the automatic connection offer, kept in local storage on purpose:
 * it is a device-local decision, not a synced bookmark setting.
 *  - `offered`: the offer was opened once. It is never repeated, whatever the user did with it.
 *  - `approved`: TC had already approved ContainMarks, so a later revoke is not nagged about.
 */
export const COOPERATION_OFFER_STORAGE_KEY = 'containMarks.cooperationOffers'

export type CooperationOfferState = 'offered' | 'approved'
type OfferRecords = Record<string, { state: CooperationOfferState; at: number }>

async function readRecords(browserApi: BrowserApi): Promise<OfferRecords> {
	const stored = (await browserApi.storage.local.get(COOPERATION_OFFER_STORAGE_KEY))[COOPERATION_OFFER_STORAGE_KEY]
	return stored && typeof stored === 'object' ? { ...(stored as OfferRecords) } : {}
}

/** Records `state` for `tcId` unless a decision already exists. Returns true when this call recorded it. */
export async function recordCooperationOffer(browserApi: BrowserApi, tcId: string, state: CooperationOfferState): Promise<boolean> {
	const records = await readRecords(browserApi)
	if (records[tcId]) return false
	records[tcId] = { state, at: Date.now() }
	await browserApi.storage.local.set({ [COOPERATION_OFFER_STORAGE_KEY]: records })
	return true
}

/** Undoes an `offered` record when the offer could not be opened, so a later start can retry. */
export async function forgetCooperationOffer(browserApi: BrowserApi, tcId: string): Promise<void> {
	const records = await readRecords(browserApi)
	if (records[tcId]?.state !== 'offered') return
	delete records[tcId]
	await browserApi.storage.local.set({ [COOPERATION_OFFER_STORAGE_KEY]: records })
}
