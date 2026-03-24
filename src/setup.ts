import browser from './utils/browser-polyfill';
import { checkConnection, type LogseqApiConfig } from './utils/logseq-api';

document.addEventListener('DOMContentLoaded', () => {
	const tokenInput = document.getElementById('setup-token') as HTMLInputElement;
	const portInput = document.getElementById('setup-port') as HTMLInputElement;
	const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
	const testStatus = document.getElementById('test-status') as HTMLSpanElement;
	const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;

	testBtn.addEventListener('click', async () => {
		const config: LogseqApiConfig = {
			port: parseInt(portInput.value, 10) || 12315,
			token: tokenInput.value,
		};

		testStatus.textContent = 'Testing...';
		testStatus.style.color = '';

		const success = await checkConnection(config);

		if (success) {
			testStatus.textContent = '\u2713 Connected to Logseq';
			testStatus.style.color = 'green';
			saveBtn.disabled = false;
		} else {
			testStatus.textContent = '\u2717 Could not connect. Is Logseq running with the API server started?';
			testStatus.style.color = 'red';
			saveBtn.disabled = true;
		}
	});

	saveBtn.addEventListener('click', async () => {
		// Save to extension storage
		await browser.storage.local.set({
			logseq_settings: {
				apiPort: parseInt(portInput.value, 10) || 12315,
				apiToken: tokenInput.value,
				logPage: 'Web Clips Log',
			},
		});

		// Mark setup as complete
		await browser.storage.local.set({ setupComplete: true });

		// Open settings page
		browser.runtime.openOptionsPage();
	});
});
