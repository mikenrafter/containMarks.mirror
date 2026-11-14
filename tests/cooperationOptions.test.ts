import { describe, expect, it, vi } from 'vitest'
import { requestCooperationApproval } from '../src/preferences/cooperation'
import type { BrowserApi } from '../src/models'

const fork = '{1ea2fa75-677e-4702-b06a-50fc7d06fe7e}'
function fixture(response: unknown = { version: 1, approved: false }) {
	return { management: { get: vi.fn(async (id: string) => {
		if (id !== fork) throw Error('not installed')
		return { id, name: 'Temporary Containers Plus', enabled: true, type: 'extension' }
	}) }, runtime: { sendMessage: vi.fn().mockResolvedValue(response) } } as unknown as BrowserApi
}
describe('named cooperation request', () => {
	// WHY: CLAIM(cooperation-authorization); the click requests review, never transmits an identity or grant.
	it('requests consent from the detected TC and reports that approval is still pending', async () => {
		const browser = fixture()
		expect(await requestCooperationApproval(browser)).toBe(false)
		expect(browser.runtime.sendMessage).toHaveBeenCalledWith(fork, { method: 'requestCooperation', version: 1 })
	})
	// WHY: preserve the connected state when the owner already granted permission.
	it('recognizes an existing approval', async () => {
		expect(await requestCooperationApproval(fixture({ version: 1, approved: true }))).toBe(true)
	})
	// WHY: older TC versions cannot open this UI, and must not be reported as a working connection.
	it('reports unsupported and missing TC', async () => {
		await expect(requestCooperationApproval(fixture(null))).rejects.toThrow('does not support')
		await expect(requestCooperationApproval(fixture({}))).rejects.toThrow('does not support')
		const browser = fixture()
		vi.mocked(browser.management.get).mockRejectedValue(Error('not installed'))
		await expect(requestCooperationApproval(browser)).rejects.toThrow('Install and enable')
		expect(browser.runtime.sendMessage).not.toHaveBeenCalled()
	})
})
