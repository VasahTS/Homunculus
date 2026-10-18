// Classic UI fork: replaces SillyBunny's graphical shell (sillybunny-tabs.js) with the
// original SillyTavern top-bar drawers. Everything else in SillyBunny (agents, companions,
// conversation mode, bundled extensions) keeps running unchanged; this module only provides
// the small shell API those modules expect and routes their requests to classic drawers.

const MOBILE_MEDIA_QUERY = '(max-width: 768px)';

/** Drawer ids for shell routes used by SillyBunny modules ("shellKey:tabId"). */
const ROUTES = Object.freeze({
    'left:presets': 'ai-config-button',
    'left:sampling': 'ai-config-button',
    'left:api': 'sys-settings-button',
    'left:advanced-formatting': 'advanced-formatting-button',
    'left:agents': 'agents-settings-button',
    'left:world-info': 'WI-SP-button',
    'right:settings': 'user-settings-button',
    'right:extensions': 'extensions-settings-button',
    'right:background': 'backgrounds-button',
    'characters:world-info': 'WI-SP-button',
    'characters:persona': 'persona-management-button',
    'characters:characters': 'rightNavHolder',
    'characters:editor': 'rightNavHolder',
    'characters:import': 'rightNavHolder',
    'characters:groups': 'rightNavHolder',
});

function isMobileViewport() {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/**
 * Opens a classic top-bar drawer (no-op when it is already open).
 * @param {string} drawerId Id of the `.drawer` element.
 * @returns {boolean} Whether the drawer exists.
 */
function openDrawer(drawerId) {
    const drawer = document.getElementById(drawerId);
    if (!drawer) {
        return false;
    }
    const content = drawer.querySelector(':scope > .drawer-content');
    if (content && content.classList.contains('openDrawer')) {
        return true;
    }
    drawer.querySelector(':scope > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
}

function closeDrawer(drawerId) {
    const drawer = document.getElementById(drawerId);
    const content = drawer?.querySelector(':scope > .drawer-content');
    if (content && content.classList.contains('openDrawer') && !content.classList.contains('pinnedOpen')) {
        drawer.querySelector(':scope > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
}

function openTab(shellKey, tabId) {
    const route = `${shellKey}:${tabId}`;
    const drawerId = ROUTES[route] ?? (shellKey === 'characters' ? 'rightNavHolder' : null);
    if (!drawerId) {
        console.warn(`[Classic UI] No classic drawer for route "${route}".`);
        return false;
    }
    return openDrawer(drawerId);
}

function dispatchTabActivated(shellKey, tabId) {
    document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', {
        detail: { shellKey, tabId },
    }));
}

/**
 * SillyBunny modules notify the shell when a panel becomes visible (agents refresh their token
 * counter and tool registrations, World Info closes its pop-out). Mirror that for classic drawers.
 */
function bindDrawerActivationEvents() {
    const watched = [
        { contentId: 'rm_agents_block', shellKey: 'left', tabId: 'agents' },
        { contentId: 'WorldInfo', shellKey: 'characters', tabId: 'world-info' },
        { contentId: 'PersonaManagement', shellKey: 'characters', tabId: 'persona' },
        { contentId: 'right-nav-panel', shellKey: 'characters', tabId: 'characters' },
    ];

    for (const { contentId, shellKey, tabId } of watched) {
        const content = document.getElementById(contentId);
        if (!content) {
            continue;
        }
        let wasOpen = content.classList.contains('openDrawer');
        new MutationObserver(() => {
            const isOpen = content.classList.contains('openDrawer');
            if (isOpen && !wasOpen) {
                dispatchTabActivated(shellKey, tabId);
            }
            wasOpen = isOpen;
        }).observe(content, { attributes: true, attributeFilter: ['class'] });
    }
}

/* ---------- Character editor sections (SillyBunny's inline replacement for the ADV popup) ---------- */

const EDITOR_SUB_TABS = ['char-info', 'definitions', 'greetings', 'metadata'];
const EDITOR_SPOILER_FREE_VISIBLE_TABS = ['char-info', 'metadata'];
// Same key SillyBunny's shell uses, so the remembered section carries over.
const EDITOR_SUB_TAB_STORAGE_KEY = 'sb-character-editor-sub-tab';

function normalizeEditorSubTab(tabId) {
    return EDITOR_SUB_TABS.includes(String(tabId ?? '')) ? String(tabId) : EDITOR_SUB_TABS[0];
}

function isEditorSubTabSpoilerHidden(tabId) {
    const form = document.getElementById('form_create');
    return form?.dataset.sbSpoilerFreeFieldsHidden === 'true'
        && !EDITOR_SPOILER_FREE_VISIBLE_TABS.includes(normalizeEditorSubTab(tabId));
}

function setEditorSubTab(tabId) {
    let activeTab = normalizeEditorSubTab(tabId);
    if (isEditorSubTabSpoilerHidden(activeTab)) {
        activeTab = 'metadata';
    }
    try { localStorage.setItem(EDITOR_SUB_TAB_STORAGE_KEY, activeTab); } catch { /* storage unavailable */ }

    for (const button of document.querySelectorAll('#sb_character_editor_subtabs [data-sb-character-editor-tab]')) {
        const isActive = button.dataset.sbCharacterEditorTab === activeTab;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', String(isActive));
        button.setAttribute('tabindex', isActive ? '0' : '-1');
        button.classList.toggle('is-spoiler-hidden', isEditorSubTabSpoilerHidden(button.dataset.sbCharacterEditorTab));
    }
    for (const panel of document.querySelectorAll('#form_create [data-sb-character-editor-panel]')) {
        const isActive = panel.dataset.sbCharacterEditorPanel === activeTab;
        panel.hidden = !isActive;
        panel.setAttribute('aria-hidden', String(!isActive));
    }
}

function bindEditorSubTabs() {
    const tablist = document.getElementById('sb_character_editor_subtabs');
    if (!tablist || tablist.dataset.classicBound === 'true') {
        return;
    }
    tablist.dataset.classicBound = 'true';
    tablist.addEventListener('click', async (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-sb-character-editor-tab]') : null;
        if (!(button instanceof HTMLElement)) {
            return;
        }
        const tabId = button.dataset.sbCharacterEditorTab;
        // A deliberate click on a spoiler-hidden section reveals the fields, as in SillyBunny.
        if (isEditorSubTabSpoilerHidden(tabId)) {
            const { setCharacterSpoilerFreeFieldsHidden } = await import('./power-user.js');
            setCharacterSpoilerFreeFieldsHidden(false);
        }
        setEditorSubTab(tabId);
    });
    let storedTab = null;
    try { storedTab = localStorage.getItem(EDITOR_SUB_TAB_STORAGE_KEY); } catch { /* storage unavailable */ }
    setEditorSubTab(storedTab);
}

