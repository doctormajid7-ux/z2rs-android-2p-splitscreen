// z2rs web frontend glue — vanilla ES module, zero npm dependencies.
//
// Wiring: ./pkg/z2_web.js must exist (see site/README "Build") unless the
// page's #z2-config names another release (readConfig below). This module
// owns the DOM, canvas, IndexedDB, keyboard/Gamepad and AudioContext; the
// wasm side (crates/z2-web/src/lib.rs) owns emulation and only exchanges
// bytes, strings and numbers.
//
// Hosting: `make run-web` serves this file unbundled, straight to the
// browser. A hosting page may add an optional #z2-config element.
//
// Shared input contract (bits 0..7): A,B,Select,Start,Up,Down,Left,Right.
// Keyboard P1: Z=A, X=B, Shift=Select, Enter=Start, arrows=d-pad.
// Keyboard P2 (local co-op): G=A, F=B, R=Select, T=Start, W/A/S/D=d-pad.
// Gamepad (standard mapping): button 1=A, button 0=B, 8=Select, 9=Start,
//   d-pad 12..15 or left stick.
//
// NOTE: Z/X used to be swapped relative to the native app. They now MATCH it
// (Z=A, X=B) so the two frontends share one muscle memory and a native host can
// play with a web guest; the key table in index.html and the README say the same.

const NTSC_HZ = 60.0988;
const FRAME = 1 / NTSC_HZ;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const screen = $('screen');
const ctx = screen.getContext('2d');

// --- scene art ----------------------------------------------------------------
// The page's stylesheet is inlined into documents served from different paths
// (the vanilla site at its root, the deployment at /), so it cannot name the
// art with a relative url(). Resolve it against this module, like the worklet,
// and hand it over as custom properties on #room plus the <img data-art> icons.
const room = $('room');
{
  const art = (f) => new URL(`./assets/${f}`, import.meta.url).href;
  if (room) {
    room.style.setProperty('--art-hero', `url("${art('hero.webp')}")`);
    room.style.setProperty('--art-desk', `url("${art('desk.webp')}")`);
    room.style.setProperty('--art-bg', `url("${art('room-blur.webp')}")`);
  }
  for (const img of document.querySelectorAll('img[data-art]')) img.src = art(img.dataset.art);
}

// The framebuffer is runtime-sized: widescreen widens it and an HD pack or a
// scale above 1 multiplies it, so W/H/img are re-derived from the emulator
// instead of being module constants. NEVER assume 256x240 anywhere.
let W = 256;
let H = 240;
let img = ctx.createImageData(W, H);
let zoom = 2;              // integer NES-pixel zoom used for the CSS width
const ZOOM_MIN = 1, ZOOM_MAX = 4;
// z2-signal on the DigitalOcean droplet behind Caddy (README.md).
const PUBLIC_SIGNAL_URL = 'wss://signal.z2rs.com';

// Re-read the emulator's frame size and resize the canvas to match. Safe to
// call every frame; it only touches the DOM when something actually changed.
//
// Two sizes are in play and must not be confused:
//   * backing store  (screen.width/height)  = emu.frame_width()/frame_height(),
//     i.e. NES pixels TIMES the HD output scale — what putImageData needs;
//   * CSS size (--css-w) = the LOGICAL width times `zoom`, so a 4x pack shows a
//     sharper picture at the same physical size instead of a huge one.
// `max-width: 100%` in the stylesheet still wins on a narrow screen, and
// `height: auto` keeps the aspect ratio there.
function syncCanvas() {
  if (!emu) return;
  const w = emu.frame_width(), h = emu.frame_height();
  if (w !== W || h !== H) {
    W = w; H = h;
    screen.width = W;
    screen.height = H;
    img = ctx.createImageData(W, H);
  }
  const cssW = emu.logical_width() * zoom;
  const want = `${cssW}px`;
  if (screen.style.getPropertyValue('--css-w') !== want) {
    screen.style.setProperty('--css-w', want);
    screen.style.aspectRatio = `${emu.logical_width()} / ${emu.logical_height()}`;
  }
}

function setZoom(z) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z | 0));
  syncCanvas();
}

// --- host configuration -----------------------------------------------------
// A page may carry <script id="z2-config" type="application/json">…</script>
// (a hosting page may render one; the vanilla index.html has none):
//   { wasm:  { js, wasm },          // URLs of the glue module and the binary
//     notes: [ … ] }                // lines to append to Status at boot
// Everything is optional. With no element the page loads ./pkg/z2_web.js next
// to this file. The ROM always comes from the player's own drop: no host
// serves one.
const CONFIG = readConfig();
function readConfig() {
  const cfg = { wasm: null, notes: [] };
  const el = document.getElementById('z2-config');
  if (!el) return cfg;
  try {
    const raw = JSON.parse(el.textContent || '{}');
    if (raw.wasm && typeof raw.wasm.js === 'string') {
      cfg.wasm = { js: raw.wasm.js, wasm: typeof raw.wasm.wasm === 'string' ? raw.wasm.wasm : null };
    }
    if (Array.isArray(raw.notes)) cfg.notes = raw.notes.filter((n) => typeof n === 'string');
  } catch (e) {
    cfg.notes.push(`host config ignored: ${e}`);
  }
  return cfg;
}

let WebEmu = null;
let emu = null;
let running = false; // ROM loaded and loop armed
let paused = false;
let romLoadT0 = 0;
let firstFrameLogged = false;
let coopOn = false;      // local two-player co-op
// Portrait two-player split: the frame is presented twice, the upper copy
// turned through 180°, so the two players sit at opposite ends of a portrait
// screen and each sees it the right way up. It follows local co-op (an online
// peer has a screen of their own), and `?split=0` or the checkbox refuses it.
let splitWanted = true;
let splitOn = false;      // what the wasm side is actually doing right now
let netActive = false;   // an online session exists
let netLastT = 0;        // performance.now() of the previous net tick
// QA only (`z2.ext.net.manual`): the rAF loop stops pumping the session so a
// test script can drive net_poll/net_step itself with frame-exact pads. A human
// never sets this; the panel has no control for it. See site/README.
let netManual = false;

// --- status ---------------------------------------------------------------
let statusNote = '';
function setStatus(extra = '') {
  if (!emu) { statusEl.textContent = `wasm ready — drop a ROM. ${extra}`; return; }
  const st = JSON.parse(emu.state());
  const replay = st.movieLen > 0 ? `REPLAY ${st.movieCursor}/${st.movieLen}` : 'live input';
  statusEl.textContent =
    `frame ${st.frame} · ROM ${st.crc32 || '(none)'} · ${replay} · ` +
    `${audioStatus()} · ${paused ? 'PAUSED' : 'running'}${statusNote}${extra}`;
}

// `audio off` until the button is pressed; then the context state, the
// worklet's queue depth (the delay behind the picture) and how often it ran
// dry.
function audioStatus() {
  if (!actx) return 'audio off';
  if (actx.state !== 'running') return `audio ${actx.state}`;
  const ms = Math.round((audioReport.queued * 1000) / actx.sampleRate);
  return `audio on (${ms} ms buffered, ${audioReport.underruns} underruns)`;
}

// --- wasm boot ------------------------------------------------------------
// The glue module comes from CONFIG.wasm (a host pointing at an uploaded
// release) or, by default, from ./pkg/ next to this file (the vanilla site,
// `make run-web`). The binary's URL is passed explicitly when the host names
// one; otherwise the glue resolves z2_web_bg.wasm beside itself.
async function boot() {
  const jsUrl = CONFIG.wasm ? CONFIG.wasm.js : './pkg/z2_web.js';
  try {
    const pkg = await import(jsUrl);
    if (typeof pkg.default !== 'function') {
      throw new Error('the module loaded but is empty or is not a wasm-pack bundle (no init export)');
    }
    await pkg.default(CONFIG.wasm && CONFIG.wasm.wasm ? { module_or_path: CONFIG.wasm.wasm } : undefined);
    WebEmu = pkg.WebEmu;
  } catch (e) {
    statusEl.textContent = CONFIG.wasm
      ? `wasm release failed to load (${jsUrl}).\n${e}`
      : `wasm bundle missing (./pkg/z2_web.js). Build it first — see site/README "Build".\n${e}`;
    if (CONFIG.notes.length) statusEl.textContent += `\n${CONFIG.notes.join('\n')}`;
    return;
  }
  emu = new WebEmu();
  publishZ2();
  applyUrlParams();
  loadShellRom(); // no-op unless this is the Android shell
  setStatus();
  $('pauseBtn').disabled = true;
  $('netStatus').textContent = netStatusLine(JSON.parse(emu.net_state()));
  if (!$('netIce').value) $('netIce').value = emu.net_default_ice();
  if (!emu.net_supported()) $('netBox').classList.add('unsupported');
  syncNetButtons();
  syncHdPanel();
  statusEl.textContent += `\nz2-web ${emu.version()} ready — drop a Zelda II (USA) .nes file.`;
  if (CONFIG.notes.length) statusEl.textContent += `\n${CONFIG.notes.join('\n')}`;
}

