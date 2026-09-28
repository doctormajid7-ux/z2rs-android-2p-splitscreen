# z2rs on Android

The Android build is the web frontend in a WebView — the same `index.html`,
the same `app.js`, the same wasm bundle — plus a small activity that serves
it, picks the ROM and holds the device upright while the portrait two-player
split is on.

Nothing here is a second implementation. The split, the doubled canvas and the
second touch pad are all the page's own (see `guide/co-op.md`, "The portrait
split"); this shell only gives them a place to run.

## Build

The site has to exist first, wasm bundle included:

```sh
# once per change to crates/z2-web (--features hd: the bundled HD pack needs it)
RUSTUP_TOOLCHAIN=stable wasm-pack build crates/z2-web --target web --out-dir site/pkg --features hd

cd android
JAVA_HOME=/path/to/a/jdk ./gradlew assembleDebug      # needs a JDK, not a JRE
```

The launcher reads **Zelda II 2P Splitscreen** (from `strings.xml`) and uses
the icon generated into `res/mipmap-*` from `icon1` at the repository root.

### The ROM in the APK

The APK ships **without** a cartridge: the page's Game ROM card is how a dump
gets in, and `MainActivity` keeps the file the player picked so the next
launch loads it by itself. To build one that does contain a dump (your own
device — never for publishing):

```sh
Z2_APK_ROM=/path/to/dump ./gradlew assembleDebug    # off/none/0/unset = none
```

Every candidate is checked for the iNES magic before it is copied, and
`MainActivity` serves it as `/_rom/zelda2.nes`, which `app.js` fetches on boot
(this origin only). A ROM picked later in the app still wins over it.

**An APK built this way carries the game — keep it on your own device.** The
ROM itself never enters the repository: `*.nes` and a zipped dump are
gitignored (`LEGAL.md` §1).

### HD graphics packs

The APK ships **without** a pack, and the wasm bundle is built with
`--features hd` so the HD card is live. **Use original art** takes the plain
graphics back.

On the shell's own origin that card shows **Pack folder on this device…**
rather than the page's stock `<input webkitdirectory>`: a WebView file chooser
returns bare file names with no directory, so `sheet-01.png` can never match
the `sheets/sheet-01.png` a pack's manifest asks for ("cannot read … not among
the provided files"). The button asks the shell for a real folder instead:
the page navigates to `z2rs://hd-pack`, `MainActivity` runs
`ACTION_OPEN_DOCUMENT_TREE`, and then serves that tree under `/_hdp/`, so
`_hdp/pack.json`, `_hdp/sheets/…` and `_hdp/layers/…` read back exactly like a
bundled pack. The grant is kept for the session (and asked to persist when the
provider allows it) — after a relaunch the folder has to be picked again.

Folding a pack into the APK is still possible, for builds where no picker can
reach one:

```sh
Z2_APK_HDPACK=/path/to/pack ./gradlew assembleDebug   # must hold pack.json
```

It is then copied to `src/main/assets/site/hdpack/` for that build. With the
variable unset, anything a previous build staged is removed, so a pack can
never ride along into a later APK by accident. Packs are personal-use art
(keep their `LICENSE.txt` with them) and stay out of the repository, like
everything else here.

`app/build.gradle` copies `crates/z2-web/site/{index.html,app.js,worklet.js,
assets/,pkg/}` into `src/main/assets/site/` on every build, and fails with the
command above when the bundle has not been built. The copy, Gradle's own
output and `local.properties` (the SDK path) are gitignored.

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`. Install it with
`adb install -r …`, or use `./gradlew installDebug` with a device attached.

## How it runs

* The site is served from `https://appassets.androidplatform.net/` by
  intercepting requests in `MainActivity` and reading the APK's assets. It is
  not loaded from `file://`: a file origin cannot instantiate wasm, and https
  also keeps IndexedDB (save states) and the audio worklet working. The
  `Content-Type` for `.wasm` is exactly `application/wasm` so it streams.
* **Choose ROM file…** opens the system document picker. The bytes go straight
  to the page (hash-gated there, as always) and a copy is kept in the app's
  private storage, so the next launch loads it by itself — the page fetches it
  back from `/_rom/zelda2.nes` on the same origin. Only a file starting with
  the iNES magic is kept, and the APK itself never contains a ROM.
* **Two players.** Tick "Local co-op" and the split comes on with it: the
  canvas doubles in height, the picture leaves the cabinet and pins itself
  over the screen, and a second controller appears in the top half, painted
  180° to face player 2. The activity polls `z2.ext.split.on()` every 250 ms
  and asks for portrait while it is on (and full sensor otherwise); the
  manifest's `configChanges` keeps the WebView — and the running game —
  across that rotation. `✕ 1 player` in the middle of the right edge turns
  two-player mode off again.
* `?split=0` in the URL refuses the split for a run, matching the desktop's
  `--split2p off` and the page's own checkbox.

## Not here yet

* No release signing (`signingConfig signingConfigs.debug`).
* Netplay works in principle — the page asks for the `netplay` feature bundle
  (`make run-web-net`) — but has not been tried on a device.
* Audio unlocks on the first touch of a pad, which is the page's own rule; if
  a device is still silent, check that nothing muted the media stream.
