# Como criar temas (perfis visuais) — SillyBunny Classic

Este guia explica como fazer um tema novo para a tela **Personalização** (ícone de paleta na barra do topo).
A primeira parte é para quem não programa. A última parte ("Para o Claude") traz os detalhes técnicos que uma
sessão futura do Claude precisa para criar ou mudar temas sem quebrar nada.

---

## 1. O que é um tema

Cada tema (a tela chama de **perfil**) junta três escolhas:

| Parte | O que muda | Exemplo no Lanterna Arcana |
|---|---|---|
| **Layout** | Onde ficam os menus | `classic`: barra de ícones no topo, igual ao SillyTavern |
| **Visual** | Cores, fontes, cantos, sombras | Fundo noite, texto creme, nomes em fonte serifada |
| **Efeitos** | Quais efeitos começam ligados | Os 7 ligados |

O usuário sempre pode ligar e desligar cada efeito, mudar a intensidade e escolher outra cor de destaque. O tema
só define **como começa**.

O perfil **Clássico** não muda nada: usa o tema escolhido em *User Settings › UI Theme*. Ele é o padrão e precisa
continuar existindo.

---

## 2. Onde os temas ficam

Há dois jeitos de ter um tema:

**A) Pasta dentro do programa (temas "de fábrica")**

```
public/classic-themes/
    index.json              ← lista gerada automaticamente (não edite à mão)
    classico/
        theme.json
    lanterna-arcana/
        theme.json          ← a ficha do tema (obrigatório)
        theme.css           ← ajustes visuais extras (opcional)
        fonts/              ← arquivos de fonte .woff2 (opcional)
            LICENSE.txt
```

**B) Um arquivo `.json` só, importado pela tela**

Na Personalização, botão **Importar perfil**. Bom para trocar temas entre computadores. O botão **Exportar** gera
esse arquivo a partir do tema em uso.

---

## 3. Criar um tema novo — passo a passo (jeito fácil)

1. Copie a pasta `public/classic-themes/lanterna-arcana` e dê outro nome à cópia. Use só letras minúsculas,
   números e hífen, por exemplo `floresta-encantada`.
2. Abra o `theme.json` da cópia num editor de texto (o Bloco de Notas serve).
3. Troque **`id`** pelo mesmo nome da pasta (`"floresta-encantada"`) e troque **`name`** e **`description`**.
4. Troque as cores em **`variables`** e em **`preview`** (veja a seção 5).
5. No `theme.css`, troque todas as vezes que aparece `ct-theme-lanterna-arcana` por `ct-theme-floresta-encantada`.
6. Feche o SillyBunny e dê dois cliques em **`Aplicar-Kit.bat`**. Ele coloca o tema novo na lista.
7. Abra o SillyBunny → ícone de paleta → escolha o tema novo.

Se algo estiver errado no `theme.json`, o `Aplicar-Kit.bat` avisa qual arquivo tem problema, e o tema não entra na
lista. Os outros temas continuam funcionando.

**Jeito mais fácil ainda:** peça ao Claude: *"Crie um tema novo para o SillyBunny Classic seguindo o
classic-ui/TEMAS.md. Ideia: …"*. Descreva o clima (cores, época, sensação) e diga quais efeitos quer ligados.

---

## 4. A ficha `theme.json`, campo por campo

```json
{
  "format": "classic-theme@1",
  "id": "floresta-encantada",
  "name": "Floresta Encantada",
  "description": "Verde-musgo, luz de vagalume e letras de livro antigo.",
  "author": "Daniel",
  "version": "1.0.0",
  "layout": "classic",
  "preview": {
    "background": "#0B120E",
    "text": "#E8F0DF",
    "displayFont": "'Cormorant Garamond', Georgia, serif",
    "colors": ["#B8E07A", "#67D4AE", "#E8C27A"],
    "orb": true
  },
  "variables": {
    "--SmartThemeBodyColor": "rgb(232, 240, 223)",
    "--SmartThemeQuoteColor": "rgb(184, 224, 122)"
  },
  "fonts": [
    { "family": "Cormorant Garamond", "src": "fonts/cormorant-garamond-latin-600-normal.woff2", "weight": "600", "style": "normal" }
  ],
  "stylesheet": "theme.css",
  "accents": ["#B8E07A", "#E8C27A", "#8AB8FF"],
  "storyFonts": [
    { "label": "Livro", "value": "'Newsreader', Georgia, serif" },
    { "label": "Moderna", "value": "'Geist', 'Noto Sans', sans-serif" }
  ],
  "effects": {
    "lantern": true, "halo": false, "shine": true, "motes": true,
    "aura": true, "blur": false, "glow": true
  }
}
```

