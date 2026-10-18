<p align="center"><img src="public/img/homunculus-logo.png" width="128" alt="Homunculus"></p>

<h1 align="center">Homunculus</h1>

<p align="center">Frontend pessoal para roleplay com IA, do Daniel.<br>
Baseado no <a href="https://github.com/SillyBunnyTeam/SillyBunny">SillyBunny</a> v1.8.0, que é um fork do <a href="https://github.com/SillyTavern/SillyTavern">SillyTavern</a>.</p>

## O que tem

- A interface clássica do SillyTavern, com os **Agents** e **Companions** do SillyBunny.
- **Customize:** perfis visuais (Classic, Arcane Lantern), layouts e efeitos que ligam e desligam.
- **Home:** conversas recentes, personagens, lorebooks, personas e atalhos num lugar só.
- **Memory:** capítulos (vários resumos por chat, com posição e profundidade no prompt) e Recall (busca por significado em mensagens antigas).
- **Card Browser:** busca e importa cards do ChubAI, JannyAI, Wyvern, DataCat e Pygmalion.
- **Quick Connection:** troca de conexão e de modelo direto da caixa de mensagem.
- Botões **"?"** explicando cada tela nova.

## Rodar

1. Baixe o projeto (botão **Code → Download ZIP** no GitHub, ou `git clone`).
2. Abra pelo `Start.bat` (Windows) ou `start.sh`.
3. Endereço: http://127.0.0.1:4444 (ou a porta configurada no `config.yaml`).

Seus personagens, chats e agentes ficam na pasta `data` (não vai para o GitHub). Ela é compatível com o SillyBunny e o SillyTavern.

Com `git clone`, o `Start.bat` atualiza sozinho a partir deste repositório ao abrir.

## Para quem for continuar o desenvolvimento

- Arquivos próprios do Homunculus: `public/scripts/classic-*.js`, `public/css/classic*.css`, `public/classic-themes/`, `src/endpoints/classic-card-browser.js` e `classic-ui/`.
- `classic-ui/apply-classic.mjs` liga essas peças no `public/index.html` e em alguns scripts; pode ser rodado de novo sem estragar nada.
- `classic-ui/TEMAS.md` explica como criar perfis visuais.
- O README original do SillyBunny está em `README-SillyBunny.md`.

## Créditos e licença

Veja [CREDITS.md](CREDITS.md). Licença: **AGPL-3.0**, a mesma do SillyTavern e do SillyBunny ([LICENSE](LICENSE)).
