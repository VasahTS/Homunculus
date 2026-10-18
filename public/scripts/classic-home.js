// Classic UI fork: the Home page (house icon), the Chat button and the page switching of the
// Lantern layout (one page at a time: body[data-ct-view] + .ct-view-active on the shown panel).
//
// Home gathers everything in one place: recent chats, characters, lorebooks, personas, groups and
// shortcuts to every settings drawer. Each item opens the place where it is edited:
//   character -> selects it and opens the character editor (right panel)
//   lorebook  -> opens the World Info editor on that lorebook
//   persona   -> opens Persona Management with that persona highlighted
//   group     -> opens the group and its editor
//   tool      -> opens the matching top-bar drawer
// Nothing here changes data; it only calls the same functions SillyTavern's own buttons use.

/** Rail entries: drawer id, label, order in the Lantern sidebar. Items with order >= 10 sit at the bottom. */
const RAIL_ITEMS = Object.freeze([
    ['ct-home-button', 'Home', 0],
    ['ct-chat-button', 'Chat', 1],
    ['rightNavHolder', 'Characters', 2],
    ['WI-SP-button', 'Lorebooks', 3],
    ['persona-management-button', 'Persona', 4],
    ['agents-settings-button', 'Agents', 5],
    ['ct-memory-button', 'Memory', 6],
    ['extensions-settings-button', 'Extensions', 7],
    ['ai-config-button', 'Presets', 10],
    ['sys-settings-button', 'API', 11],
    ['advanced-formatting-button', 'Formatting', 12],
    ['backgrounds-button', 'Backgrounds', 13],
    ['ct-personalize-button', 'Customize', 14],
    ['user-settings-button', 'Settings', 15],
]);

const TOOLS = Object.freeze([
    { drawer: 'ai-config-button', icon: 'fa-sliders', name: 'Presets', desc: 'Model settings, samplers and the prompt.' },
    { drawer: 'sys-settings-button', icon: 'fa-plug', name: 'API', desc: 'Connect to a model provider.' },
    { drawer: 'advanced-formatting-button', icon: 'fa-font', name: 'Formatting', desc: 'Instruct, context and system templates.' },
    { drawer: 'agents-settings-button', icon: 'fa-robot', name: 'Agents', desc: 'In-chat agents that help each reply.' },
    { drawer: 'ct-memory-button', icon: 'fa-brain', name: 'Memory', desc: 'Chapter summaries and recall of old messages.' },
    { open: 'SillyBunnyClassicCardBrowser', icon: 'fa-earth-americas', name: 'Card Browser', desc: 'Find and import cards from ChubAI, JannyAI and more.' },
    { drawer: 'extensions-settings-button', icon: 'fa-cubes', name: 'Extensions', desc: 'Install and configure extensions.' },
    { drawer: 'backgrounds-button', icon: 'fa-panorama', name: 'Backgrounds', desc: 'Pick the chat background.' },
    { drawer: 'ct-personalize-button', icon: 'fa-palette', name: 'Customize', desc: 'Visual profiles, layout and effects.' },
    { drawer: 'user-settings-button', icon: 'fa-user-gear', name: 'Settings', desc: 'Everything else about the app.' },
]);

const PREVIEW_COUNT = 12;

