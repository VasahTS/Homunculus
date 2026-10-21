# Credits

Homunculus is a personal fork. It stands on the work of the projects below. All of them are licensed under the AGPL-3.0, like Homunculus.

"Adapted code" means code from that project was ported into Homunculus. "Idea" means the feature was inspired by that project and written from scratch here.

## SillyTavern

https://github.com/SillyTavern/SillyTavern

The original frontend and the base of everything: chats, characters, lorebooks (World Info), presets and the Prompt Manager, personas, extensions, Vector Storage, and the data format that lets Homunculus open SillyTavern data.

## SillyBunny

https://github.com/SillyBunnyTeam/SillyBunny

The fork Homunculus is based on (v1.8.0):

- **In-Chat Agents and Companions**: the agent system, kept as it is. The Scene trackers are agents built on it.
- **Pathfinder** and **Prose Polisher** agents.
- **Conversation mode**.
- The launchers (`Start.bat`, `start.sh` and the others).

## Marinara Engine

https://github.com/Pasta-Devs/Marinara-Engine

- **Card Browser** (adapted code): the server routes that search and download cards from ChubAI, JannyAI, Wyvern, DataCat and Pygmalion, and the tag sidebar (the 150 most used tags, tick to require, "−" to hide).
- **Memory › Chapters** (idea): from Marinara's Chat Summary. Several summaries per chat, each switched on or off, placed at a chosen position and depth in the prompt, written automatically every N messages, with the option to hide summarized messages from the AI.
- **Memory › Recall** (idea): from Marinara's Memory Recall, finding old messages that match the current moment. Homunculus runs it on SillyTavern's Vector Storage instead, where the numbers can be adjusted.
- **Quick Connection** (idea): the connection and model switcher in the message box, with profiles on the left, models on the right, and pinned models. Built on SillyTavern's Connection Profiles.
- **Group settings** (idea): from Marinara's settings profiles. A group brings its own preset, persona, lorebooks and agents while its chat is open.
- **Story style** (idea): from Marinara's preset variables. Simple choices that also work as macros (`{{pov}}`, `{{tense}}`…).

## Aventuras

https://github.com/AventurasTeam/Aventuras

- **Scene tracker rules** (adapted from its prompts): the conservative rules of Aventuras's classifier. A character is tracked only with a proper name and a real interaction, an item only when someone takes or receives it, and quests are closed as completed or failed so they don't pile up.
- **State tied to each message** (idea): every tracker result is saved on the message that produced it, so swipes, regenerations, deletions and branches always show the right scene.
- **Scene panel layout** (idea): based on Aventuras's interface docs. A side list with filters, click to view and edit, appearance fields, character description and traits, and columns that never cover the chat.
- **Cast sheets** (adapted from its prompts): the card-import rules that strip instructions, "You are…" lines, OOC notes and formatting from a card. This is where the "Clean only" and "Condense" options come from.
- **Vault** (idea): Aventuras's scenario format (setting, NPCs, opening messages, start time, tags, lorebooks), and loading or saving a scenario when a story starts.
- **Director role** (adapted from its prompts): from the "Author vs. Protagonist" section of Aventuras's creative-writing prompt.

## Fonts

The fonts bundled with the visual profiles are under the SIL Open Font License:

- **Arcane Lantern**: Cormorant Garamond, Newsreader and Geist. See `public/classic-themes/lanterna-arcana/fonts/LICENSE.txt`.
- **Blood & Ink**: Syne, Spectral, IBM Plex Sans and IBM Plex Mono. See `public/classic-themes/blood-ink/fonts/LICENSE.txt`.

## License

Homunculus is distributed under the GNU Affero General Public License v3.0, like the projects above. If you share it or run it for other people, you must also share its source code and keep these credits.