// `?widescreen=16:9` (or `?wide=`) and `?coop=1` so a QA run or a bookmark can
// arrive with the features already on. A bad value is reported and ignored —
// never fatal, and appended after the existing status text because smoke.mjs
// reads #status for readiness.
function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  const wide = q.get('widescreen') ?? q.get('wide');
  if (wide) {
    try {
      emu.set_widescreen_preset(wide);
      $('wideSel').value = emu.widescreen_tiles() === 0 ? 'off' : wide;
      syncCanvas();
    } catch (e) {
      statusNote += `\nwidescreen '${wide}' rejected: ${e}`;
    }
  }
  // `?clip=0` turns off painting the window's blanked left 8 columns,
  // `?rclip=0` the masked right 8. Both default on.
  const clip = q.get('clip');
  if (clip !== null) {
    const on = !(clip === '0' || clip === 'false');
    $('clipChk').checked = on;
    try { emu.set_fill_left_clip(on); syncCanvas(); }
    catch (e) { statusNote += `\nfill left edge: ${e}`; }
  }
  // `?widegame=0` keeps enemies at the original screen edge in widescreen
  // (wide gameplay, default on; it only acts while widescreen is on).
  const widegame = q.get('widegame');
  if (widegame !== null) setWideGameplay(!(widegame === '0' || widegame === 'false'));
  const rclip = q.get('rclip');
  if (rclip !== null) {
    const on = !(rclip === '0' || rclip === 'false');
    $('rclipChk').checked = on;
    try { emu.set_fill_right_clip(on); syncCanvas(); }
    catch (e) { statusNote += `\nfill right edge: ${e}`; }
  }
  // `?msprites=0` keeps side-view objects out of the margins (default on).
  const msprites = q.get('msprites');
  if (msprites !== null) {
    const on = !(msprites === '0' || msprites === 'false');
    $('mspritesChk').checked = on;
    try { emu.set_margin_sprites(on); syncCanvas(); }
    catch (e) { statusNote += `\nobjects in margins: ${e}`; }
  }
  // `?scale=2` picks the HD output multiplier (above 1 needs an `hd` bundle).
  const scale = q.get('scale');
  if (scale) {
    try {
      emu.set_output_scale(Number(scale) >>> 0);
      $('hdScale').value = String(emu.requested_scale());
      syncCanvas();
    } catch (e) {
      statusNote += `\nscale '${scale}' rejected: ${e}`;
    }
  }
  // `?zoom=3` changes the on-screen size only (CSS pixels per NES pixel).
  const z = q.get('zoom');
  if (z) setZoom(Number(z));
  // An https page cannot reach a plain ws:// server, so the hosted site defaults
  // to the public signal server; local http runs keep ws://localhost:3536.
  if (location.protocol === 'https:') $('netSignal').value = PUBLIC_SIGNAL_URL;
  // Netplay panel prefill: `?net=lockstep` (default rollback), `?signal=`,
  // `?room=`, `?ice=` (e.g. `none`), `?delay=`. Nothing connects by itself.
  const net = q.get('net');
  if (net !== null) {
    if (net === 'rollback' || net === 'lockstep') $('netMode').value = net;
    else statusNote += `\nnet mode '${net}' rejected (rollback or lockstep)`;
  }
  for (const [param, id] of [['signal', 'netSignal'], ['room', 'netRoom'], ['ice', 'netIce']]) {
    const v = q.get(param);
    if (v !== null) $(id).value = v;
  }
  const delay = q.get('delay');
  if (delay !== null && [...$('netDelay').options].some((o) => o.value === delay)) $('netDelay').value = delay;
  syncNetMode();
  // `?split=0` opts out of the portrait two-player split (default on, and it
  // only ever acts alongside local co-op). Read before `?coop=1` so a single
  // URL can arrive with co-op on and the split refused.
  const sp = q.get('split');
  if (sp !== null) splitWanted = !(sp === '0' || sp === 'false');
  $('splitChk').checked = splitWanted;
  applySplit();
  const coop = q.get('coop');
  if (coop === '1' || coop === 'true') setCoop(true);
}