const state = {
    open: false,
    query: '',
    showAllChars: false,
    showAllLore: false,
    recent: [],
    worlds: [],
    activeWorlds: [],
    personas: {},
};

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function hueFor(text) {
    let hash = 0;
    for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 62% 72%)`;
}

function plainSnippet(text, max = 110) {
    const div = document.createElement('div');
    div.innerHTML = String(text ?? '').replace(/<[^>]*>/g, ' ');
    const clean = (div.textContent ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function greeting() {
    const hour = new Date().getHours();
    if (hour < 5) return 'Good night';
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

/* ------------------------------------------------------------------------------------------- */
/* Drawers                                                                                       */
/* ------------------------------------------------------------------------------------------- */

function drawerToggle(drawerId) {
    const drawer = document.getElementById(drawerId);
    return drawer?.querySelector(':scope > .drawer-toggle') ?? null;
}

function openDrawer(drawerId) {
    const drawer = document.getElementById(drawerId);
    const content = drawer?.querySelector(':scope > .drawer-content');
    if (content && !content.classList.contains('openDrawer')) {
        drawerToggle(drawerId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Sidebar labels + Home button                                                                  */
/* ------------------------------------------------------------------------------------------- */

function makeRailButton(id, icon, label, onActivate) {
    const holder = document.getElementById('top-settings-holder');
    if (!holder || document.getElementById(id)) return;
    const wrap = document.createElement('div');
    wrap.id = id;
    wrap.className = 'drawer';
    wrap.innerHTML = `<div class="ct-home-toggle" role="button" tabindex="0" title="${label}" aria-label="${label}"><div class="drawer-icon fa-solid ${icon} fa-fw closedIcon"></div></div>`;
    holder.prepend(wrap);
    const toggle = wrap.querySelector('.ct-home-toggle');
    toggle.addEventListener('click', () => onActivate());
    toggle.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
        }
    });
}

function ensureHomeButton() {
    makeRailButton('ct-chat-button', 'fa-comments', 'Chat', () => showChat());
    makeRailButton('ct-home-button', 'fa-house', 'Home', () => toggleHome());
    const holder = document.getElementById('top-settings-holder');
    if (holder && !document.getElementById('ct-rail-indicator')) {
        const indicator = document.createElement('div');
        indicator.id = 'ct-rail-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        holder.prepend(indicator);
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Pages (Lantern layout): exactly one of chat / home / a drawer panel is shown                  */
/* ------------------------------------------------------------------------------------------- */

let currentView = 'chat';
let viewsReady = false;
const wasOpen = new WeakMap();

function isOpenContent(content) {
    return content.classList.contains('openDrawer');
}

function drawerContents() {
    return [...document.querySelectorAll('#top-settings-holder > .drawer > .drawer-content')];
}

function placeIndicator() {
    const indicator = document.getElementById('ct-rail-indicator');
    if (!indicator) return;
    const railId = currentView === 'chat' ? 'ct-chat-button' : currentView === 'home' ? 'ct-home-button' : currentView;
    const toggle = document.querySelector(`#${CSS.escape(railId)} > .drawer-toggle, #${CSS.escape(railId)} > .ct-home-toggle`);
    if (!toggle || !toggle.offsetParent) {
        indicator.style.setProperty('--ct-o', '0');
        return;
    }
    const first = indicator.style.getPropertyValue('--ct-o') !== '1';
    if (first) indicator.style.transition = 'none';
    indicator.style.setProperty('--ct-y', `${toggle.offsetTop}px`);
    indicator.style.setProperty('--ct-o', '1');
    if (first) requestAnimationFrame(() => { indicator.style.transition = ''; });
}

/* Presets locked beside the chat (Lantern layout). Locking the Presets page keeps it as a column
   on the left of the chat, like SillyTavern's pinned panel. */
const DOCK_DRAWER = 'ai-config-button';

function isLanternActive() {
    return document.body.classList.contains('ct-layout-lanterna') && window.matchMedia('(min-width: 1000px)').matches;
}

function dockPanel() {
    return document.getElementById('left-nav-panel');
}

function isDocked() {
    const panel = dockPanel();
    return !!panel && panel.classList.contains('pinnedOpen') && isOpenContent(panel);
}

function syncDock() {
    document.body.classList.toggle('ct-dock-left', isLanternActive() && isDocked());
}

function bindDock() {
    const panel = dockPanel();
    if (panel) {
        new MutationObserver(syncDock).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    // The lock: locking from the Presets page moves it beside the chat; unlocking there closes it.
    document.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target?.id !== 'lm_button_panel_pin') return;
        setTimeout(() => {
            syncDock();
            if (!isLanternActive()) return;
            const pinned = /** @type {HTMLInputElement} */ (target).checked;
            if (pinned && currentView === DOCK_DRAWER) {
                setView('chat');
            } else if (!pinned && currentView === 'chat' && panel && isOpenContent(panel)) {
                closeDrawerContent(panel);
            }
        }, 0);
    });
    // While it is locked, its sidebar item just brings the chat (and the column) back.
    document.addEventListener('click', (event) => {
        const toggle = /** @type {HTMLElement} */ (event.target)?.closest?.(`#${DOCK_DRAWER} > .drawer-toggle`);
        if (!toggle || !isLanternActive() || !isDocked() || currentView === 'chat') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        showChat();
    }, true);
}