/* ---------- Roleplay / Conversation mode switch ---------- */

function syncModeToggle(isConversationOpen) {
    const activeMode = isConversationOpen ? 'conversation' : 'roleplay';
    const toggle = document.getElementById('sb_character_mode_toggle');
    if (!toggle) {
        return;
    }
    toggle.dataset.activeMode = activeMode;
    for (const button of toggle.querySelectorAll('[data-sb-character-mode]')) {
        const isActive = button.dataset.sbCharacterMode === activeMode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-checked', String(isActive));
    }
}

function bindModeToggle() {
    const toggle = document.getElementById('sb_character_mode_toggle');
    if (!toggle || toggle.dataset.classicBound === 'true') {
        return;
    }
    toggle.dataset.classicBound = 'true';
    toggle.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-sb-character-mode]') : null;
        if (!(button instanceof HTMLElement) || button.classList.contains('is-active')) {
            return;
        }
        if (button.dataset.sbCharacterMode === 'conversation') {
            const context = globalThis.SillyTavern?.getContext?.();
            const avatar = context?.characters?.[context?.characterId]?.avatar || '';
            window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', { detail: { avatar, showToast: false } }));
        } else {
            window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
        }
    });
    window.addEventListener('sb:conversation-workspace-state-changed', (event) => {
        syncModeToggle(Boolean(event instanceof CustomEvent && event.detail?.open));
    });
}

/* ---------- Message buttons that belong to optional extensions ---------- */

