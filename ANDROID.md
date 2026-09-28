# Zelda II 2P Splitscreen — version Android

Zelda II (le portage *z2rs*) dans une application Android, avec l'écran scindé
à deux joueurs repris du « Portrait 2P » de Super Mario War. L'APK prêt à
installer est dans [`dist/`](dist/).

---

## Pour les joueurs

**Ce que c'est.** Le jeu tourne dans une fenêtre Web interne à l'application :
même émulateur, mêmes options que la version bureau, plus l'écran scindé.

**Installer.** Transférez `dist/z2rs-2p-splitscreen-0.1.0-debug.apk` sur le
téléphone (ou `adb install -r …`) et ouvrez-le. Android demandera d'autoriser
l'installation d'une source inconnue.

**La ROM.** Elle n'est pas fournie, ni dans l'APK, ni dans le dépôt : elle doit
venir de votre propre cartouche. Au premier lancement, la carte **Game ROM**
vous demande de choisir votre fichier `.nes`. Il est vérifié par empreinte
(le dump USA, CRC32 `BA322865`) et **reste sur votre appareil** : le lancement
suivant le rechargera tout seul, la carte affichant « ROM loaded ». Un fichier
refusé est signalé, avec l'empreinte attendue.

**Deux joueurs, un seul écran.** Cochez **Local co-op** : l'écran se coupe en
deux, la copie du haut est retournée, et un second pad apparaît en haut — les
deux joueurs se font face. Le téléphone reste en portrait tant que le mode est
actif. Le bouton **✕ 1 player**, au milieu du bord droit, revient au jeu seul.

**Régler les manettes.** **Pad ↑** et **Pad ↓** (carte Player) déplacent les
deux pads en même temps, chacun s'écartant de son bord : utile pour une coque
épaisse, un coin arrondi ou une barre de gestes. Un cran = 5 % de la hauteur
d'écran, jusqu'à 30 %, et le réglage est mémorisé. **Hide touch pad** les
masque complètement.

**Le son.** Il se met en route au premier toucher d'un pad (ou avec **Enable
audio**). Sur cette version il reste actif même quand la ROM est en cours de
lecture — un défaut d'émulation le coupait définitivement sur les appareils à
48 kHz, c'est corrigé.

**Graphismes HD (facultatif).** Si vous possédez un pack HD, ouvrez la carte
**HD graphics pack**, touchez **Pack folder on this device…** et choisissez le
dossier qui contient `pack.json` (le pack peut être laissé sur la carte SD).
**Use original art** rend les graphismes d'origine. Le pack se recharge à
chaque lancement : rien n'est copié dans l'application.

**Nom et icône.** L'application s'appelle « Zelda II 2P Splitscreen » et porte
l'icône fournie dans `icon1`.

### Ce qui est nouveau dans cette version

- Mode 2 joueurs **écran scindé inversé** (portrait, haut retourné, second pad
  tactile, verrouillage portrait) — disponible aussi sur bureau, où il peut
  être refusé avec `--split2p off`.
- **Son réparé** : le basculement de fréquence 44 100 → 48 000 Hz silenciait
  définitivement la sortie sur de nombreux téléphones.
- **Graphismes HD** activés dans l'application, avec choix du dossier du pack
  et retour aux graphismes d'origine.
- **Déplacement des contrôles** (Pad ↑ / Pad ↓) en plus de Hide touch pad.
- La carte ROM dit maintenant ce qui s'est passé (« ROM loaded » / « ROM
  rejected ») au lieu d'annoncer « No ROM is provided » à jamais.
- Ordre des cartes : **Status** avant **Player**.
- Le **double-tap** ne passe plus en plein écran (bouton Fullscreen et F11
  restent).
- La ROM n'est plus embarquée dans l'APK, et l'application s'appelle
  « Zelda II 2P Splitscreen » avec sa propre icône.

---

## Détails techniques

Pour les utilisateurs avancés, et pour les assistants qui reprennent ce dépôt.

### Architecture