export function setView(view) {
    currentView = view || 'chat';
    document.body.dataset.ctView = currentView;
    syncDock();
    for (const content of drawerContents()) {
        const active = content.closest('.drawer')?.id === currentView && isOpenContent(content);
        if (active && !content.classList.contains('ct-view-active')) {
            content.classList.add('ct-view-active');
            content.scrollTop = 0;
        } else if (!active) {
            content.classList.remove('ct-view-active');
        }
    }
    for (const drawer of document.querySelectorAll('#top-settings-holder > .drawer')) {
        const railId = currentView === 'chat' ? 'ct-chat-button' : currentView === 'home' ? 'ct-home-button' : currentView;
        drawer.classList.toggle('ct-rail-active', drawer.id === railId);
    }
    placeIndicator();
    document.dispatchEvent(new CustomEvent('ct:view-changed', { detail: { view: currentView } }));
}

export function getView() {
    return currentView;
}

function closeDrawerContent(content) {
    if (content && isOpenContent(content)) {
        content.closest('.drawer')?.querySelector(':scope > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
}

export function showChat() {
    closeHome();
    if (currentView !== 'chat' && currentView !== 'home') {
        closeDrawerContent(document.querySelector(`#${CSS.escape(currentView)} > .drawer-content`));
    }
    setView('chat');
}

function watchDrawers() {
    for (const content of drawerContents()) {
        wasOpen.set(content, isOpenContent(content));
        new MutationObserver(() => {
            const open = isOpenContent(content);
            const id = content.closest('.drawer')?.id;
            if (open && !wasOpen.get(content)) {
                if (viewsReady) {
                    if (id === DOCK_DRAWER && content.classList.contains('pinnedOpen') && isLanternActive()) {
                        // Locked Presets opens as the column beside the chat, not as its own page.
                        closeHome();
                        setView('chat');
                    } else {
                        closeHome(true);
                        setView(id);
                    }
                }
            } else if (!open && wasOpen.get(content)) {
                if (currentView === id) setView('chat');
                else content.classList.remove('ct-view-active');
            }
            wasOpen.set(content, open);
        }).observe(content, { attributes: true, attributeFilter: ['class'] });
    }
}

function decorateRail() {
    for (const [id, label, order] of RAIL_ITEMS) {
        const drawer = document.getElementById(id);
        if (!drawer) continue;
        drawer.style.setProperty('--ct-rail-order', String(order));
        const toggle = drawer.querySelector(':scope > .drawer-toggle, :scope > .ct-home-toggle');
        if (toggle && !toggle.querySelector('.ct-rail-label')) {
            const span = document.createElement('span');
            span.className = 'ct-rail-label';
            span.textContent = label;
            toggle.append(span);
        }
    }
}

/* ------------------------------------------------------------------------------------------- */
/* Data                                                                                          */
/* ------------------------------------------------------------------------------------------- */

async function loadData() {
    const context = ctx();
    const tasks = [];
    tasks.push(fetch('/api/chats/recent', {
        method: 'POST',
        headers: context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max: 6 }),
        cache: 'no-cache',
    }).then(response => (response.ok ? response.json() : [])).catch(() => []));
    tasks.push(import('./world-info.js').then(module => ({
        names: Array.isArray(module.world_names) ? [...module.world_names] : [],
        active: Array.isArray(module.selected_world_info) ? [...module.selected_world_info] : [],
    })).catch(() => ({ names: [], active: [] })));
    tasks.push(import('./power-user.js').then(module => ({ ...(module.power_user?.personas ?? {}) })).catch(() => ({})));
    const [recent, worlds, personas] = await Promise.all(tasks);
    state.recent = Array.isArray(recent) ? recent : [];
    state.worlds = worlds.names;
    state.activeWorlds = worlds.active;
    state.personas = personas;
}