// --- window.z2 QA contract ----------------------------------------
// The 9 stable members are unchanged byte-for-byte: { facts, state, input,
// step, snapshot, restore, loadMovie, screenshot, version }. Backed by
// Game::facts + the Z2WEB01/Z2SNAP01 codec + the .fm2/Input-Log parsers.
//
// Everything added for widescreen / co-op / netplay lives under `z2.ext`,
// which is explicitly NOT part of the stable QA contract (see site/README).
function publishZ2() {
  window.z2 = {
    facts: () => emu.facts(),
    state: () => emu.state(),
    input: (mask = 0, frames = 1) => emu.hold_input(mask >>> 0, frames >>> 0),
    step: (n = 1) => emu.step_movie_or_idle(n >>> 0),
    snapshot: () => emu.snapshot(),
    restore: (bytes) => emu.restore(bytes),
    loadMovie: (text) => emu.load_movie(text),
    screenshot: () => { blit(); return screen.toDataURL('image/png'); },
    version: emu.version(),
    ext: {
      // widescreen
      // Keeps the on-screen control in step with the emulator, so a QA script
      // and a human never disagree about what is selected.
      setWide: (preset) => {
        emu.set_widescreen_preset(String(preset));
        const sel = $('wideSel');
        const want = emu.widescreen_tiles() === 0 ? 'off' : String(preset);
        if ([...sel.options].some((o) => o.value === want)) sel.value = want;
        syncCanvas();
        syncHdPanel();
        return emu.widescreen_tiles();
      },
      wideTiles: () => emu.widescreen_tiles(),
      frameSize: () => ({
        width: emu.frame_width(),
        height: emu.frame_height(),
        logicalWidth: emu.logical_width(),
        logicalHeight: emu.logical_height(),
        scale: emu.output_scale(),
      }),
      setFillLeftClip: (on) => {
        emu.set_fill_left_clip(!!on);
        $('clipChk').checked = emu.fill_left_clip();
        syncCanvas();
        return emu.fill_left_clip();
      },
      setFillRightClip: (on) => {
        emu.set_fill_right_clip(!!on);
        $('rclipChk').checked = emu.fill_right_clip();
        syncCanvas();
        return emu.fill_right_clip();
      },
      setMarginSprites: (on) => {
        emu.set_margin_sprites(!!on);
        $('mspritesChk').checked = emu.margin_sprites();
        syncCanvas();
        return emu.margin_sprites();
      },
      // Wide gameplay: enemies spawn and live in the margins (changes
      // gameplay; acts only while widescreen is on). Returns the margin in
      // tiles now in effect (0 = off).
      setWideGameplay: (on) => { setWideGameplay(!!on); return emu.wide_gameplay_tiles(); },
      wideGameplayTiles: () => emu.wide_gameplay_tiles(),
      setZoom: (z) => { setZoom(Number(z)); return zoom; },
      // HD graphics packs
      hd: {
        supported: () => emu.hd_supported(),
        // files: [{ name, bytes: Uint8Array }] — the same wasm path the folder
        // picker uses, so a QA script and a human load packs identically.
        loadPack: (files) => loadHdFiles(files),
        clearPack: () => { emu.hd_pack_clear(); syncCanvas(); syncHdPanel(); return true; },
        packInfo: () => emu.hd_pack_info(),
        setScale: (n) => { emu.set_output_scale(Number(n) >>> 0); syncCanvas(); syncHdPanel(); return emu.output_scale(); },
        scale: () => emu.output_scale(),
      },
      // local co-op
      // audio: what the AudioWorklet last reported, for QA (`peak` > 0 means
      // non-silent samples actually reached the output; `queued` over `rate`
      // is how far the sound trails the picture).
      audio: () => ({
        state: actx ? actx.state : 'off',
        rate: actx ? actx.sampleRate : emu.audio_rate(),
        ...audioReport,
      }),
      coopEnable: (on) => { setCoop(!!on); return emu.coop_enabled(); },
      coopEnabled: () => emu.coop_enabled(),
      coopStatus: () => emu.coop_status(),
      coopHash: () => emu.coop_hash_hex(),
      stepCoop: (p1, p2, n = 1) => emu.step_frames2(p1 >>> 0, p2 >>> 0, n >>> 0),
      // online co-op
      net: {
        supported: () => emu.net_supported(),
        connect: (signal, room, host, delay = 2, ice = emu.net_default_ice()) =>
          emu.net_connect(String(signal), String(room), !!host, delay >>> 0, String(ice)),
        // Protocol for the next session: 'rollback' (default) or 'lockstep',
        // plus the rollback prediction window. Keeps the panel selector in step.
        setMode: (mode, maxPrediction = JSON.parse(emu.net_mode()).defaultMaxPrediction) => {
          emu.net_set_mode(String(mode), maxPrediction >>> 0);
          $('netMode').value = String(mode);
          return JSON.parse(emu.net_mode());
        },
        mode: () => JSON.parse(emu.net_mode()),
        // TEST HOOK, off by default and never used by normal play: delay every
        // packet this page sends by latencyMs + rand(0..jitterMs) of session
        // time and drop lossPct % of unreliable packets, inside the page's
        // transport wrapper. `simulate({})` turns it off again.
        simulate: ({ latencyMs = 0, jitterMs = 0, lossPct = 0 } = {}) =>
          JSON.parse(emu.net_simulate(latencyMs >>> 0, jitterMs >>> 0, Math.min(100, lossPct >>> 0))),
        // Rollback: [[frame, hash], ...] for every 15th saved state that is final.
        confirmedHashes: () => emu.net_confirmed_hashes(),
        status: () => emu.net_state(),
        // Also repaints the status line, so a QA script driving the session by
        // hand leaves the same text on screen the rAF loop would have.
        poll: (dtMs = 0) => {
          const json = emu.net_poll(dtMs >>> 0);
          $('netStatus').textContent = netStatusLine(JSON.parse(json));
          return json;
        },
        disconnect: () => endNetSession('netplay: left the session'),
        // The desync hash the two peers compare (16 hex chars). Two peers that
        // report the same value at the same session frame are in lockstep by
        // the protocol's own definition — this is what site/netplay-e2e.mjs
        // asserts instead of eyeballing screenshots.
        stateHash: () => emu.net_state_hash_hex(),
        // --- QA driving hooks -------------------------------------------------
        // `manual(true)` stops the rAF loop pumping the session so a test can
        // supply frame-exact pads through `step()` below; `manual(false)` hands
        // the session back to live keyboard/gamepad input. No UI control sets
        // this and nothing in the page turns it on by itself.
        manual: (on) => { netManual = !!on; return netManual; },
        isManual: () => netManual,
        // One session tick under `manual(true)`: latch a local pad and step up
        // to `max` confirmed frames. Returns frames stepped (0 = still waiting
        // for the peer's input). `pad` null/undefined samples the LIVE
        // keyboard + gamepad through the same `pollInput()` the rAF loop uses,
        // so a test can hold a real key and still advance frame by frame.
        step: (pad = null, max = 1) =>
          emu.net_step(pad === null || pad === undefined ? pollInput() : pad >>> 0, max >>> 0),
      },
      // On-screen controller: show/hide it, and read the pad byte it
      // contributes. `mask2` is player 2's, which only exists while the split
      // is on.
      touch: {
        show: (on) => { showTouchPad(!!on); return !pad1.root.hidden; },
        shown: () => !pad1.root.hidden,
        mask: () => touchMask(),
        mask2: () => pad2.mask(),
        // How far the controllers are lifted off their edges, in vh.
        padShift: (vh) => applyPadShift(Number(vh)),
        padShiftVh: () => padShift,
      },
      // The portrait two-player split (wasm flag, canvas height, pad 2).
      split: {
        wanted: () => splitWanted,
        on: () => splitOn,
        set: (on) => { splitWanted = !!on; $('splitChk').checked = splitWanted; applySplit(); return splitOn; },
      },
      trapsetId: () => emu.trapset_id_hex(),
      // Rollback cost probes, timed here with performance.now(). Leaves the
      // game where it was. Refused during a netplay session.
      perf: {
        rollback: (opts = {}) => rollbackPerf(opts),
      },
    },
  };
}

// `z2.ext.perf.rollback({ iterations, depths })`: one emulated frame, one
// save, one load, and a worst-case rollback tick per depth (load, re-simulate
// `depth` frames silently, save + simulate the new frame, checksum, render).
function rollbackPerf({ iterations = 120, depths = [0, 4, 8] } = {}) {
  const n = Math.max(1, iterations >>> 0);
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      mean: s.reduce((a, b) => a + b, 0) / s.length,
      p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
      max: s[s.length - 1],
    };
  };
  const time = (fn) => {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn(i);
      xs.push(performance.now() - t0);
    }
    return stats(xs);
  };
  emu.perf_begin();
  try {
    const out = { iterations: n, tick: {} };
    // Warm up so the first measured call does not pay for lazy work.
    for (let i = 0; i < 10; i++) { emu.perf_load(0); emu.perf_step(0, 0, false); emu.perf_save(1); }
    out.frame = time(() => emu.perf_step(0, 0, true));
    emu.perf_load(0);
    // A save or load is far below the timer's resolution (browsers clamp
    // performance.now() to 0.1 ms or coarser), so each sample times a batch.
    const BATCH = 500;
    const per = (s) => ({ mean: s.mean / BATCH, p95: s.p95 / BATCH, max: s.max / BATCH });
    out.save = per(time(() => { for (let k = 0; k < BATCH; k++) emu.perf_save(1); }));
    out.load = per(time(() => { for (let k = 0; k < BATCH; k++) emu.perf_load(0); }));
    for (const d of depths) out.tick[d >>> 0] = time(() => emu.perf_tick(d >>> 0));
    return out;
  } finally {
    emu.perf_end();
  }
}

// --- input ----------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
// A key held while the window loses focus never delivers its keyup here
// (clicking across to the other netplay-play window, say), so it would stay
// pressed until it was pressed and released again in this window. Release
// everything on blur instead.
addEventListener('blur', () => { keys.clear(); touchRelease(); });

// Player 1: Z=A, X=B (matches the native app).
function keyboardMask() {
  let m = 0;
  if (keys.has('KeyZ')) m |= 1 << 0;
  if (keys.has('KeyX')) m |= 1 << 1;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) m |= 1 << 2;
  if (keys.has('Enter')) m |= 1 << 3;
  if (keys.has('ArrowUp')) m |= 1 << 4;
  if (keys.has('ArrowDown')) m |= 1 << 5;
  if (keys.has('ArrowLeft')) m |= 1 << 6;
  if (keys.has('ArrowRight')) m |= 1 << 7;
  return m;
}

// Player 2: the same layout the native app's `keys_p2` default uses, so the
// two frontends document one set of co-op keys.
function keyboardMaskP2() {
  let m = 0;
  if (keys.has('KeyG')) m |= 1 << 0;
  if (keys.has('KeyF')) m |= 1 << 1;
  if (keys.has('KeyR')) m |= 1 << 2;
  if (keys.has('KeyT')) m |= 1 << 3;
  if (keys.has('KeyW')) m |= 1 << 4;
  if (keys.has('KeyS')) m |= 1 << 5;
  if (keys.has('KeyA')) m |= 1 << 6;
  if (keys.has('KeyD')) m |= 1 << 7;
  return m;
}

function padBits(gp) {
  let m = 0;
  const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  if (b(1)) m |= 1 << 0; // right button -> A
  if (b(0)) m |= 1 << 1; // bottom button -> B
  if (b(8)) m |= 1 << 2;
  if (b(9)) m |= 1 << 3;
  if (b(12)) m |= 1 << 4;
  if (b(13)) m |= 1 << 5;
  if (b(14)) m |= 1 << 6;
  if (b(15)) m |= 1 << 7;
  const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
  if (ay < -0.4) m |= 1 << 4;
  if (ay > 0.4) m |= 1 << 5;
  if (ax < -0.4) m |= 1 << 6;
  if (ax > 0.4) m |= 1 << 7;
  return m;
}