async function syncExtensionMessageButtons(root = document) {
    if (typeof root === 'number') {
        root = document.querySelector(`.mes[mesid="${root}"]`) || document;
    }
    if (!root?.querySelectorAll) {
        return;
    }
    const buttons = root.querySelectorAll('[data-requires-extension]');
    if (!buttons.length) {
        return;
    }
    const { extension_settings } = await import('./extensions.js');
    const normalize = name => String(name || '').replace(/^third-party\//i, '').toLowerCase();
    const aliases = { 'stable-diffusion': ['stable-diffusion', 'sd'], 'sd': ['stable-diffusion', 'sd'] };
    const disabled = new Set((extension_settings?.disabledExtensions ?? []).map(normalize));
    for (const button of buttons) {
        const name = normalize(button.dataset.requiresExtension);
        const isEnabled = !(aliases[name] ?? [name]).some(alias => disabled.has(alias));
        button.classList.toggle('displayNone', !isEnabled);
        button.toggleAttribute('aria-hidden', !isEnabled);
    }
}

/* ---------- Sections SillyBunny collapses by default: show them like SillyTavern does ---------- */

function expandInlineDrawer(drawer) {
    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon, :scope > .inline-drawer-toggle .inline-drawer-icon');
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    if (!(content instanceof HTMLElement)) {
        return;
    }
    content.style.display = content.classList.contains('flex-container') ? 'flex' : 'block';
    icon?.classList.remove('down', 'fa-circle-chevron-down');
    icon?.classList.add('up', 'fa-circle-chevron-up');
}

async function expandSillyBunnySections() {
    // Chat Completion settings groups: respect a state the user picked, otherwise open.
    const { accountStorage } = await import('./util/AccountStorage.js');
    for (const drawer of document.querySelectorAll('.sb-openai-settings-drawer[id]')) {
        if (accountStorage.getItem(`OpenAIDrawerState:${drawer.id}`) === null) {
            expandInlineDrawer(drawer);
        }
    }
    // User Settings groups (SillyTavern shows all of these at once).
    // Import & Restore stays collapsed: it is only needed occasionally.
    for (const drawer of document.querySelectorAll('#user-settings-block .sb-settings-subdrawer:not(#SillyTavernImportSection)')) {
        expandInlineDrawer(drawer);
    }
}

function bindAppEvents() {
    let context = null;
    try {
        context = globalThis.SillyTavern?.getContext?.();
    } catch {
        return false; // script.js is still initializing
    }
    if (!context?.eventSource || !context?.event_types) {
        return false;
    }
    const { eventSource, event_types } = context;
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => void syncExtensionMessageButtons());
    eventSource.on(event_types.SETTINGS_UPDATED, () => void syncExtensionMessageButtons());
    eventSource.on(event_types.USER_MESSAGE_RENDERED, id => void syncExtensionMessageButtons(id));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => void syncExtensionMessageButtons(id));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        let storedTab = null;
        try { storedTab = localStorage.getItem(EDITOR_SUB_TAB_STORAGE_KEY); } catch { /* storage unavailable */ }
        setEditorSubTab(storedTab);
    });
    eventSource.on(event_types.APP_READY, () => {
        void addLeftPanelLock();
        import('./classic-importer.js')
            .then(module => module.injectSillyTavernImportCard())
            .catch(error => console.error('[Classic UI] Could not set up Import & Restore:', error));
        bindEditorSubTabs();
        void expandSillyBunnySections();
        void syncExtensionMessageButtons();
    });
    return true;
}

const classicShell = {
    isClassicUi: true,
    openTab,
    openCharacters() {
        openDrawer('rightNavHolder');
    },
    closeCharacters() {
        // Upstream SillyTavern keeps the character panel open after picking a character on desktop.
        if (isMobileViewport()) {
            closeDrawer('rightNavHolder');
        }
    },
    isMobileViewport,
    highlightCharacterEditorTab() { /* the classic character panel has no editor tab */ },
};

// welcome-screen.js may already have attached helpers (e.g. highlightLaunchpadItem); keep them.
globalThis.SillyBunnyShell = Object.assign(globalThis.SillyBunnyShell || {}, classicShell);
document.documentElement.dataset.sbClassicUi = 'true';

/** World Info entry status: SillyTavern's compact emoji markers instead of SillyBunny's words. */
function useCompactWorldInfoStatus() {
    const labels = { constant: '\u{1F535}', normal: '\u{1F7E2}', vectorized: '\u{1F517}' };
    for (const option of document.querySelectorAll('#entry_edit_template select[name="entryStateSelector"] option')) {
        if (labels[option.value]) {
            option.textContent = labels[option.value];
        }
    }
}

/** User Settings: SillyBunny nests the third column inside the second; put it back beside them. */
function restoreUserSettingsColumns() {
    const content = document.getElementById('user-settings-block-content');
    const thirdColumn = document.getElementById('power-user-options-block');
    if (content && thirdColumn && thirdColumn.parentElement !== content) {
        content.append(thirdColumn);
    }
}

/**
 * With every editor section shown at once, keep SillyTavern's reading order: name and description
 * first, the prompt overrides (which SillyTavern keeps in its Advanced Definitions popup) further down.
 */
function moveCharacterPromptOverrides() {
    const overrides = document.querySelector('#sb_character_editor_panel_char_info .sb-character-editor-prompt-overrides');
    const metadata = document.getElementById('sb_character_editor_panel_metadata');
    if (overrides && metadata) {
        metadata.prepend(overrides);
    }
}

/**
 * Character editor in SillyTavern's arrangement: avatar beside one row of icon buttons and "More...",
 * tags underneath, Creator's Notes below the tags, and First message right after Description.
 * Nodes are moved (not cloned), so SillyBunny's event handlers keep working.
 */