| Campo | Obrigatório | Para que serve |
|---|---|---|
| `format` | sim | Sempre `"classic-theme@1"`. |
| `id` | sim | Nome interno. Igual ao nome da pasta. Minúsculas, números e hífen. |
| `name` | sim | Nome que aparece no cartão (até 40 letras). |
| `description` | não | Uma ou duas frases no cartão. |
| `author`, `version` | não | Só informação. |
| `layout` | não | Hoje só existe `"classic"`. Se ficar vazio, usa `"classic"`. |
| `preview` | não | Como o cartão do tema aparece na lista: cor de fundo, cor do "Aa", fonte do "Aa", até 5 bolinhas de cor e, com `orb: true`, uma lua brilhante com estrelas. |
| `variables` | não | As cores e fontes do programa (seção 5). |
| `fonts` | não | Fontes que vêm junto com o tema (seção 6). |
| `stylesheet` | não | Nome do arquivo CSS da pasta, normalmente `"theme.css"` (seção 7). |
| `css` | não | O mesmo que `stylesheet`, mas o texto CSS vai dentro do próprio JSON. Usado pelos temas importados/exportados. |
| `accents` | não | Opções de **cor de destaque** (até 8). A primeira é a padrão. Pinta os efeitos, o ícone aberto e o botão de enviar. |
| `storyFonts` | não | Opções de **fonte da história** (até 5). A primeira é a padrão. Sem este campo, a tela não mostra a escolha. |
| `effects` | não | Quais efeitos começam ligados (seção 8). O que faltar começa desligado. |

Cores podem ser escritas como `#E8C27A`, `rgb(232, 194, 122)` ou `rgba(13, 15, 19, 0.94)` (o último número é a
transparência: 1 é sólido, 0 é invisível).

---

## 5. Variáveis (as cores e fontes do programa)

O SillyTavern já pinta tudo usando algumas variáveis. Um tema só precisa trocar o valor delas.

| Variável | O que pinta |
|---|---|
| `--SmartThemeBodyColor` | Texto principal |
| `--SmartThemeEmColor` | Texto em itálico (ações do personagem) |
| `--SmartThemeQuoteColor` | Texto entre aspas (falas) |
| `--SmartThemeUnderlineColor` | Texto sublinhado |
| `--SmartThemeBlurTintColor` | Fundo das gavetas e da barra do topo |
| `--SmartThemeChatTintColor` | Fundo da área do chat |
| `--SmartThemeBotMesBlurTintColor` | Fundo das mensagens do personagem |
| `--SmartThemeUserMesBlurTintColor` | Fundo das suas mensagens |
| `--SmartThemeShadowColor` | Sombras |
| `--SmartThemeBorderColor` | Bordas finas |
| `--SmartThemeCheckboxBgColorR` / `G` / `B` | Cor das caixinhas marcadas (três números de 0 a 255) |
| `--mainFontFamily` | Fonte geral da interface |

Variáveis extras deste sistema de temas:

| Variável | O que faz |
|---|---|
| `--ct-display-font` | Fonte de títulos e nomes, se o `theme.css` usar |
| `--ct-glow-2` | Segunda cor dos efeitos (o lilás do halo e da aurora) |
| `--ct-accent` | **Não coloque aqui.** Vem de `accents` e da escolha do usuário. |
| `--ct-story-font` | **Não coloque aqui.** Vem de `storyFonts` e da escolha do usuário. |

Enquanto um tema com `variables` está em uso, ele manda nessas cores, por cima do *UI Theme*. Para voltar às cores
do *UI Theme*, escolha o perfil Clássico.

---

## 6. Fontes

