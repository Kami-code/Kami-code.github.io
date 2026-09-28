/*! chenbao.tech | (c) 2026 Chen Bao | MIT License | https://chenbao.tech | please credit: "Based on chenbao.tech by Chen Bao" */
// main.js — boot: feature detection, fallbacks, URL params, then lazy-load the 3D ride.
//
// URL params (deterministic screenshots):
//   ?stop=<index|id>  jump to a stop and hold          ?p=<0..1>  global ride progress (distance), hold
//   ?t=<s>            freeze simulated time at t        ?yaw=<deg>&pitch=<deg>  look offset from the base view
//   ?text=1           plain page (text view)            ?nogl=1    poster + text view, no WebGL
//   ?debug=1          draw calls / tris / fps / transfer sizes
//   ?force3d=1        3D on any device: skips the pre-flight, the load watchdog and the frame-time fallback
//   (extra: ?ui=0 hides the HTML overlay, used to capture assets/poster.jpg 1600x1000 + assets/poster-portrait.jpg 390x844@2x)
//
// Automatic text version. The head script already sent weak devices to the text view (html.auto). At run time the
// ride falls back to it too: 3D not ready within 12 s of visible time (load watchdog), a lost WebGL context, or frame
// times that stay bad at the lowest quality level (ride.js onFail). The switch stops the render loop, releases the
// GPU (ride.dispose), remembers the verdict in localStorage ('cb3d', read by the head script) and shows a small
// notice whose button — like the view toggle — tries the 3D again (and clears the verdict).

import { initUI } from './ui.js?v=20260928a';

const P = new URLSearchParams(location.search);
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const force3d = P.get('force3d') === '1';
const debug = P.get('debug') === '1';

// avatar: hide cleanly if the image is missing (e.g. local preview outside the repo root)
const avatar = document.querySelector('#identity .avatar');
if (avatar) {
  const hide = () => { avatar.hidden = true; };
  if (avatar.complete && avatar.naturalWidth === 0) hide(); else avatar.addEventListener('error', hide);
}

// ---------- the per-device verdict (localStorage may be unavailable: every access is guarded)
const KEY = 'cb3d', DAY = 864e5;
// how long a failure keeps this device on the text version: slow frames are a property of the device; a load
// timeout (maybe the network) or a lost context (maybe a driver reset) are retried sooner
const TTL = { slow: 7 * DAY, load: DAY, lost: DAY };
const store = {
  set(v, why, ms) { try { localStorage.setItem(KEY, JSON.stringify({ v, why, until: Date.now() + ms })); } catch { /* private mode */ } },
};

// ---------- ride attempts
let cur = null;         // { ride, failed, canvas }
const ui = initUI({ P, reduced, onWantRide: () => startRide(), onRetry: () => retry3D() });
if (root.classList.contains('auto')) ui.showAutoNote();

/** a fresh canvas per attempt: a lost or released WebGL context never comes back on the old one */
function freshCanvas() {
  const old = document.getElementById('gl');
  if (!cur) return old;
  const c = document.createElement('canvas'); c.id = 'gl';
  old.replaceWith(c);
  return c;
}

/** load watchdog: 3D must be on screen within 12 s of *visible* time (a background tab does not count; nor does
 *  time the visitor spends in the Text view, where the loading ride stays paused) */
function watchdog(att, ms = 12000) {
  if (force3d) return;
  let left = ms, t0 = performance.now(), timer = 0;
  const due = () => { if (root.classList.contains('ride')) fail(att, 'load'); else { left = ms; arm(); } };
  const arm = () => { t0 = performance.now(); timer = setTimeout(due, left); };
  const onVis = () => {
    if (att.done) { document.removeEventListener('visibilitychange', onVis); return; }
    if (document.hidden) { clearTimeout(timer); left -= performance.now() - t0; } else arm();
  };
  document.addEventListener('visibilitychange', onVis);
  att.stopWatch = () => { att.done = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  if (!document.hidden) arm();
}

function startRide() {
  if (cur && !cur.failed) return cur.promise;
  const att = { ride: null, failed: false, done: false, stopWatch: () => {}, ac: new AbortController() };
  const canvas = freshCanvas();
  cur = att;
  watchdog(att);
  att.promise = (async () => {
    try {
      const { createRide } = await import('./ride.js?v=20260928a');
      if (att.failed) return null;
      const ride = await createRide({
        canvas, ui, P, reduced, force: force3d, signal: att.ac.signal,
        onReady: () => { if (att.failed) return; att.stopWatch(); root.classList.add('gl-ready'); },
        onFail: (why) => fail(att, why),
      });
      if (att.failed) { ride.dispose(); return null; }   // the watchdog gave up while it was loading
      att.ride = ride;
      ui.attachRide(ride);
      if (debug) window.__ride = ride;
      return ride;
    } catch (err) {
      // no WebGL context, CDN unreachable, GLB failed: keep the page fully usable (and offer another try)
      if (debug) ui.setDebug('3D disabled: ' + (err && err.message ? err.message : err));
      fail(att, 'error');
      return null;
    }
  })();
  return att.promise;
}

/** give up on this attempt: stop + release the 3D, go to the text view with the notice, remember the verdict */
function fail(att, why) {
  if (att.failed) return;
  att.failed = true;
  att.stopWatch();
  att.ac.abort();                                           // a ride still loading stops at its next step
  const ride = att.ride; att.ride = null;
  if (ride) { ui.detachRide(ride); ride.pause(); }           // no more frames; the last one stays on screen
  if (window.__ride === ride) window.__ride = null;
  const release = () => { if (ride) try { ride.dispose(); } catch { /* already gone */ } };
  const wasRide = root.classList.contains('ride');
  // a context lost while the visitor reads the Text view (or in a background tab) says nothing about the device
  const judged = !force3d && !!TTL[why] && !(why === 'lost' && (!wasRide || document.hidden));
  if (judged) store.set('text', why, TTL[why]);
  window.__auto = why;
  if (!wasRide) { release(); if (judged) root.classList.add('auto'); return; }
  const go = () => {
    release();
    root.classList.remove('gl-ready');
    root.classList.add('auto');
    ui.setText(true, { now: true });
    ui.showAutoNote();
  };
  // cross-fade from the last 3D frame where the browser can (a lost context has no frame left to fade from)
  if (document.startViewTransition && !reduced && !document.hidden && why !== 'lost') {
    try {
      const vt = document.startViewTransition(go);
      for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p?.catch(() => {});   // a skipped transition is fine
      return;
    } catch { /* fall through */ }
  }
  go();
}

/** "try 3D again" (notice button or view toggle in the automatic text view): the visitor overrides the verdict */
function retry3D() {
  if (!force3d) store.set('try', '', TTL.slow);
  root.classList.remove('auto');
  window.__auto = '';
  ui.hideAutoNote();
}

if (root.classList.contains('ride')) startRide();