/* ------------------------------------------------------------------------------------------- */
/* Render                                                                                        */
/* ------------------------------------------------------------------------------------------- */

function matches(text) {
    return !state.query || String(text ?? '').toLowerCase().includes(state.query);
}

function tagNames(context, avatar) {
    const ids = context?.tagMap?.[avatar] ?? [];
    return ids.map(id => context?.tags?.find(tag => tag.id === id)?.name).filter(Boolean);
}

function render() {
    const root = document.getElementById('ct-home');
    const context = ctx();
    if (!root || !context) return;

    const characters = Array.isArray(context.characters) ? context.characters : [];
    const groups = Array.isArray(context.groups) ? context.groups : [];
    const thumb = (type, file) => context.getThumbnailUrl?.(type, file) ?? '';
    const personaEntries = Object.entries(state.personas);

    const sortedChars = characters
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => character?.avatar && matches(`${character.name} ${tagNames(context, character.avatar).join(' ')}`))
        .sort((a, b) => Number(Boolean(b.character.fav)) - Number(Boolean(a.character.fav))
            || (Number(b.character.date_last_chat) || 0) - (Number(a.character.date_last_chat) || 0)
            || String(a.character.name).localeCompare(String(b.character.name)));
    const visibleChars = state.showAllChars || state.query ? sortedChars : sortedChars.slice(0, PREVIEW_COUNT);

    const lorebooks = state.worlds.filter(name => matches(name));
    const visibleLore = state.showAllLore || state.query ? lorebooks : lorebooks.slice(0, PREVIEW_COUNT);
    const linkedBy = (name) => characters.filter(character => character?.data?.extensions?.world === name).map(character => character.name);

    const recent = state.recent
        .map(chat => ({ chat, character: characters.find(item => item.avatar === chat.avatar), group: groups.find(item => item.id === chat.group) }))
        .filter(item => item.character || item.group)
        .slice(0, 4);

    const people = personaEntries.filter(([, name]) => matches(name));
    const groupList = groups.filter(group => matches(group.name));

    const firstRecent = recent[0];
    const continueLabel = firstRecent ? (firstRecent.character?.name ?? firstRecent.group?.name ?? '') : '';
    const userName = context.name1 || 'there';

    root.innerHTML = `
        <div class="ct-home-inner">
            <header class="ct-home-top">
                <div>
                    <p class="ct-home-hello">${escapeHtml(greeting())}, ${escapeHtml(userName)}</p>
                    <h1 class="ct-home-title">Welcome home</h1>
                    <div class="ct-home-stats">
                        <span class="ct-home-stat"><b>${characters.length}</b> characters</span>
                        <span class="ct-home-stat"><b>${state.worlds.length}</b> lorebooks</span>
                        <span class="ct-home-stat"><b>${personaEntries.length}</b> personas</span>
                        ${groups.length ? `<span class="ct-home-stat"><b>${groups.length}</b> groups</span>` : ''}
                    </div>
                </div>
                <div class="ct-home-actions">
                    <label class="ct-home-search">
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input type="search" name="ct-home-search" autocomplete="off" placeholder="Search characters, lorebooks…" aria-label="Search characters, lorebooks and personas" value="${escapeHtml(state.query)}">
                    </label>
                    ${firstRecent ? `<button type="button" class="ct-home-btn" data-action="recent" data-index="0"><i class="fa-solid fa-comment" aria-hidden="true"></i>Continue with ${escapeHtml(continueLabel)}</button>` : ''}
                    <button type="button" class="ct-home-btn is-ghost" data-action="new-character"><i class="fa-solid fa-plus" aria-hidden="true"></i>New character</button>
                </div>
            </header>

            ${recent.length && !state.query ? `
            <section class="ct-home-section" aria-labelledby="ct_home_recent">
                <div class="ct-home-head"><h2 class="ct-home-h2" id="ct_home_recent">Continue</h2></div>
                <div class="ct-home-recent">
                    ${recent.map(({ chat, character, group }, i) => `
                        <button type="button" class="ct-home-card" style="--i:${i}" data-action="recent" data-index="${i}">
                            <img src="${escapeHtml(character ? thumb('avatar', character.avatar) : (group?.avatar_url || 'img/five.png'))}" alt="" loading="lazy" width="44" height="44">
                            <span class="ct-home-recent-text">
                                <b><span>${escapeHtml(character?.name ?? group?.name)}</span><small>${escapeHtml(chat.date_short ?? '')}</small></b>
                                <em>${escapeHtml(plainSnippet(chat.mes))}</em>
                            </span>
                        </button>`).join('')}
                </div>
            </section>` : ''}

            <section class="ct-home-section" aria-labelledby="ct_home_chars">
                <div class="ct-home-head">
                    <h2 class="ct-home-h2" id="ct_home_chars">Characters<small>${sortedChars.length}</small></h2>
                    ${!state.query && sortedChars.length > PREVIEW_COUNT ? `<button type="button" class="ct-home-link" data-action="toggle-chars">${state.showAllChars ? 'Show fewer' : `Show all ${sortedChars.length}`}</button>` : ''}
                </div>
                ${visibleChars.length ? `<div class="ct-home-chars">
                    ${visibleChars.map(({ character, index }, i) => {
                        const tags = tagNames(context, character.avatar);
                        const sub = tags.slice(0, 2).join(' · ') || character.data?.creator || '';
                        return `
                        <button type="button" class="ct-home-card ct-home-char" style="--i:${i}" data-action="character" data-index="${index}" aria-label="Edit ${escapeHtml(character.name)}">
                            <span class="ct-home-char-img"><img src="${escapeHtml(thumb('avatar', character.avatar))}" alt="" loading="lazy"></span>
                            ${character.fav ? '<span class="ct-home-fav" title="Favorite"><i class="fa-solid fa-star" aria-hidden="true"></i></span>' : ''}
                            <span class="ct-home-char-cap"><b>${escapeHtml(character.name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
                        </button>`;
                    }).join('')}
                </div>` : `<p class="ct-home-empty">${state.query ? 'No character matches this search.' : 'No characters yet. Create or import one to get started.'}</p>`}
            </section>

            <section class="ct-home-section" aria-labelledby="ct_home_lore">
                <div class="ct-home-head">
                    <h2 class="ct-home-h2" id="ct_home_lore">Lorebooks<small>${lorebooks.length}</small></h2>
                    ${!state.query && lorebooks.length > PREVIEW_COUNT ? `<button type="button" class="ct-home-link" data-action="toggle-lore">${state.showAllLore ? 'Show fewer' : `Show all ${lorebooks.length}`}</button>` : ''}
                </div>
                ${visibleLore.length ? `<div class="ct-home-lore">
                    ${visibleLore.map((name, i) => {
                        const linked = linkedBy(name);
                        const isActive = state.activeWorlds.includes(name);
                        const sub = [isActive ? 'Active in every chat' : '', linked.length ? `Linked to ${linked.slice(0, 2).join(', ')}${linked.length > 2 ? ` +${linked.length - 2}` : ''}` : ''].filter(Boolean).join(' · ') || 'Lorebook';
                        return `
                        <button type="button" class="ct-home-card ct-home-lorebook" style="--i:${i};--h:${hueFor(name)}" data-action="lorebook" data-name="${escapeHtml(name)}" aria-label="Edit lorebook ${escapeHtml(name)}">
                            <span class="ct-home-lore-ico"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i></span>
                            <span class="ct-home-lore-text"><b>${escapeHtml(name)}</b><small>${escapeHtml(sub)}</small></span>
                        </button>`;
                    }).join('')}
                </div>` : `<p class="ct-home-empty">${state.query ? 'No lorebook matches this search.' : 'No lorebooks yet. Create one in the Lorebooks panel.'}</p>`}
            </section>

            ${people.length ? `
            <section class="ct-home-section" aria-labelledby="ct_home_people">
                <div class="ct-home-head"><h2 class="ct-home-h2" id="ct_home_people">Personas<small>${people.length}</small></h2></div>
                <div class="ct-home-people">
                    ${people.map(([file, name], i) => `
                        <button type="button" class="ct-home-card ct-home-person${context.userAvatar === file ? ' is-current' : ''}" style="--i:${i}" data-action="persona" data-file="${escapeHtml(file)}" aria-label="Edit persona ${escapeHtml(name)}">
                            <img src="${escapeHtml(thumb('persona', file))}" alt="" loading="lazy" width="36" height="36"><span>${escapeHtml(name)}</span>
                        </button>`).join('')}
                </div>
            </section>` : ''}

            ${groupList.length ? `
            <section class="ct-home-section" aria-labelledby="ct_home_groups">
                <div class="ct-home-head"><h2 class="ct-home-h2" id="ct_home_groups">Groups<small>${groupList.length}</small></h2></div>
                <div class="ct-home-people">
                    ${groupList.map((group, i) => `
                        <button type="button" class="ct-home-card ct-home-person" style="--i:${i}" data-action="group" data-id="${escapeHtml(group.id)}" aria-label="Open group ${escapeHtml(group.name)}">
                            <img src="${escapeHtml(group.avatar_url || (group.members?.[0] ? thumb('avatar', group.members[0]) : 'img/five.png'))}" alt="" loading="lazy" width="36" height="36"><span>${escapeHtml(group.name)}</span>
                        </button>`).join('')}
                </div>
            </section>` : ''}

            ${!state.query ? `
            <section class="ct-home-section" aria-labelledby="ct_home_tools">
                <div class="ct-home-head"><h2 class="ct-home-h2" id="ct_home_tools">Tools</h2></div>
                <div class="ct-home-tools">
                    ${TOOLS.filter(tool => (tool.open ? globalThis[tool.open] : document.getElementById(tool.drawer))).map((tool, i) => `
                        <button type="button" class="ct-home-card ct-home-tool" style="--i:${i}" data-action="tool" ${tool.open ? `data-open="${tool.open}"` : `data-drawer="${tool.drawer}"`}>
                            <i class="fa-solid ${tool.icon}" aria-hidden="true"></i><b>${escapeHtml(tool.name)}</b><small>${escapeHtml(tool.desc)}</small>
                        </button>`).join('')}
                </div>
            </section>` : ''}
        </div>`;

    root._ctRecent = recent;
}