// `navigator.getGamepads()` returns a sparse array: disconnected slots are null
// and the indices are NOT compacted, so "gamepad 0 and 1" is wrong. Take the
// connected pads in index order instead.
function connectedPads() {
  const out = [];
  for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
    if (gp && gp.connected) out.push(gp);
  }
  return out;
}

// With co-op off, every pad is OR-ed (unchanged behaviour). With co-op on the
// first connected pad is player 1 and the second is player 2.
function gamepadMask(player = 0) {
  const pads = connectedPads();
  if (!coopOn) return pads.reduce((m, gp) => m | padBits(gp), 0);
  const gp = pads[player];
  return gp ? padBits(gp) : 0;
}

const pollInput = () => keyboardMask() | gamepadMask(0) | pad1.mask();
const pollInputP2 = () => keyboardMaskP2() | gamepadMask(1) | pad2.mask();

// --- touch gamepads (on-screen controllers) ----------------------------------
// One controller per player. #touchpad is player 1's: a d-pad, Select/Start
// and B/A floating over the bottom of the viewport. #touchpad2 is player 2's,
// and only exists while the portrait two-player split is on — it fills the
// TOP half of the screen, painted turned through 180°, which is what makes it
// upright for the player sitting at that end of the device.
// Every finger is tracked by pointer id and re-hit-tested as it moves, so a
// thumb can roll from B onto A or slide round the d-pad without lifting.
// A finger that started on the d-pad keeps steering even after it drifts off
// the disc. The bits are OR-ed into pollInput()/pollInputP2(), so the overlays
// drive exactly what the keyboard drives: local play, co-op and netplay.
const TOUCH_UP = 1 << 4, TOUCH_DOWN = 1 << 5, TOUCH_LEFT = 1 << 6, TOUCH_RIGHT = 1 << 7;
const TOUCH_DEAD = 0.2; // d-pad dead zone, as a fraction of its radius
// Eight ways, clockwise from east (atan2 has +y pointing down the screen).
const TOUCH_OCTANTS = [TOUCH_RIGHT, TOUCH_RIGHT | TOUCH_DOWN, TOUCH_DOWN, TOUCH_DOWN | TOUCH_LEFT,
  TOUCH_LEFT, TOUCH_LEFT | TOUCH_UP, TOUCH_UP, TOUCH_UP | TOUCH_RIGHT];

function makeTouchPad(root, { rotated = false, liftsAudio = false } = {}) {
  const dpad = root.querySelector('.tp-dpad');
  const pointers = new Map(); // pointerId -> { bits, dpad }

  function mask() {
    let m = 0;
    for (const p of pointers.values()) m |= p.bits;
    return m;
  }

  function dpadBits(x, y) {
    const r = dpad.getBoundingClientRect();
    let dx = (x - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (y - (r.top + r.height / 2)) / (r.height / 2);
    // Player 2's pad is painted turned through 180°, so the direction shown
    // at (dx, dy) is the one the player means inverted. Turn it back before
    // the octant lookup; the bounding box is unchanged by a half turn.
    if (rotated) { dx = -dx; dy = -dy; }
    if (Math.hypot(dx, dy) < TOUCH_DEAD) return 0;
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    return TOUCH_OCTANTS[(oct + 8) % 8];
  }

  function bitsAt(p, x, y) {
    if (p.dpad) return dpadBits(x, y);
    // Hit-testing follows CSS transforms, so a rotated pad answers for the
    // element the finger is actually on.
    const el = document.elementFromPoint(x, y);
    const btn = el && el.closest && root.contains(el) ? el.closest('[data-pad]') : null;
    return btn ? Number(btn.dataset.pad) : 0;
  }

  function paint() {
    const m = mask();
    for (const b of root.querySelectorAll('[data-pad]')) b.classList.toggle('on', (m & Number(b.dataset.pad)) !== 0);
    dpad.classList.toggle('up', (m & TOUCH_UP) !== 0);
    dpad.classList.toggle('down', (m & TOUCH_DOWN) !== 0);
    dpad.classList.toggle('left', (m & TOUCH_LEFT) !== 0);
    dpad.classList.toggle('right', (m & TOUCH_RIGHT) !== 0);
  }

  function release() {
    pointers.clear();
    paint();
  }

  root.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no focus, no text selection, no long-press menu
    const p = { bits: 0, dpad: !!(e.target.closest && e.target.closest('.tp-dpad')) };
    p.bits = bitsAt(p, e.clientX, e.clientY);
    pointers.set(e.pointerId, p);
    // Keep getting this finger's moves after it slides off the control.
    try { e.target.setPointerCapture(e.pointerId); } catch { /* synthetic pointer: nothing to capture */ }
    paint();
  });
  root.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const bits = bitsAt(p, e.clientX, e.clientY);
    if (bits !== p.bits) { p.bits = bits; paint(); }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    root.addEventListener(type, (e) => {
      if (!pointers.delete(e.pointerId)) return;
      paint();
      // Lifting a finger is a user gesture (pressing one down is not, for
      // touch), so this is where a phone gets its sound without hunting for
      // the button.
      if (liftsAudio && type === 'pointerup' && !actx && !$('audioBtn').disabled) $('audioBtn').click();
    });
  }
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  return { root, mask, release, paint };
}

const pad1 = makeTouchPad($('touchpad'), { liftsAudio: true });
const pad2 = makeTouchPad($('touchpad2'), { rotated: true, liftsAudio: true });

// What the on-screen controller contributes to player 1 (the QA surface
// `z2.ext.touch.mask()`); pad2's byte goes to player 2 only.
function touchMask() {
  return pad1.mask();
}

function touchRelease() {
  pad1.release();
  pad2.release();
}

// Shown by default where touch is the main way in; `?touch=1` / `?touch=0` and
// the Touch pad button override that either way.
function touchWanted() {
  const q = new URLSearchParams(location.search).get('touch');
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;
  return matchMedia('(pointer: coarse)').matches;
}

function showTouchPad(on) {
  pad1.root.hidden = !on;
  $('touchSpacer').hidden = !on;
  // Player 2's controller belongs to the portrait split: it only appears
  // while both the touch pad and the split are in play.
  pad2.root.hidden = !(on && splitOn);
  $('touchBtn').textContent = on ? 'Hide touch pad' : 'Touch pad';
  if (!on) touchRelease();
}
$('touchBtn').addEventListener('click', () => showTouchPad(pad1.root.hidden));
showTouchPad(touchWanted());

// --- lifting the controller off the edge ------------------------------------
// The pads sit against the screen edges, which is where a thumb rests — but
// not every phone agrees: a case, a rounded corner, a gesture bar or a
// different grip can put the d-pad somewhere useless. Two buttons move both
// pads at once, each away from its own edge (player 2's pad is painted upside
// down, so the same `--pad-shift` lands the same distance from the top). The
// offset is a share of the viewport height, so it means the same thing in
// portrait and landscape, and the choice is kept per device.
const PAD_SHIFT_STEP = 5;  // vh per press
const PAD_SHIFT_MAX = 30;  // past this the two splits would meet in the middle
let padShift = 0;

function applyPadShift(vh) {
  padShift = Number.isFinite(vh) ? Math.min(PAD_SHIFT_MAX, Math.max(0, Math.round(vh))) : 0;
  document.documentElement.style.setProperty('--pad-shift', `${padShift}vh`);
  $('padUp').disabled = padShift >= PAD_SHIFT_MAX;
  $('padDown').disabled = padShift <= 0;
  try { localStorage.setItem('z2rs.padShift', String(padShift)); } catch { /* no storage */ }
  return padShift;
}

$('padUp').addEventListener('click', () => applyPadShift(padShift + PAD_SHIFT_STEP));
$('padDown').addEventListener('click', () => applyPadShift(padShift - PAD_SHIFT_STEP));
{
  let remembered = 0;
  try { remembered = Number(localStorage.getItem('z2rs.padShift')); } catch { /* no storage */ }
  applyPadShift(remembered);
}

// --- frame loop (rAF accumulator @ NTSC_HZ) --------------------------------
let lastT = 0;
let acc = 0;
let fpsFrames = 0;
let fpsT0 = 0;
let fps = 0;

function blit() {
  emu.render_frame();
  // The frame can change width (widescreen toggled), so make sure the
  // ImageData matches before copying into it.
  syncCanvas();
  img.data.set(emu.frame_rgba());
  ctx.putImageData(img, 0, 0);
}

