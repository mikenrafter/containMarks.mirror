import { TEMP_CONTAINERS_EXTENSION_IDS } from '../constants'
import type { BrowserApi } from '../models'

/** Opens TC's named consent page; sending a request never grants routing approval. */
export async function requestCooperationApproval(browserApi: BrowserApi): Promise<boolean> {
	for (const id of TEMP_CONTAINERS_EXTENSION_IDS) {
		const installed = await browserApi.management.get(id).catch(() => null)
		if (!installed?.enabled) continue
		const response = await browserApi.runtime.sendMessage(id, { method: 'requestCooperation', version: 1 }).catch(() => {
			throw new Error('Could not open the approval request. Check that Temporary Containers is enabled and supports cooperation.')
		}) as
			{ version?: number; approved?: boolean } | undefined
		if (response?.version !== 1 || typeof response.approved !== 'boolean') {
			throw new Error('This version of Temporary Containers does not support cooperation requests. Update it to use this connection.')
		}
		return response.approved
	}
	throw new Error('Install and enable Temporary Containers Plus to connect.')
}