/* ------------------------------------------------------------------------------------------- */
/* Actions                                                                                       */
/* ------------------------------------------------------------------------------------------- */

async function openCharacter(index) {
    const { selectCharacterById } = await import('../script.js');
    closeHome();
    await selectCharacterById(index);
    openDrawer('rightNavHolder');
}

async function openRecent(item) {
    if (!item) return;
    const context = ctx();
    const chatName = String(item.chat.chat_name ?? item.chat.file_name ?? '').replace(/\.jsonl$/i, '');
    closeHome();
    try {
        if (item.character) {
            const { selectCharacterById, openCharacterChat, getCurrentChatId } = await import('../script.js');
            const index = context.characters.findIndex(character => character.avatar === item.character.avatar);
            if (index < 0 || !(await selectCharacterById(index))) return;
            if (getCurrentChatId() !== chatName) await openCharacterChat(chatName);
        } else if (item.group) {
            const { openGroupById, openGroupChat } = await import('./group-chats.js');
            const { getCurrentChatId } = await import('../script.js');
            if (!(await openGroupById(item.group.id))) return;
            if (getCurrentChatId() !== chatName) await openGroupChat(item.group.id, chatName);
        }
    } catch (error) {
        console.error('[Classic Home] Could not open the chat:', error);
        globalThis.toastr?.error?.('Could not open that chat. See the console for details.');
    }
}