// Ordinary single-page stepping: movie replay, local co-op or one player.
function stepLocal(n) {
  const st = JSON.parse(emu.state());
  if (st.movieLen > 0 && st.movieCursor < st.movieLen) {
    emu.step_movie_or_idle(n); // deterministic replay while a movie is armed
  } else if (coopOn) {
    emu.step_frames2(pollInput(), pollInputP2(), n);
  } else {
    emu.step_frames(pollInput(), n);
  }
}

function loop(t) {
  requestAnimationFrame(loop);
  if (!running || paused || !emu.rom_loaded()) return;
  if (!lastT) lastT = t;
  let dt = (t - lastT) / 1000;
  lastT = t;
  if (dt > 0.5) dt = 0.5; // tab was backgrounded: no spiral of death
  acc += dt / FRAME;
  let n = Math.floor(acc);
  acc -= n;
  if (n > 5) { n = 5; acc = 0; } // catch-up cap: slow down instead of spiralling
  if (n <= 0 && !netActive) return;
  if (netActive && netManual) {
    // A QA script owns net_poll/net_step this tick (z2.ext.net.manual(true)),
    // so the loop must not latch a pad of its own — it would race the script's
    // frame-exact sequence. Keep painting what the script has stepped.
    blit();
    return;
  }
  if (netActive) {
    // One session tick: pump the transport, then step only the frames the
    // session has confirmed. `pollInput()` is sampled once per tick and reused
    // for each stepped frame — the same semantics the live path already had.
    // Until the session has started (signal server, waiting for the other
    // player, peer link, handshake) the local game keeps running as usual:
    // `Started` restarts both peers from power-on anyway, so nothing played
    // here can leak into the session, and a slow connection never looks like
    // a hung page.
    const now = performance.now();
    const dtMs = netLastT ? Math.min(1000, now - netLastT) : 0;
    netLastT = now;
    let ns;
    try {
      ns = JSON.parse(emu.net_poll(dtMs));
    } catch (e) {
      $('netStatus').textContent = `netplay error: ${e}`;
      return;
    }
    if (!ns.started && (ns.state === 'closed' || ns.state === 'desynced')) {
      // Failed before it ever started (timeout, unreachable server, room
      // full, mismatch): end the attempt so Host/Join work again, and leave
      // the reason on screen.
      endNetSession(netStatusLine(ns));
      if (n > 0) { stepLocal(n); blit(); }
      return;
    }
    $('netStatus').textContent = netStatusLine(ns);
    if (ns.started && ns.mode === 'rollback' && (ns.state === 'running' || ns.state === 'stalled')) {
      // Rollback: exactly one session tick per due NES frame (never more
      // than the display rate asks for, or a 120 Hz screen would run the
      // game at double speed). The tick runs every save/load/step request
      // in Rust; the frame is presented once below, after all of them.
      if (n <= 0) return;
      if (emu.net_step(pollInput(), n) === 0) return; // stalled: nothing new to show
    } else if (ns.started && (ns.state === 'running' || ns.state === 'stalled')) {
      const stepped = emu.net_step(pollInput(), Math.max(n, 1));
      if (stepped === 0) return; // waiting for the peer: nothing new to show
    } else if (!ns.started) {
      if (n <= 0) return;
      stepLocal(n); // still connecting: the local game keeps running
    } else {
      return; // the session ended after it started: keep the last frame up
    }
  } else {
    stepLocal(n);
  }
  blit();
  if (!firstFrameLogged) {
    firstFrameLogged = true;
    statusNote = `\nfirst frame ${(performance.now() - romLoadT0).toFixed(0)} ms after ROM load`;
  }
  pushAudio();
  fpsFrames += n;
  if (t - fpsT0 > 1000) {
    fps = (fpsFrames * 1000) / (t - fpsT0);
    fpsFrames = 0; fpsT0 = t;
    setStatus(` · ${fps.toFixed(1)} fps`);
  }
}

// --- audio (AudioWorklet ring buffer) --------------------------------------
let actx = null;
let worklet = null;
// Last report from the worklet: `{underruns, queued, peak, dropped}` (see
// worklet.js).
let audioReport = { underruns: 0, queued: 0, peak: 0, dropped: 0 };

$('audioBtn').addEventListener('click', async () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Take the device's own rate and synthesise at it, rather than demanding
    // 44100. Forcing a rate either buys a pointless resample (the browser's,
    // on a 48 kHz device) or is quietly ignored — and a context running at a
    // different rate from the synth drifts by 3900 samples/s, which is heard
    // as a delay that grows by about a second every 11 seconds, or as a
    // permanent underrun, depending on which way the mismatch goes.
    // 'interactive' asks for the smallest output buffer the device offers.
    actx = new Ctx({ latencyHint: 'interactive' });
    let rate = emu.set_audio_rate(actx.sampleRate);
    if (rate !== actx.sampleRate) {
      // An exotic context rate the synth cannot render (it ships 44100 and
      // 48000 only): rebuild the context at the rate it fell back to.
      await actx.close();
      actx = new Ctx({ sampleRate: rate, latencyHint: 'interactive' });
      rate = actx.sampleRate;
    }
    // Resolve against this module, not the document: a host may serve the
    // page at / and this file at /z2/app.js, so a document-relative
    // './worklet.js' would miss.
    await actx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    worklet = new AudioWorkletNode(actx, 'z2-ring', { processorOptions: { rate } });
    worklet.port.onmessage = (e) => { audioReport = e.data; };
    worklet.connect(actx.destination);
    await actx.resume();
    $('audioBtn').disabled = true;
    $('audioBtn').textContent = 'Audio on';
  } catch (e) {
    statusNote = `\naudio failed: ${e}`;
  }
  setStatus();
});

function pushAudio() {
  if (emu.audio_queued() === 0) return;
  const pcm = emu.take_audio_f32();
  // Audio off or suspended: the samples are dropped, so switching it on at
  // any point starts from the live frame rather than seconds of backlog.
  if (!worklet || !actx || actx.state !== 'running') return;
  worklet.port.postMessage(pcm);
}

// --- pause -----------------------------------------------------------------
// `autoPaused` marks a pause the page took by itself (tab hidden). Only that
// kind is undone when the tab comes back: a page that loaded its ROM in a
// background tab, or a phone that was locked for a moment, must not greet the
// player with a frozen picture and a Resume button. A pause the player asked
// for stays until the player ends it.
let autoPaused = false;
function setPaused(p, auto = false) {
  paused = p;
  autoPaused = p && auto;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  if (actx) { paused ? actx.suspend() : actx.resume(); }
  setStatus();
}
$('pauseBtn').addEventListener('click', () => setPaused(!paused));
document.addEventListener('visibilitychange', () => {
  // Never auto-pause during a session: a paused peer stalls the other one.
  // (requestAnimationFrame stops in a hidden tab anyway, so the peer sees a
  // stall regardless.)
  if (document.hidden) {
    touchRelease();
    if (running && !paused && !netActive) setPaused(true, true);
  } else if (autoPaused) {
    lastT = 0; acc = 0; // do not try to catch up on the time spent hidden
    setPaused(false);
  }
});

// --- ROM loading ------------------------------------------------------------
// The Game ROM card starts as a request ("No ROM is provided") and has to
// stop claiming that the moment a dump is in: same words, now stating what
// the wasm side accepted. A file the hash gate refused says so, with the
// hash it wanted, instead of leaving the request standing over a running game.
function setRomIntro(kind, detail = '') {
  const el = $('romIntro');
  const ok = kind === 'loaded';
  el.classList.toggle('ok', ok);
  const strong = document.createElement('strong');
  const crc = document.createElement('code');
  crc.textContent = ok ? detail : 'BA322865';
  if (ok) {
    strong.textContent = 'ROM loaded. ';
    el.replaceChildren(
      strong,
      document.createTextNode('Zelda II (USA) passed the hash gate in this tab (body CRC32 '),
      crc,
      document.createTextNode('). The bytes never leave your device.'),
    );
  } else {
    strong.textContent = 'ROM rejected. ';
    el.replaceChildren(
      strong,
      document.createTextNode(`${detail} — expecting a Zelda II (USA) dump (body CRC32 `),
      crc,
      document.createTextNode(').'),
    );
  }
}