function arrangeCharacterEditor() {
    const identity = document.getElementById('avatar-and-name-block');
    const avatar = document.getElementById('avatar_div_div');
    const icons = document.querySelector('#avatar_controls .char-button-group-icons');
    if (!identity || !avatar || !icons || document.getElementById('classic_char_header')) {
        return;
    }

    const header = document.createElement('div');
    header.id = 'classic_char_header';
    const side = document.createElement('div');
    side.className = 'classic_char_header_side';
    header.append(avatar, side);

    const favorite = document.getElementById('favorite_button');
    if (favorite) {
        icons.prepend(favorite);
    }
    side.append(icons);
    const backButton = document.querySelector('#avatar_controls .char-button-group-utility');
    if (backButton) {
        icons.append(...backButton.children);
    }
    const moreMenu = document.querySelector('label[for="char-management-dropdown"]');
    if (moreMenu) {
        side.append(moreMenu);
    }

    const nameDiv = document.getElementById('name_div');
    const tagsDiv = document.getElementById('tags_div');
    const tagList = document.getElementById('tagList');
    const creatorNotes = document.getElementById('spoiler_free_desc');
    const hiddenNotice = document.getElementById('creators_note_desc_hidden');
    const ordered = [header, nameDiv, tagsDiv, tagList, creatorNotes, hiddenNotice].filter(Boolean);
    identity.prepend(...ordered);
    identity.classList.add('classic_char_identity');

    const description = document.getElementById('descriptionWrapper');
    const firstMessage = document.getElementById('firstMessageWrapper');
    if (description && firstMessage) {
        description.after(firstMessage);
    }

    const greetingsTitle = document.querySelector('#first_message_div .mdhotkey_location');
    if (greetingsTitle) {
        greetingsTitle.removeAttribute('data-i18n');
        greetingsTitle.textContent = 'First message';
    }
}

/* ---------- Lock for the AI Response Configuration panel (SillyTavern feature SillyBunny removed) ---------- */

async function addLeftPanelLock() {
    const panel = document.getElementById('left-nav-panel');
    if (!panel || document.getElementById('lm_button_panel_pin')) {
        return;
    }
    const { accountStorage } = await import('./util/AccountStorage.js');

    const wrapper = document.createElement('div');
    wrapper.id = 'lm_button_panel_pin_div';
    wrapper.title = 'Locked = AI Configuration panel will stay open';
    wrapper.innerHTML = `
        <input type="checkbox" id="lm_button_panel_pin">
        <label for="lm_button_panel_pin">
            <div class="unchecked fa-solid fa-unlock right_menu_button"></div>
            <div class="checked fa-solid fa-lock right_menu_button"></div>
        </label>`;
    const grabber = document.getElementById('left-nav-panelheader');
    if (grabber) {
        grabber.after(wrapper);
    } else {
        panel.prepend(wrapper);
    }

    const checkbox = /** @type {HTMLInputElement} */ (wrapper.querySelector('input'));
    const icon = document.getElementById('leftNavDrawerIcon');
    const applyPinned = (pinned) => {
        panel.classList.toggle('pinnedOpen', pinned);
        icon?.classList.toggle('drawerPinnedOpen', pinned);
    };

    checkbox.addEventListener('click', () => {
        const pinned = checkbox.checked;
        accountStorage.setItem('LNavLockOn', String(pinned));
        applyPinned(pinned);
        // Unlocking while another drawer is open closes this one, like SillyTavern.
        if (!pinned && panel.classList.contains('openDrawer') && document.querySelectorAll('.openDrawer').length > 1) {
            document.querySelector('#ai-config-button > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
    });

    if (!isMobileViewport()) {
        const pinned = accountStorage.getItem('LNavLockOn') === 'true';
        checkbox.checked = pinned;
        applyPinned(pinned);
        // Reopen a locked panel that was open when the page was last closed.
        new MutationObserver(() => {
            accountStorage.setItem('LNavOpened', String(panel.classList.contains('openDrawer')));
        }).observe(panel, { attributes: true, attributeFilter: ['class'] });
        if (pinned && accountStorage.getItem('LNavOpened') === 'true' && !panel.classList.contains('openDrawer')) {
            document.querySelector('#ai-config-button > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
    }
}

function initClassicUi() {
    useCompactWorldInfoStatus();
    moveCharacterPromptOverrides();
    arrangeCharacterEditor();
    restoreUserSettingsColumns();
    bindDrawerActivationEvents();
    bindEditorSubTabs();
    bindModeToggle();
    // script.js publishes globalThis.SillyTavern while it loads; wait for it if needed.
    if (!bindAppEvents()) {
        const timer = window.setInterval(() => {
            if (bindAppEvents()) {
                window.clearInterval(timer);
            }
        }, 100);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initClassicUi, { once: true });
} else {
    initClassicUi();
}