async function openLorebook(name) {
    const { openWorldInfoEditor } = await import('./world-info.js');
    closeHome();
    openWorldInfoEditor(name);
}

function openPersona(file) {
    closeHome();
    openDrawer('persona-management-button');
    // Highlight it without switching the active persona.
    setTimeout(() => {
        const card = [...document.querySelectorAll('#user_avatar_block [data-avatar-id]')].find(el => el.getAttribute('data-avatar-id') === file);
        if (!card) return;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('ct-flash');
        setTimeout(() => card.classList.remove('ct-flash'), 1800);
    }, 350);
}

async function openGroup(id) {
    const { openGroupById } = await import('./group-chats.js');
    closeHome();
    await openGroupById(id);
    openDrawer('rightNavHolder');
}

function newCharacter() {
    closeHome();
    openDrawer('rightNavHolder');
    setTimeout(() => document.getElementById('rm_button_create')?.click(), 250);
}

function bindHome(root) {
    root.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target).closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (action === 'character') void openCharacter(Number(target.dataset.index));
        else if (action === 'recent') void openRecent(root._ctRecent?.[Number(target.dataset.index)]);
        else if (action === 'lorebook') void openLorebook(target.dataset.name);
        else if (action === 'persona') openPersona(target.dataset.file);
        else if (action === 'group') void openGroup(target.dataset.id);
        else if (action === 'tool') { closeHome(); if (target.dataset.open) globalThis[target.dataset.open]?.open?.(); else openDrawer(target.dataset.drawer); }
        else if (action === 'new-character') newCharacter();
        else if (action === 'toggle-chars') { state.showAllChars = !state.showAllChars; render(); }
        else if (action === 'toggle-lore') { state.showAllLore = !state.showAllLore; render(); }
    });
    root.addEventListener('input', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.name !== 'ct-home-search') return;
        state.query = input.value.trim().toLowerCase();
        const caret = input.selectionStart;
        render();
        const again = /** @type {HTMLInputElement} */ (root.querySelector('input[name="ct-home-search"]'));
        again?.focus();
        if (again && caret !== null) again.setSelectionRange(caret, caret);
    });
}