// One entry point for every source (drop, file picker, host download): the
// wasm side hash-gates the bytes, and nothing here stores them anywhere.
function loadRomBytes(buf) {
  romLoadT0 = performance.now();
  firstFrameLogged = false;
  try {
    emu.load_rom(buf);
  } catch (e) {
    statusEl.textContent = `ROM rejected: ${e}`;
    setRomIntro('rejected', String(e));
    return;
  }
  setRomIntro('loaded', JSON.parse(emu.state()).crc32 || 'BA322865');
  // Re-apply the UI's feature state to the freshly built game. `load_rom`
  // constructs a new `Game` (and re-arms the render record from the settings
  // already held in wasm), so without this a second ROM load would run with
  // widescreen and co-op off while the controls still showed them as on.
  try {
    emu.set_widescreen_preset($('wideSel').value);
    emu.set_fill_left_clip($('clipChk').checked);
    emu.set_fill_right_clip($('rclipChk').checked);
    emu.set_margin_sprites($('mspritesChk').checked);
    emu.set_wide_gameplay($('wideGameChk').checked);
  } catch (e) {
    statusNote += `\nwidescreen: ${e}`;
  }
  try {
    emu.coop_enable(coopOn);
    // The split flag survives a ROM swap (it lives on WebEmu, not Game), but
    // the freshly built game needs the buffer sized for it again.
    emu.split_2p_enable(splitOn);
  } catch (e) {
    statusNote += `\nco-op: ${e}`;
  }
  syncCanvas();
  syncHdPanel();
  running = true;
  lastT = 0; acc = 0;
  for (const id of ['pauseBtn', 'audioBtn', 'snapSave', 'snapLoad', 'sramSave', 'sramLoad', 'snapExport', 'movieRewind']) {
    $(id).disabled = false;
  }
  syncNetButtons();
  setPaused(false);
  setStatus();
  $('drop').classList.add('has-rom'); // hides the "insert cartridge" screen
  // On a phone the picture is the page: bring it under the thumbs' controller.
  if (!pad1.root.hidden) screen.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function loadRomFile(file) {
  loadRomBytes(new Uint8Array(await file.arrayBuffer()));
}

// --- the Android shell's own cartridge ----------------------------------
// A WebView file picker hands the page a content:// URI whose permission
// lives only for that one callback, so a relaunch would ask the user to pick
// the same file again. The shell (android/) therefore keeps the ROM in its
// own private storage and serves it back through this same https origin,
// under /_rom/. Nothing else answers that path: the hosted site gets a 404
// and carries on, and the bytes still never leave the device.
async function loadShellRom() {
  if (location.hostname !== 'appassets.androidplatform.net') return;
  let res;
  try {
    res = await fetch('/_rom/zelda2.nes');
  } catch (e) {
    return;
  }
  if (!res.ok) return;
  try {
    loadRomBytes(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    statusNote += `\nshell ROM: ${e}`;
  }
}

// The TV screen (#drop) and anything marked data-rom-drop take a dropped ROM.
const drop = $('drop');
for (const el of [drop, ...document.querySelectorAll('[data-rom-drop]')]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault(); el.classList.remove('over');
    if (e.dataTransfer.files.length) loadRomFile(e.dataTransfer.files[0]);
  });
}
$('romFile').addEventListener('change', (e) => { if (e.target.files.length) loadRomFile(e.target.files[0]); });

// --- movie ------------------------------------------------------------------
$('movieFile').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  const text = await e.target.files[0].text();
  try {
    const rep = JSON.parse(emu.load_movie(text));
    $('movieInfo').textContent = `${rep.kind}: ${rep.frames} frames ${rep.warnings.join('; ')}`;
  } catch (err) {
    $('movieInfo').textContent = `rejected: ${err}`;
  }
  setStatus();
});
$('movieRewind').addEventListener('click', () => { emu.movie_rewind(); setStatus(); });

// --- IndexedDB saves ----------------------------------------------------------
const DB = 'z2rs-web';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('slots', { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(name, bytes) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('slots', 'readwrite');
    tx.objectStore('slots').put({ name, bytes, ts: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(name) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('slots').objectStore('slots').get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
const slotKey = (kind) => `${$('slotSel').value}:${kind}`;

$('snapSave').addEventListener('click', async () => {
  try { await idbPut(slotKey('snapshot'), emu.snapshot()); setStatus(' · snapshot saved'); }
  catch (e) { setStatus(` · save failed: ${e}`); }
});
$('snapLoad').addEventListener('click', async () => {
  const rec = await idbGet(slotKey('snapshot'));
  if (!rec) { setStatus(' · slot empty'); return; }
  try { emu.restore(rec.bytes); setStatus(' · snapshot restored'); }
  catch (e) { setStatus(` · restore failed: ${e}`); }
});
$('sramSave').addEventListener('click', async () => {
  try { await idbPut(slotKey('sram'), emu.sram_bytes()); setStatus(' · SRAM saved'); }
  catch (e) { setStatus(` · save failed: ${e}`); }
});
$('sramLoad').addEventListener('click', async () => {
  const rec = await idbGet(slotKey('sram'));
  if (!rec) { setStatus(' · slot empty'); return; }
  try { emu.load_sram(rec.bytes); setStatus(' · SRAM loaded'); }
  catch (e) { setStatus(` · SRAM load failed: ${e}`); }
});
$('snapExport').addEventListener('click', () => {
  const blob = new Blob([emu.snapshot()], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `z2-snapshot-f${JSON.parse(emu.state()).frame}.z2web`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('snapImport').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  try {
    const msg = emu.restore(new Uint8Array(await e.target.files[0].arrayBuffer()));
    setStatus(` · imported ${msg}`);
  } catch (err) { setStatus(` · import failed: ${err}`); }
});

// --- widescreen / local co-op ------------------------------------------------
// The portrait split follows local co-op: two players in front of ONE screen
// each take an end of it, so the picture is shown twice with the upper copy
// turned through 180°. An online session never asks for it — each peer has a
// screen of their own — and `?split=0` / the checkbox refuses it outright.
function applySplit() {
  if (!emu) return; // boot() calls this again once the wasm side exists
  const want = !!(splitWanted && coopOn && !netActive);
  if (want === splitOn) return;
  splitOn = want;
  try {
    emu.split_2p_enable(splitOn);
  } catch (e) {
    setStatus(` · split: ${e}`);
    splitOn = !splitOn;
    return;
  }
  syncCanvas();
  // The picture is now twice as tall as it is wide: it leaves the 4:3
  // cabinet and pins itself over the page (see `#room.split2p`).
  room.classList.toggle('split2p', splitOn);
  pad2.root.hidden = !(splitOn && !pad1.root.hidden);
}

function setCoop(on) {
  coopOn = !!on;
  $('coopChk').checked = coopOn;
  try {
    emu.coop_enable(coopOn);
  } catch (e) {
    setStatus(` · co-op: ${e}`);
  }
  applySplit();
}

$('wideSel').addEventListener('change', () => {
  const preset = $('wideSel').value;
  try {
    emu.set_widescreen_preset(preset);
    syncCanvas();
    setStatus(` · widescreen ${preset}`);
  } catch (e) {
    setStatus(` · widescreen rejected: ${e}`);
  }
});

function setWideGameplay(on) {
  $('wideGameChk').checked = !!on;
  try {
    emu.set_wide_gameplay(!!on);
  } catch (e) {
    setStatus(` · enemies in the margins: ${e}`);
  }
}

$('wideGameChk').addEventListener('change', () => {
  setWideGameplay($('wideGameChk').checked);
  setStatus(` · enemies in the margins ${$('wideGameChk').checked ? 'on' : 'off'}`);
});

$('coopChk').addEventListener('change', () => setCoop($('coopChk').checked));
$('splitChk').addEventListener('change', () => {
  splitWanted = $('splitChk').checked;
  applySplit();
});

$('clipChk').addEventListener('change', () => {
  try {
    emu.set_fill_left_clip($('clipChk').checked);
    syncCanvas();
    setStatus(` · fill left edge ${$('clipChk').checked ? 'on' : 'off'}`);
  } catch (e) {
    setStatus(` · fill left edge: ${e}`);
  }
});

$('mspritesChk').addEventListener('change', () => {
  try {
    emu.set_margin_sprites($('mspritesChk').checked);
    syncCanvas();
    setStatus(` · objects in margins ${$('mspritesChk').checked ? 'on' : 'off'}`);
  } catch (e) {
    setStatus(` · objects in margins: ${e}`);
  }
});

$('rclipChk').addEventListener('change', () => {
  try {
    emu.set_fill_right_clip($('rclipChk').checked);
    syncCanvas();
    setStatus(` · fill right edge ${$('rclipChk').checked ? 'on' : 'off'}`);
  } catch (e) {
    setStatus(` · fill right edge: ${e}`);
  }
});

$('zoomIn').addEventListener('click', () => setZoom(zoom + 1));
$('zoomOut').addEventListener('click', () => setZoom(zoom - 1));

// --- fullscreen -----------------------------------------------------------------
// The whole document goes fullscreen, so the touch controller (fixed to the
// viewport) stays usable, and `#room.fs` pins the screen over the page. Where
// the Fullscreen API is missing (iPhone Safari) or refused, the class alone
// still fills the browser tab.
function fullscreenOn() { return room.classList.contains('fs'); }
async function setFullscreen(on) {
  room.classList.toggle('fs', on);
  $('fsBtn').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
  const doc = document.documentElement;
  try {
    if (on && !document.fullscreenElement && doc.requestFullscreen) await doc.requestFullscreen({ navigationUI: 'hide' });
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // Refused (no user gesture, iframe policy): the pinned screen is enough.
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && fullscreenOn()) setFullscreen(false);
});
$('fsBtn').addEventListener('click', () => setFullscreen(!fullscreenOn()));
$('fsExit').addEventListener('click', () => setFullscreen(false));
// The split pins the picture over the deck, so it brings its own way out:
// back to one player, which is what unticking the co-op box would do anyway.
$('splitExit').addEventListener('click', () => setCoop(false));
// F11 matches the desktop app. Esc is handled by the browser in real
// fullscreen; this covers the pinned-screen fallback.
addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); setFullscreen(!fullscreenOn()); }
  else if (e.key === 'Escape' && fullscreenOn() && !document.fullscreenElement) setFullscreen(false);
});