- Use só fontes de **licença livre** (por exemplo, as do Google Fonts / Fontsource com licença SIL OFL).
- Coloque os arquivos `.woff2` na pasta `fonts/` do tema, junto com o texto da licença (`LICENSE.txt`).
- Liste cada arquivo em `fonts`: `family` é o nome que você vai usar no CSS; `weight` é a grossura (400 normal,
  600 negrito); `style` é `normal` ou `italic`.
- As fontes ficam dentro do programa, então funcionam **sem internet**.
- Prefira 2 famílias, no máximo 3 (uma para a história, uma para títulos e, se precisar, uma para a interface).

---

## 7. O arquivo `theme.css` (ajustes visuais)

Serve para o que as variáveis não alcançam: cantos arredondados, fonte dos nomes, sombras.

**Regras:**

1. **Toda regra começa com `body.ct-theme-<id>`.** Assim o tema nunca vaza para os outros perfis.
   ```css
   body.ct-theme-floresta-encantada .mes .name_text { font-family: var(--ct-display-font); }
   ```
2. **Não mude posições nem tamanhos das partes** (mover gaveta, esconder botão, mudar largura do chat). Isso é
   trabalho de *layout*, não de tema, e quebra quando o SillyBunny atualiza.
3. Use as variáveis em vez de repetir cores.
4. Não use `!important`, a não ser que não haja outro jeito.
5. Animações ficam com os efeitos (seção 8). O tema não cria animações próprias.

Partes do layout clássico que costumam receber ajuste:

| Seletor | O que é |
|---|---|
| `.mes_text` | Texto das mensagens |
| `.mes .name_text` | Nome em cima de cada mensagem |
| `.mes` | A caixa de cada mensagem |
| `#send_form` | A caixa onde você escreve |
| `#top-bar` | A barra do topo |
| `.drawer-content` | As gavetas que abrem pela barra do topo |
| `.drawer-content h3` | Título de cada gaveta |
| `.character_select`, `.group_select` | Cartões da lista de personagens |
| `.ch_name` | Nome nos cartões de personagem |
| `.menu_button` | Botões |
| `.text_pole`, `textarea`, `select` | Campos de texto e listas |
| `.drawer-icon.openIcon` | Ícone da gaveta que está aberta |

---

## 8. Efeitos

Os efeitos já existem no programa. O tema **só escolhe quais começam ligados**:

| Nome no `effects` | Na tela | O que faz |
|---|---|---|
| `lantern` | Lanterna | Uma luz suave segue o mouse |
| `halo` | Halo | Anel girando em volta do avatar da última resposta |
| `shine` | Reflexo | Brilho atravessa cartões e botões ao passar o mouse |
| `motes` | Poeira de estrelas | Partículas piscando e subindo no fundo |
| `aura` | Aurora | Nuvens de cor se movendo atrás do chat |
| `blur` | Entrada com desfoque | A mensagem nova aparece saindo de um desfoque |
| `glow` | Brilho nos botões | Contorno luminoso em botões, ícones e caixas marcadas |

Os efeitos usam a cor de destaque (`accents`) e a `--ct-glow-2`. Para um efeito **novo** (por exemplo, folhas
caindo) é preciso mexer no programa. Peça ao Claude e mostre a seção "Para o Claude".

---

## 9. Antes de usar: checklist

- [ ] `id` igual ao nome da pasta, só minúsculas, números e hífen.
- [ ] Todas as regras do `theme.css` começam com `body.ct-theme-<id>`.
- [ ] O texto é fácil de ler em cima do fundo (texto claro em fundo escuro, ou o contrário, nunca cinza em cinza).
- [ ] Falas, ações e nomes continuam diferentes entre si.
- [ ] Com todos os efeitos desligados o tema continua bonito.
- [ ] Rodou o `Aplicar-Kit.bat` depois de criar ou editar a pasta.
- [ ] Trocar para **Clássico** volta tudo ao normal.

---

## 10. Para o Claude (detalhes técnicos)

**Arquivos do sistema**

