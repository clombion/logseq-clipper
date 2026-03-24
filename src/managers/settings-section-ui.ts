import { updateUrl } from '../utils/routing';
import { updatePromptContextVisibility } from './interpreter-settings';
import { initializePropertyTypesManager } from './property-types-manager';

export type SettingsSection = 'general' | 'properties' | 'highlighter' | 'interpreter' | 'reader' | 'templates';

export function showSettingsSection(section: SettingsSection, templateId?: string): void {
	const sections = document.querySelectorAll('.settings-section');
	const sidebarItems = document.querySelectorAll('#sidebar li[data-section]');

	sections.forEach((s) => {
		s.classList.remove('active');
	});
	sidebarItems.forEach((item) => {
		item.classList.remove('active');
		item.setAttribute('aria-selected', 'false');
	});

	const selectedSection = document.getElementById(`${section}-section`);
	const selectedSidebarItem = document.querySelector(`#sidebar li[data-section="${section}"]`);

	if (selectedSection) {
		selectedSection.classList.add('active');
	}
	if (selectedSidebarItem) {
		selectedSidebarItem.classList.add('active');
		selectedSidebarItem.setAttribute('aria-selected', 'true');
	}

	updateUrl(section, templateId);

	if (section === 'properties') {
		initializePropertyTypesManager();
	}

	if (section === 'templates') {
		const templateEditor = document.getElementById('template-editor');
		if (templateEditor) {
			templateEditor.style.display = 'block';
		}
	}

	updatePromptContextVisibility();
}

function _updateSidebarActiveState(activeSection: string): void {
	document.querySelectorAll('#sidebar li').forEach((item) => {
		item.classList.remove('active');
	});
	const activeItem = document.querySelector(`#sidebar li[data-section="${activeSection}"]`);
	if (activeItem) activeItem.classList.add('active');
}

function _updateTemplateListActiveState(templateId: string): void {
	const templateListItems = document.querySelectorAll('#template-list li');
	templateListItems.forEach((item) => {
		item.classList.remove('active');
		if ((item as HTMLElement).dataset.id === templateId) {
			item.classList.add('active');
		}
	});
}

export function initializeSidebar(): void {
	const sidebar = document.getElementById('sidebar');
	const settingsContainer = document.getElementById('settings');
	const templateList = document.getElementById('template-list');
	const hamburgerMenu = document.getElementById('hamburger-menu');

	if (sidebar) {
		const activateSidebarItem = (target: HTMLElement) => {
			if (
				target.dataset.section === 'general' ||
				target.dataset.section === 'properties' ||
				target.dataset.section === 'highlighter' ||
				target.dataset.section === 'interpreter' ||
				target.dataset.section === 'reader'
			) {
				showSettingsSection(
					target.dataset.section as 'general' | 'properties' | 'highlighter' | 'interpreter' | 'reader',
				);
			}
			if (settingsContainer) {
				settingsContainer.classList.remove('sidebar-open');
			}
			if (hamburgerMenu) {
				hamburgerMenu.classList.remove('is-active');
			}
		};

		sidebar.addEventListener('click', (event) => {
			activateSidebarItem(event.target as HTMLElement);
		});

		sidebar.addEventListener('keydown', (event) => {
			const target = event.target as HTMLElement;
			const key = (event as KeyboardEvent).key;

			if (key === 'Enter' || key === ' ') {
				event.preventDefault();
				activateSidebarItem(target);
				return;
			}

			if (key === 'ArrowDown' || key === 'ArrowUp') {
				event.preventDefault();
				const items = Array.from(sidebar.querySelectorAll<HTMLElement>('li[data-section]'));
				const visibleItems = items.filter((item) => item.style.display !== 'none');
				const currentIndex = visibleItems.indexOf(target);
				if (currentIndex === -1) return;

				let nextIndex: number;
				if (key === 'ArrowDown') {
					nextIndex = (currentIndex + 1) % visibleItems.length;
				} else {
					nextIndex = (currentIndex - 1 + visibleItems.length) % visibleItems.length;
				}
				visibleItems[nextIndex]?.focus();
			}
		});
	}

	if (templateList) {
		templateList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement;
			const listItem = target.closest('li') as HTMLElement;
			if (listItem?.dataset.id) {
				showSettingsSection('templates', listItem.dataset.id);
				if (settingsContainer) {
					settingsContainer.classList.remove('sidebar-open');
				}
				if (hamburgerMenu) {
					hamburgerMenu.classList.remove('is-active');
				}
			}
		});
	}

	if (hamburgerMenu && settingsContainer) {
		hamburgerMenu.addEventListener('click', () => {
			settingsContainer.classList.toggle('sidebar-open');
			hamburgerMenu.classList.toggle('is-active');
			hamburgerMenu.setAttribute('aria-expanded', String(settingsContainer.classList.contains('sidebar-open')));
		});
	}
}