// --- the TV cabinet ----------------------------------------------------------------
// The painted buttons under the screen: MENU pauses, VOL enables audio, CH-/CH+
// step through the screen shapes, the knob is fullscreen. Each forwards to the
// real control in the deck, so disabled-until-a-ROM rules still apply.
for (const b of document.querySelectorAll('.tv-btn[data-click]')) {
  b.addEventListener('click', () => { const t = $(b.dataset.click); if (t && !t.disabled) t.click(); });
}
for (const b of document.querySelectorAll('.tv-btn[data-channel]')) {
  b.addEventListener('click', () => {
    const sel = $('wideSel');
    const n = sel.options.length;
    sel.selectedIndex = (sel.selectedIndex + Number(b.dataset.channel) + n) % n;
    sel.dispatchEvent(new Event('change'));
  });
}
// Scanlines over the picture; the choice is remembered per browser.
{
  const chk = $('crtChk');
  try { const v = localStorage.getItem('z2rs.crt'); if (v !== null) chk.checked = v === '1'; } catch { /* no storage */ }
  const apply = () => room.classList.toggle('crt', chk.checked);
  apply();
  chk.addEventListener('change', () => {
    apply();
    try { localStorage.setItem('z2rs.crt', chk.checked ? '1' : '0'); } catch { /* no storage */ }
  });
}

// --- HD graphics packs --------------------------------------------------------
// One code path for a human and for QA: raw (name, bytes) pairs go into wasm,
// which finds pack.json, strips the picker's folder prefix and decodes the PNG
// sheets in Rust. Nothing is uploaded and JS never touches image data.

// Scales above this warn before they are applied: 4x widescreen composes
// 1728x960 RGBA per frame and a 4x pack holds ~1 MiB of decoded sheet per CHR
// page, so it is a deliberate choice rather than an accident.
const HD_SCALE_WARN = 3;

function hdSay(text, cls = '') {
  const el = $('hdStatus');
  el.className = `sub ${cls}`.trim();
  el.textContent = text;
}

// Re-read the wasm side and redraw the panel. Never trusts local bookkeeping:
// a pack's own scale can override the requested one.
function syncHdPanel() {
  if (!emu) return;
  const supported = emu.hd_supported();
  $('hdDir').disabled = !supported || netActive;
  $('hdScale').disabled = !supported || netActive;
  const device = $('hdDevice');
  if (device) device.disabled = !supported || netActive;
  if (!supported) {
    $('hdBox').classList.add('unsupported');
    $('hdClear').disabled = true;
    if (device) device.hidden = true;
    hdSay('HD packs are not in this build — rebuild with `--features hd` (see site/README).');
    return;
  }
  const info = JSON.parse(emu.hd_pack_info());
  $('hdClear').disabled = !info || netActive;
  const eff = emu.output_scale(), want = emu.requested_scale();
  $('hdScale').value = String(want);
  const size = `${emu.frame_width()}×${emu.frame_height()}`;
  if (!info) {
    hdSay(`no pack: original art at ${eff}× (${size}).`);
    return;
  }
  const over = eff !== want ? ` — the pack's ${eff}× wins over the ${want}× you picked` : '';
  hdSay(
    `pack "${info.name}"${info.author ? ` by ${info.author}` : ''}: ${info.scale}×, ` +
    `${info.tiles} tiles, ${info.variants} variants, ${info.sheets} sheet(s) → ${size}${over}`,
  );
}

// Load a pack from [{ name, bytes }]. Returns the info object, or throws with
// the wasm message. A failure leaves the previous presentation alone: the tab
// keeps playing with whatever art it had.
function loadHdFiles(files) {
  emu.hd_pack_begin();
  for (const f of files) emu.hd_pack_add_file(f.name, f.bytes);
  const info = JSON.parse(emu.hd_pack_commit());
  syncCanvas();
  syncHdPanel();
  return info;
}

$('hdDir').addEventListener('change', async (e) => {
  const picked = [...e.target.files];
  if (!picked.length) return;
  hdSay(`reading ${picked.length} file(s)…`);
  try {
    // `webkitRelativePath` is the path inside the picked folder, which is what
    // HdPack::from_files wants; plain `name` is the fallback for a QA drop of
    // loose files.
    const files = [];
    for (const f of picked) {
      files.push({
        name: f.webkitRelativePath || f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      });
    }
    const info = loadHdFiles(files);
    setStatus(` · HD pack "${info.name}" loaded`);
  } catch (err) {
    // Loud but harmless: say exactly what was wrong and keep playing. A failed
    // load never disturbs what is already on screen, so name that rather than
    // claiming a fallback to the original art that may not have happened.
    const kept = JSON.parse(emu.hd_pack_info());
    hdSay(
      `pack rejected: ${err} — still playing with ` +
      (kept ? `the "${kept.name}" pack.` : 'the original art.'),
      'err',
    );
    syncCanvas();
  }
  e.target.value = ''; // let the same folder be re-picked after an edit
});

// --- an HD pack from a folder on the device ---------------------------------
// A WebView's file chooser hands the page bare file names with no path, so
// `<input webkitdirectory>` cannot see a pack's `sheets/` and `layers/`:
// `sheet-01.png` never matches the `sheets/sheet-01.png` the manifest asks
// for (which is the "cannot read" error the pump reports). On the shell's own
// origin the folder is therefore picked by the *shell*, which mounts it under
// /_hdp/ and lets the page read it back like any other directory.
const HD_FOLDER = '/_hdp/';
// Long enough for someone to find the pack in the system picker; a cancel
// just ends here with a message.
const HD_FOLDER_WAIT_MS = 120000;