Le shell Android **réutilise le frontend web** : aucun second émulateur. Le
contenu de `crates/z2-web/site/` (page, `app.js`, worklet audio, `pkg/` wasm)
est copié dans les assets de l'APK et servi depuis
`https://appassets.androidplatform.net/` par interception de requêtes dans
`MainActivity` — pas de `file://`, qui ne peut ni instancier du wasm ni garder
IndexedDB ou l'`AudioWorklet`. Le `Content-Type` de `.wasm` est exactement
`application/wasm`, sinon `instantiateStreaming` échoue.

C'est la seule politique que le shell possède en propre, avec l'orientation :
le reste (split, canvas doublé, second pad) appartient à la page.

| route | sert |
|---|---|
| `/*` | assets de l'APK (`assets/site/…`) |
| `/_rom/zelda2.nes` | la ROM choisie, dans le stockage privé de l'app (repli sur un asset si un build en a embarqué une) |
| `/_hdp/…` | l'arbre du dossier de pack HD choisi, résolu par nom de document |

### ROM et pack HD : jamais dans le dépôt, jamais dans l'APK par défaut

`app/build.gradle` a trois tâches, accrochées à `preBuild` **et** aux tâches
`merge*Assets` (sinon un `assembleDebug` peut empaqueter un `assets/` pris
avant qu'elles n'écrivent) :

- `prepareSite` : copie `index.html`, `app.js`, `worklet.js`, `assets/`, `pkg/`
  vers `src/main/assets/site/` ; échoue avec la commande à lancer si le bundle
  wasm manque.