function ensureHomeRoot() {
    let root = document.getElementById('ct-home');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'ct-home';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Home');
    document.body.append(root);
    bindHome(root);
    return root;
}

function setOpenState(open, { keepView = false } = {}) {
    state.open = open;
    if (open) setView('home');
    else if (!keepView && currentView === 'home') setView('chat');
    const button = document.getElementById('ct-home-button');
    button?.classList.toggle('is-open', open);
    button?.querySelector('.ct-home-toggle')?.setAttribute('aria-pressed', String(open));
    const icon = button?.querySelector('.drawer-icon');
    icon?.classList.toggle('openIcon', open);
    icon?.classList.toggle('closedIcon', !open);
    document.body.classList.toggle('ct-home-open', open);
    document.getElementById('ct-home')?.classList.toggle('is-open', open);
}

export async function openHome() {
    const root = ensureHomeRoot();
    // Close any open (unpinned) drawer so Home is not hidden behind it.
    for (const content of document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)')) {
        content.closest('.drawer')?.querySelector(':scope > .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    setOpenState(true);
    root.scrollTop = 0;
    render();
    await loadData();
    if (state.open) render();
}

export function closeHome(keepView = false) {
    if (state.open) setOpenState(false, { keepView });
}

export function toggleHome() {
    if (state.open) closeHome(); else void openHome();
}

function init() {
    ensureHomeButton();
    decorateRail();
    watchDrawers();
    bindDock();
    setView('chat');
    window.addEventListener('resize', () => { placeIndicator(); syncDock(); });
    const markReady = () => {
        if (viewsReady) return;
        viewsReady = true;
        // Panels SillyTavern reopens at start-up (pinned ones) stay hidden; the app starts on the chat.
        setView('chat');
    };
    const waitForApp = window.setInterval(() => {
        const context = ctx();
        if (context?.eventSource && context?.event_types) {
            window.clearInterval(waitForApp);
            context.eventSource.on(context.event_types.APP_READY, () => setTimeout(markReady, 300));
        }
    }, 100);
    setTimeout(markReady, 15000);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.open && !document.querySelector('.popup[open], dialog[open]')) closeHome();
    });
    // Opening any drawer from the top bar / sidebar while Home is up closes Home.
    document.getElementById('top-settings-holder')?.addEventListener('click', (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest('.drawer-toggle')) closeHome();
    });
    document.addEventListener('ct:appearance-changed', () => {
        if (state.open) render();
        requestAnimationFrame(() => setView(currentView));
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

globalThis.SillyBunnyClassicHome = { openHome, closeHome, toggleHome, showChat, setView, getView };
