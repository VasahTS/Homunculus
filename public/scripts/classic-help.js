// Classic UI fork: the small "?" buttons used by the fork's own features (Quick Connection,
// Card Browser, Memory). Clicking one opens a short card that explains the feature in plain words.
// Clicking outside the card, pressing Escape or clicking the "?" again closes it.

let openCard = null;
let openButton = null;

function closeHelp() {
    openCard?.remove();
    openButton?.classList.remove('ct-help-active');
    openCard = null;
    openButton = null;
}

function placeCard(card, button) {
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(340, window.innerWidth - margin * 2);
    card.style.width = `${width}px`;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    card.style.left = `${left}px`;
    const height = card.offsetHeight;
    const below = rect.bottom + margin;
    const top = below + height > window.innerHeight - margin ? Math.max(margin, rect.top - height - margin) : below;
    card.style.top = `${top}px`;
}

/**
 * Opens the help card for a "?" button.
 * @param {HTMLElement} button The "?" button that was clicked
 * @param {string} title Card title
 * @param {string} html Card body (trusted, written by us)
 */
export function showHelp(button, title, html) {
    const same = openButton === button;
    closeHelp();
    if (same) return;
    const card = document.createElement('div');
    card.className = 'ct-help-card';
    card.setAttribute('role', 'dialog');
    card.innerHTML = `<div class="ct-help-title"><i class="fa-solid fa-circle-question"></i><span></span></div><div class="ct-help-body">${html}</div>`;
    card.querySelector('.ct-help-title span').textContent = title;
    document.body.append(card);
    placeCard(card, button);
    button.classList.add('ct-help-active');
    openCard = card;
    openButton = button;
}

/**
 * Creates a "?" button that explains a feature.
 * @param {string} title Card title
 * @param {string} html Card body (trusted, written by us)
 * @returns {HTMLButtonElement}
 */
export function helpButton(title, html) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ct-help';
    button.title = `What is "${title}"?`;
    button.setAttribute('aria-label', `Help: ${title}`);
    button.textContent = '?';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showHelp(button, title, html);
    });
    return button;
}

document.addEventListener('pointerdown', (event) => {
    if (!openCard) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (openCard.contains(target) || openButton?.contains(target)) return;
    closeHelp();
}, true);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openCard) {
        event.stopPropagation();
        closeHelp();
    }
}, true);
window.addEventListener('resize', closeHelp);

export { closeHelp };