- `stageRom` : n'embarque une ROM **que** si `Z2_APK_ROM=/chemin/dump` est
  défini (sinon toute copie d'un build précédent est supprimée).
- `stageHdPack` : n'embarque un pack **que** si `Z2_APK_HDPACK=/chemin/pack`
  est défini (dossier avec `pack.json`).

`.gitignore` couvre `*.nes`, les archives `*Zelda*.zip`, `/z2rs-hd-pack*/`, les
archives du pack et `/android/app/src/main/assets/site/` : ni la ROM ni l'art
du pack n'entrent dans l'historique (`LEGAL.md` §1). L'APK publié dans
`dist/` ne contient ni l'une ni l'autre — le pack HD Patreon est sous licence
d'usage personnel, il ne doit pas être redistribué.

### Écran scindé (mode 2 joueurs)

- Cœur : `crates/z2-ppu/src/split2p.rs` — `height_multiplier`, `out_len`,
  `duplicate_rotated`, `duplicate_rotated_in_place`. La trame est présentée
  `W × 2H`, la copie du haut tournée de 180°.
- Frontend natif : `DisplaySettings::split_2p`, mémoire doublée dans
  `Display::present`, drapeau `--split2p on|off`, clé de config `split_2p`
  (défaut vrai en coop local, refusé en ligne).
- Frontend web : `WebEmu::split_2p` + `split_2p_enable()` / `split_2p_enabled()`,
  appliqué après `render_single_frame()` ; `frame_height()` / `logical_height()`
  suivent le multiplicateur.
- Page : `applySplit()` = split demandé **et** coop locale **et** pas de
  session réseau ; classe `#room.split2p` (la vitre TV quitte le meuble 4:3 et
  se fixe plein écran), `#touchpad2` peint en haut avec
  `transform: rotate(180deg)`, inversion des coordonnées dans `dpadBits()` et
  attribution des pointeurs par `pointerId`.
- Orientation : `MainActivity` interroge `z2.ext.split.on()` toutes les 250 ms
  et demande `SCREEN_ORIENTATION_PORTRAIT` quand le split est actif, sinon
  `FULL_SENSOR` ; `configChanges` dans le manifeste évite de recréer la
  WebView (donc de tuer le jeu) à la rotation.
- Refus : `?split=0` dans l'URL, ou la case « Portrait split ».

### Contrôles tactiles

`makeTouchPad(root, { rotated, liftsAudio })` construit un pad par joueur ;
les bits sont OU-exés dans `pollInput()` / `pollInputP2()`, donc le tactile
pilote exactement ce que pilote le clavier, en coop comme en réseau.

`Pad ↑` / `Pad ↓` règlent une variable CSS `--pad-shift` (en `vh`, 0–30 par pas
de 5) appliquée à `#touchpad` en `translateY(calc(-1 * var(--pad-shift)))` et à
`#touchpad2` **avant** sa rotation
(`rotate(180deg) translateY(calc(-1 * var(--pad-shift)))`, ce qui la fait
descendre du même montant) ; la hauteur de `#touchSpacer` grandit d'autant.
Mémorisé dans `localStorage['z2rs.padShift']`, exposé à la QA par
`z2.ext.touch.padShift(vh)` et `z2.ext.touch.padShiftVh()`.

### Son (correctif important)

`Apu::set_sample_rate` recalculait la marque du resampler à partir du nombre
total de cycles : au passage 44 100 → 48 000 Hz (ce que fait le premier toucher
quand l'`AudioContext` du téléphone tourne à 48 kHz), la boucle d'émission
rattrapait d'un coup le retard accumulé et émettait un échantillon avec
l'accumulateur vide — `0.0 / 0.0` = `NaN`, `NaN` stocké dans l'état du filtre
passe-haut, **silence numérique définitif** (`peak: 0` côté worklet). Le
correctif re-base `samples_emitted` sur la nouvelle marque et garde la division
par zéro. Test de régression :
`title_music_survives_a_mid_game_rate_switch` (auto-sauté sans `Z2_ROM`).

### Pack HD à l'écran, sans dossier accessible

Un WebView ne sait pas faire `webkitdirectory` : son sélecteur rend des noms de
fichiers nus, donc `sheet-01.png` ne peut jamais correspondre au
`sheets/sheet-01.png` du manifeste (« cannot read … not among the provided
files »). Sur l'origine de l'app, la page masque donc le sélecteur d'origine et
affiche **Pack folder on this device…** : elle navigue vers `z2rs://hd-pack`,
`MainActivity` ouvre `ACTION_OPEN_DOCUMENT_TREE` et monte l'arbre sous `/_hdp/`
(descente par nom via `DocumentsContract`). La page attend `_hdp/pack.json`,
lit les fichiers que le manifeste nomme, et charge le pack par le même chemin
wasm que le bureau (`hd_pack_begin` / `hd_pack_add_file` / `hd_pack_commit`).
Ailleurs (site hébergé, bureau) le sélecteur de dossier d'origine reste tel
quel.

### Construire

```sh
# bundle web, HD compris : obligatoire pour que la carte « HD graphics pack »
# soit active (--features hd)
RUSTUP_TOOLCHAIN=stable wasm-pack build crates/z2-web --target web --out-dir site/pkg --features hd

cd android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew assembleDebug   # JDK, pas JRE
```

`minSdk 24`, `targetSdk 35`, `applicationId org.z2rs.app`, aucune dépendance
externe (ni AndroidX) : uniquement les API `android.*` et la WebView de la
plateforme. L'APK sort dans `android/app/build/outputs/apk/debug/`.

Pour republier : copier l'APK dans `dist/` (nom `z2rs-2p-splitscreen-<version>-debug.apk`),
`.gitignore` autorise explicitement `dist/*.apk`.

Empreinte de l'APK publié :

```
f5d9e5f749f2ba782e72d90ce5f8def9e7c2b6ecc2599d1bf8b271cdf104d4ed
z2rs-2p-splitscreen-0.1.0-debug.apk  866 004 octets  (SHA-256)
```

### Tests et état connu

- `cargo +stable test --workspace` : tout passe, sauf
  `perf_reports_speed_with_regression_floor` (`z2-verify/tests/oracle_tetanes.rs`),
  un plancher de performance en **debug** (0,7× au lieu de 1× sur une machine
  chargée) — sans rapport avec ce travail, `z2-verify` ne dépend pas de
  `z2-apu`/`z2-web`, et ce test ne s'exécutait pas avant faute de `Z2_ROM`.
- `cargo +stable fmt --all --check` : propre. `clippy` sur `z2-apu`/`z2-web` :
  propre ; les six avertissements restants viennent de la lint
  `chunks_exact_to_as_chunks` (clippy 1.98) dans des fichiers non touchés.
- Le grant du dossier de pack est demandé persistant mais le montage est par
  session : après relance, il faut rechoisir le dossier.