// pack.json names every PNG it needs (the sheets[] and layers[] entries, plus
// a `file` some tile entries carry): read the manifest, then fetch exactly
// those, so a partial folder fails loudly instead of rendering half a pack.
async function readPackFiles(prefix) {
  const manifest = JSON.parse(
    await (await fetch(`${prefix}pack.json`, { cache: 'no-store' })).text(),
  );
  const names = ['pack.json'];
  for (const list of [manifest.sheets || [], manifest.layers || [], manifest.tiles || []]) {
    for (const e of list) {
      if (e && typeof e.file === 'string' && !names.includes(e.file)) names.push(e.file);
    }
  }
  const files = [];
  for (const name of names) {
    const r = await fetch(prefix + name, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    files.push({ name, bytes: new Uint8Array(await r.arrayBuffer()) });
  }
  return files;
}

async function usePackFolder() {
  hdSay('pick the folder that holds pack.json…');
  try {
    // The shell opens its own directory picker and answers by mounting it;
    // there is no event for that, so wait for the manifest to appear.
    location.href = 'z2rs://hd-pack';
    const t0 = performance.now();
    for (;;) {
      if (performance.now() - t0 > HD_FOLDER_WAIT_MS) throw new Error('no folder was chosen');
      try {
        const probe = await fetch(`${HD_FOLDER}pack.json`, { cache: 'no-store' });
        if (probe.ok) break;
      } catch { /* the picker is still open */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    hdSay('reading the pack…');
    const info = loadHdFiles(await readPackFiles(HD_FOLDER));
    setStatus(` · HD pack "${info.name}" loaded`);
  } catch (err) {
    const kept = JSON.parse(emu.hd_pack_info());
    hdSay(
      `pack rejected: ${err} — still playing with ` +
      (kept ? `the "${kept.name}" pack.` : 'the original art.'),
      'err',
    );
    syncCanvas();
  }
}

if (location.hostname === 'appassets.androidplatform.net') {
  // The stock picker cannot hand over a folder here, so it would only ever
  // produce that "cannot read" error: the shell's own folder button replaces
  // it. Everywhere else both rows stay exactly as the desktop has them.
  $('hdDirLabel').hidden = true;
  $('hdDir').hidden = true;
  const device = $('hdDevice');
  device.hidden = false;
  device.addEventListener('click', () => usePackFolder());
}

$('hdScale').addEventListener('change', () => {
  const n = Number($('hdScale').value) >>> 0;
  if (n >= HD_SCALE_WARN) {
    hdSay(`${n}× is expensive: about ${(0.14 * n * n).toFixed(1)} ms per frame at 256 wide ` +
      `(more in widescreen) plus ~${(0.0625 * n * n).toFixed(2)} MiB of decoded sheet per CHR page.`,
    'warn');
  }
  try {
    emu.set_output_scale(n);
    syncCanvas();
    syncHdPanel();
  } catch (e) {
    hdSay(`scale ${n}× rejected: ${e}`, 'err');
    $('hdScale').value = String(emu.requested_scale());
  }
});

$('hdClear').addEventListener('click', () => {
  try {
    emu.hd_pack_clear();
    syncCanvas();
    syncHdPanel();
    setStatus(' · back to the original art');
  } catch (e) {
    hdSay(`could not clear the pack: ${e}`, 'err');
  }
});

// --- online co-op -------------------------------------------------------------
// Connecting is shown as numbered stages, each with how long it has lasted, so
// a slow step is visible as exactly that step. `ns.link` comes from the
// transport (z2_net::ConnectStage::as_str).
const NET_STAGES = {
  signalling: '1/4 connecting to the signal server',
  waiting: '2/4 in the room, waiting for the other player',
  linking: '3/4 other player found, establishing the peer link',
  connected: '4/4 connected, starting the session',
};

function netStatusLine(ns) {
  if (!ns.supported) {
    return 'netplay: not in this build — serve a bundle built with `make run-web-net`';
  }
  if (!ns.active) return 'netplay: idle — enter a room, then Host or Join';
  const who = ns.role === 'host' ? 'host (P1)' : 'guest (P2)';
  if (!ns.started) {
    if (ns.state === 'closed' || ns.state === 'desynced') {
      return `netplay: ${who} could not connect — ${ns.closeReason || ns.error || ns.state}`;
    }
    const stage = ns.state === 'handshake' ? NET_STAGES.connected
      : (NET_STAGES[ns.link] || NET_STAGES.signalling);
    return `netplay: ${who} ${stage}… ${(ns.linkMs / 1000).toFixed(1)} s ` +
      '(the game keeps running; Leave cancels)';
  }
  const rtt = ns.rttMs === null || ns.rttMs === undefined ? '?' : `${ns.rttMs}ms`;
  let s;
  if (ns.mode === 'rollback') {
    s = `netplay: ${who} rollback ${ns.state} f=${ns.frame} delay=${ns.delay} rtt=${rtt} ` +
      `rollbacks=${ns.rollbacks} pred=${ns.predictionDepth}/${ns.maxPrediction}`;
  } else {
    s = `netplay: ${who} lockstep ${ns.state} f=${ns.frame} ahead=${ns.remoteAhead} ` +
      `delay=${ns.delay} rtt=${rtt}`;
  }
  if (ns.started && ns.requestedDelay !== ns.delay) {
    s += ` (host chose ${ns.delay}, you asked for ${ns.requestedDelay})`;
  }
  if (ns.state === 'stalled' && ns.mode === 'rollback') s += ' — no packets from the peer';
  else if (ns.state === 'stalled') s += ` — peer paused ${(ns.stallMs / 1000).toFixed(1)} s`;
  if (ns.state === 'desynced') s += ' — DESYNC, the session is over';
  if (ns.closeReason) s += ` — closed (${ns.closeReason})`;
  if (ns.error && ns.error !== ns.closeReason) s += ` — ${ns.error}`;
  if (ns.state === 'closed' || ns.state === 'desynced') s += ' — press Leave to play on alone';
  return s;
}

// Anything that rewinds, replaces or re-times state desyncs a lockstep session,
// so those controls are locked for its whole lifetime.
// Anything that changes the pixel pipeline is fine mid-session (both peers may
// look different), but anything that rewinds or replaces game state is not —
// and a pack load stalls the tab for a moment, which a lockstep peer feels as a
// stall, so the pack picker is locked too.
const NET_LOCKED = ['movieFile', 'movieRewind', 'snapSave', 'snapLoad', 'sramLoad',
  'snapImport', 'pauseBtn', 'coopChk', 'hdDir', 'hdClear', 'netMode'];

// The panel's Mode selector is the source of truth for the next session.
// Rollback allows an input delay of 0-3 (lockstep 0-8), as on the desktop, so
// larger delays are disabled in rollback mode.
const ROLLBACK_MAX_DELAY = 3;
function syncNetMode() {
  const rollback = $('netMode').value === 'rollback';
  const sel = $('netDelay');
  for (const o of sel.options) o.disabled = rollback && Number(o.value) > ROLLBACK_MAX_DELAY;
  if (rollback && Number(sel.value) > ROLLBACK_MAX_DELAY) sel.value = String(ROLLBACK_MAX_DELAY);
  if (!emu) return;
  try {
    emu.net_set_mode($('netMode').value, JSON.parse(emu.net_mode()).maxPrediction);
  } catch (e) {
    $('netStatus').textContent = `netplay: ${e}`;
  }
}
$('netMode').addEventListener('change', syncNetMode);

function syncNetButtons() {
  const romOk = !!emu && emu.rom_loaded();
  const supported = !!emu && emu.net_supported();
  $('netHost').disabled = netActive || !romOk || !supported;
  $('netJoin').disabled = netActive || !romOk || !supported;
  $('netLeave').disabled = !netActive;
  for (const id of NET_LOCKED) {
    const el = $(id);
    if (el) el.disabled = netActive;
  }
  syncHdPanel(); // re-derives hdDir/hdScale/hdClear from support + netActive
}

function netConnect(isHost) {
  if (!emu || !emu.rom_loaded()) {
    $('netStatus').textContent = 'netplay: drop a ROM first — both peers must run the same one';
    return;
  }
  const signal = $('netSignal').value.trim();
  const room = $('netRoom').value.trim();
  const ice = $('netIce').value.trim();
  // The browser blocks ws:// from an https page with an opaque failure; say so
  // plainly instead of letting it surface as a generic transport error.
  if (location.protocol === 'https:' && signal.startsWith('ws://')) {
    $('netStatus').textContent =
      'netplay: this page is https, so the signal URL must be wss:// (put z2-signal behind a TLS proxy)';
    return;
  }
  try {
    syncNetMode();
    emu.net_connect(signal, room, isHost, +$('netDelay').value, ice);
  } catch (e) {
    $('netStatus').textContent = `netplay: ${e}`;
    return;
  }
  netActive = true;
  netLastT = 0;
  applySplit(); // each peer has a screen of its own: no split online
  // A paused page never calls net_poll, so a session started while paused could
  // never connect.
  setPaused(false);
  syncNetButtons();
  $('netStatus').textContent = `netplay: ${NET_STAGES.signalling} (room '${room}')…`;
}

// Drop the session (any stage) and say why. Safe to call more than once.
function endNetSession(message) {
  emu.net_disconnect();
  netActive = false;
  netLastT = 0;
  applySplit(); // local again: the split may come back with co-op
  syncNetButtons();
  $('netStatus').textContent = message;
}

$('netHost').addEventListener('click', () => netConnect(true));
$('netJoin').addEventListener('click', () => netConnect(false));
$('netLeave').addEventListener('click', () => endNetSession('netplay: left the session'));

// --- go -----------------------------------------------------------------------
boot();
requestAnimationFrame(loop);