| Arquivo | Papel |
|---|---|
| `public/scripts/classic-themes.js` | Motor: lê os perfis, valida (`normalizeProfile`), aplica classes e variáveis no `<body>`, cria a camada de efeitos `#ct-fx-layer` e desenha a gaveta `#ct_personalize`. Guarda as escolhas em `extension_settings.classicThemes` (`active`, `reduceMotion`, `perProfile[id]` = `{effects, intensity, accent, storyFont}`, `custom[]` = perfis importados) e um cache em `localStorage['ct-theme-cache-v1']` para pintar antes das configurações carregarem. |
| `public/css/classic-themes.css` | Efeitos (todos atrás de `body.ct-fx-<id>`) e estilos da gaveta. Intensidade: `body.ct-k1/2/3` → `--ct-k`. Reduzir movimento: `body.ct-rm` + `prefers-reduced-motion`. |
| `public/classic-themes/<id>/` | Um tema por pasta. `index.json` é gerado por `classic-ui/apply-classic.mjs` (passo 10) com um hash `v` por pasta. Esse hash entra como `?v=` em `theme.json`, no CSS e nas fontes para furar o cache. |
| `classic-ui/apply-classic.mjs` | Passo 9: põe no `index.html` o `<link>` do CSS, o `<script>` do motor e a gaveta (antes de `#backgrounds-button`). Cada um é conferido separadamente, então roda em instalações antigas sem problema. Passo 10: gera `index.json`. |
| `classic-ui/Apply-Kit.ps1` / `Aplicar-Kit.bat` | Roda o apply e faz commit, para quem extraiu um kit novo ou criou uma pasta de tema. |

**Como o tema é aplicado**

- No `<body>`: classes `ct-theme-<id>`, `ct-k<1-3>`, `ct-fx-<efeito>` (uma por efeito ligado) e `ct-rm`.
- `variables` vira `body.style.setProperty(...)`. Fica no `<body>` de propósito: o SillyTavern escreve as cores do
  UI Theme no `<html>`, e o valor do `<body>` ganha para tudo dentro dele.
- `fonts` vira `<style id="ct-theme-fonts">` com `@font-face`. `stylesheet` vira `<link id="ct-theme-stylesheet">`,
  colocado antes de `css/user.css` para que o CSS próprio do usuário continue ganhando. `css` vira
  `<style id="ct-theme-inline">`.
- `normalizeProfile` descarta valores de variável com `; { } < >`, cores fora de `#hex/rgb/hsl` e fontes sem `src`.
  Campos desconhecidos são ignorados, então dá para acrescentar campos novos sem quebrar temas antigos.

**Para acrescentar um efeito novo**

1. Coloque `{ id, name, desc }` em `EFFECTS` (`classic-themes.js`) e uma miniatura em `DEMOS`.
2. Escreva o CSS em `classic-themes.css`, sempre atrás de `body.ct-fx-<id>`. Anime só `transform`/`opacity`.
   Acrescente o seletor no bloco `prefers-reduced-motion`.
3. Se precisar de elementos novos, crie-os em `ensureFxLayer()` (`pointer-events: none`, `aria-hidden`).
4. Atualize a tabela da seção 8.

**Para acrescentar um layout novo (ex.: "lanterna")**

O layout é a "casca" da interface, como `classic-ui.js` é hoje. Ele reorganiza os elementos do SillyTavern sem mudar
as funções. Já existe a entrada `lanterna` em `LAYOUTS` com `available: false`. Para ativar:

1. Faça um módulo próprio (ex.: `public/scripts/classic-layout-lanterna.js` + CSS) que só reposiciona/estiliza
   os elementos existentes. Mantenha a API `globalThis.SillyBunnyShell` que `classic-ui.js` oferece.
2. Carregue esse módulo só quando `extension_settings.classicThemes.layout === 'lanterna'`. Trocar de layout
   recarrega a página.
3. Marque `available: true` e faça o cartão de layout gravar a escolha e recarregar.
4. O perfil Clássico sempre usa `classic`. Teste os Agents, o editor de personagem e as gavetas nos dois layouts.

**Testar**

Use o `dev-tools.zip` (`ui.mjs` com Playwright). Depois de mexer, rode `node classic-ui/apply-classic.mjs`
duas vezes: a segunda precisa dizer `Already applied.`. Confira com `SillyBunnyClassicThemes.profiles` no console
e veja as classes `ct-*` no `<body>`.
