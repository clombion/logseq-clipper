let previouslyFocusedElement: HTMLElement | null = null;

export function showModal(modal: HTMLElement | null): void {
	if (modal) {
		previouslyFocusedElement = document.activeElement as HTMLElement | null;

		modal.style.display = 'flex';

		// Store click handler so removeEventListener can reference the same function
		const bgClickHandler = () => hideModal(modal);
		const modalBg = modal.querySelector('.modal-bg');
		if (modalBg) {
			modalBg.addEventListener('click', bgClickHandler);
		}
		(modal as unknown as Record<string, unknown>).bgClickHandler = bgClickHandler;

		// Add escape key listener when showing modal
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				hideModal(modal);
			}
		};
		document.addEventListener('keydown', handleEscape);

		// Store the escape handler on the modal element for cleanup
		modal.dataset.escapeHandler = 'true';
		(modal as unknown as Record<string, unknown>).escapeHandler = handleEscape;

		// Focus the first focusable element in the modal
		const focusable = modal.querySelector<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		if (focusable) {
			focusable.focus();
		}
	}
}

export function hideModal(modal: HTMLElement | null): void {
	if (modal) {
		modal.style.display = 'none';

		// Remove the click listener using the stored handler reference
		const modalBg = modal.querySelector('.modal-bg');
		const bgClickHandler = (modal as unknown as Record<string, unknown>).bgClickHandler as (() => void) | undefined;
		if (modalBg && bgClickHandler) {
			modalBg.removeEventListener('click', bgClickHandler);
			delete (modal as unknown as Record<string, unknown>).bgClickHandler;
		}

		// Remove escape key handler if it exists
		if (modal.dataset.escapeHandler === 'true') {
			const handler = (modal as unknown as Record<string, unknown>).escapeHandler as
				| ((e: KeyboardEvent) => void)
				| undefined;
			if (handler) {
				document.removeEventListener('keydown', handler);
				delete (modal as unknown as Record<string, unknown>).escapeHandler;
			}
			delete modal.dataset.escapeHandler;
		}

		// Clear the textarea content
		const textarea = modal.querySelector('#import-json-textarea') as HTMLTextAreaElement;
		if (textarea) {
			textarea.value = '';
		}

		// Restore focus to the element that was focused before the modal opened
		if (previouslyFocusedElement && typeof previouslyFocusedElement.focus === 'function') {
			previouslyFocusedElement.focus();
			previouslyFocusedElement = null;
		}
	}
}
