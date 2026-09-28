# Zelda II 2P Splitscreen — Android

Zelda II (the *z2rs* port) as an Android app, with the portrait two-player split
screen borrowed from the "Portrait 2P" mode of Super Mario War. This fork ships
**the Android app**: the installable APK is attached to the
[latest release](https://github.com/doctormajid7-ux/z2rs-android-2p-splitscreen/releases/latest)
and kept in [`dist/`](dist/).

---

## For players

**What this is.** The game runs in a web view inside the app: the same emulator
and the same options as the desktop build, plus the split screen and on-screen
controls built for a phone.

**Install.** Download
[`z2rs-2p-splitscreen-0.1.0-debug.apk`](https://github.com/doctormajid7-ux/z2rs-android-2p-splitscreen/releases/latest/download/z2rs-2p-splitscreen-0.1.0-debug.apk)
on the phone (or `adb install -r …`) and open it. Android will ask you to allow
installation from an unknown source. It runs on Android 7.0 (API 24) and up.

**The ROM.** It is not supplied, neither in the APK nor in this repository: it
has to come from your own cartridge. On the first launch the **Game ROM** card
asks you to pick your `.nes` file. It is checked by hash (the USA dump, CRC32
`BA322865`) and **stays on your device**: the next launch reloads it by itself
and the card reads "ROM loaded". A rejected file is reported, with the hash the
app expects.

**Two players, one screen.** Tick **Local co-op**: the screen is cut in two, the
top copy is turned upside down, and a second pad appears at the top — the two
players face each other. The phone stays in portrait while the mode is on. The
**✕ 1 player** button, halfway down the right edge, takes you back to playing
alone.

**Adjusting the pads.** **Pad ↑** and **Pad ↓** (Player card) move both pads at
once, each one pulling away from its own edge: useful for a thick case, a rounded
corner or a gesture bar. One step is 5% of the screen height, up to 30%, and the
setting is remembered. **Hide touch pad** hides them entirely.

**Sound.** It starts on the first touch of a pad (or with **Enable audio**). On
this version it also keeps running while a ROM is being loaded — an emulation
bug used to cut the output for good on 48 kHz devices, and that is fixed.

**HD graphics (optional).** If you own an HD pack, open the **HD graphics pack**
card, tap **Pack folder on this device…** and pick the folder that holds
`pack.json` (the pack can stay on the SD card). **Use original art** gives you
the original graphics back. The pack is reloaded on every launch: nothing is
copied into the app.

**Name and icon.** The app is called "Zelda II 2P Splitscreen" and carries its
own icon, taken from `icon1`.

### What is new in this version

- Two-player **mirrored split screen** (portrait, top half upside down, a second
  touch pad, orientation locked) — also available on desktop, where it can be
  turned off with `--split2p off`.
- **Sound fixed**: the 44,100 → 48,000 Hz sample-rate switch used to silence the
  output for good on many phones.
- **HD graphics enabled** in the app, with a pack-folder picker and a way back to
  the original art.
- **Moving the controls** (Pad ↑ / Pad ↓) on top of Hide touch pad.
- The ROM card now says what happened ("ROM loaded" / "ROM rejected") instead of
  claiming "No ROM is provided" forever.
- Card order: **Status** before **Player**.
- **Double-tap** no longer toggles fullscreen (the Fullscreen button and `F11`
  still do).
- The ROM is no longer embedded in the APK.

---

## Technical details

For advanced users, and for assistants picking this repository up.

### Architecture

The Android shell **reuses the web frontend**: there is no second emulator. The
contents of `crates/z2-web/site/` (the page, `app.js`, the audio worklet,
`pkg/` wasm) are copied into the APK assets and served from
`https://appassets.androidplatform.net/` by intercepting requests in
`MainActivity` — not from `file://`, which can neither instantiate wasm nor keep
IndexedDB or an `AudioWorklet`. The `Content-Type` of `.wasm` is exactly
`application/wasm`, otherwise `instantiateStreaming` fails.

That request policy and the orientation are the only things the shell owns: the
split, the doubled canvas and the second pad all belong to the page.

| route | serves |
|---|---|
| `/*` | the APK assets (`assets/site/…`) |
| `/_rom/zelda2.nes` | the chosen ROM, in the app's private storage (falling back to an asset if a build embedded one) |
| `/_hdp/…` | the tree of the chosen HD pack folder, resolved by document name |

### ROM and HD pack: never in the repository, never in the APK by default

`app/build.gradle` has three tasks, hooked to `preBuild` **and** to the
`merge*Assets` tasks (otherwise an `assembleDebug` can package an `assets/`
directory taken before they wrote to it):

- `prepareSite`: copies `index.html`, `app.js`, `worklet.js`, `assets/` and
  `pkg/` into `src/main/assets/site/`; fails with the command to run if the wasm
  bundle is missing.
- `stageRom`: embeds a ROM **only** when `Z2_APK_ROM=/path/to/dump` is set
  (otherwise any copy left behind by a previous build is deleted).
- `stageHdPack`: embeds a pack **only** when `Z2_APK_HDPACK=/path/to/pack` is set
  (a folder with `pack.json`).

`.gitignore` covers `*.nes`, `*Zelda*.zip` archives, `/z2rs-hd-pack*/`, the pack
archives and `/android/app/src/main/assets/site/`: neither the ROM nor the pack
art ever enters the history (`LEGAL.md` §1). The APK published in `dist/`
contains neither — the Patreon HD pack is licensed for personal use and must not
be redistributed.

### Split screen (two-player mode)

- Core: `crates/z2-ppu/src/split2p.rs` — `height_multiplier`, `out_len`,
  `duplicate_rotated`, `duplicate_rotated_in_place`. The frame is presented
  `W × 2H`, with the top copy rotated 180°.
- Native frontend: `DisplaySettings::split_2p`, doubled memory in
  `Display::present`, the `--split2p on|off` flag, the `split_2p` config key
  (true by default in local co-op, refused online).
- Web frontend: `WebEmu::split_2p` plus `split_2p_enable()` /
  `split_2p_enabled()`, applied after `render_single_frame()`; `frame_height()`
  and `logical_height()` follow the multiplier.
- Page: `applySplit()` = split wanted **and** local co-op **and** no network
  session; the `#room.split2p` class (the TV pane leaves the 4:3 cabinet and
  fixes itself fullscreen), `#touchpad2` painted at the top with
  `transform: rotate(180deg)`, coordinates inverted in `dpadBits()` and pointers
  assigned by `pointerId`.
- Orientation: `MainActivity` polls `z2.ext.split.on()` every 250 ms and asks for
  `SCREEN_ORIENTATION_PORTRAIT` while the split is on, `FULL_SENSOR` otherwise;
  `configChanges` in the manifest keeps the WebView from being recreated (and so
  the game from being killed) on rotation.
- Turning it off: `?split=0` in the URL, or the "Portrait split" checkbox.

### Touch controls

`makeTouchPad(root, { rotated, liftsAudio })` builds one pad per player; the bits
are OR-ed into `pollInput()` / `pollInputP2()`, so touch drives exactly what the
keyboard drives, in local co-op as well as online.

`Pad ↑` / `Pad ↓` set a `--pad-shift` CSS variable (in `vh`, 0–30 in steps of 5),
applied to `#touchpad` as `translateY(calc(-1 * var(--pad-shift)))` and to
`#touchpad2` **before** its rotation
(`rotate(180deg) translateY(calc(-1 * var(--pad-shift)))`, which moves it down by
the same amount); `#touchSpacer` grows by the same amount. Stored in
`localStorage['z2rs.padShift']` and exposed to QA as `z2.ext.touch.padShift(vh)`
and `z2.ext.touch.padShiftVh()`.

### Sound (the fix that mattered)

`Apu::set_sample_rate` recomputed the resampler's mark from the total cycle
count: on the 44,100 → 48,000 Hz switch (what the first touch triggers when the
phone's `AudioContext` runs at 48 kHz) the emit loop caught up the accumulated
lag in one go and emitted a sample with an empty accumulator — `0.0 / 0.0` =
`NaN`, `NaN` stored in the high-pass filter state, **permanent digital silence**
(`peak: 0` on the worklet side). The fix rebases `samples_emitted` on the new
mark and guards the division by zero. Regression test:
`title_music_survives_a_mid_game_rate_switch` (skips itself without `Z2_ROM`).

### HD pack on screen, with no reachable folder

A WebView cannot do `webkitdirectory`: its picker hands back bare file names, so
`sheet-01.png` can never match the `sheets/sheet-01.png` the manifest asks for
("cannot read … not among the provided files"). On the app's own origin the page
therefore hides the original picker and shows **Pack folder on this device…**:
it navigates to `z2rs://hd-pack`, `MainActivity` opens
`ACTION_OPEN_DOCUMENT_TREE` and mounts the tree under `/_hdp/` (descending by
name through `DocumentsContract`). The page waits for `_hdp/pack.json`, reads the
files the manifest names, and loads the pack through the same wasm path as the
desktop (`hd_pack_begin` / `hd_pack_add_file` / `hd_pack_commit`). Everywhere
else (hosted site, desktop) the original folder picker is untouched.

### Building

```sh
# web bundle, HD included: required for the "HD graphics pack" card to be live
# (--features hd)
RUSTUP_TOOLCHAIN=stable wasm-pack build crates/z2-web --target web --out-dir site/pkg --features hd

cd android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew assembleDebug   # a JDK, not a JRE
```

`minSdk 24`, `targetSdk 35`, `applicationId org.z2rs.app`, no external
dependencies (not even AndroidX): only the `android.*` APIs and the platform
WebView. The APK lands in `android/app/build/outputs/apk/debug/`.

To republish: copy the APK into `dist/` as
`z2rs-2p-splitscreen-<version>-debug.apk` (`.gitignore` explicitly allows
`dist/*.apk`) and attach it to a release.

Hash of the published APK:

```text
f5d9e5f749f2ba782e72d90ce5f8def9e7c2b6ecc2599d1bf8b271cdf104d4ed
z2rs-2p-splitscreen-0.1.0-debug.apk  866004 bytes  (SHA-256)
```

### Tests and known state

- `cargo +stable test --workspace`: everything passes except
  `perf_reports_speed_with_regression_floor` (`z2-verify/tests/oracle_tetanes.rs`),
  a **debug** performance floor (0.7x instead of 1x on a loaded machine). It is
  unrelated to this work — `z2-verify` depends on neither `z2-apu` nor `z2-web`,
  and that test did not even run before, for lack of `Z2_ROM`.
- `cargo +stable fmt --all --check`: clean. `clippy` on `z2-apu` / `z2-web`:
  clean; the six warnings that remain come from the `chunks_exact_to_as_chunks`
  lint (clippy 1.98) in files this work did not touch.
- The HD pack folder grant is requested as persistent, but the mount is per
  session: after a restart the folder has to be picked again.
