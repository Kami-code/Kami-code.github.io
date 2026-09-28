/*! chenbao.tech | (c) 2026 Chen Bao | MIT License | https://chenbao.tech | please credit: "Based on chenbao.tech by Chen Bao" */
// main.js — boot: feature detection, fallbacks, URL params, then lazy-load the 3D ride.
//
// URL params (deterministic screenshots):
//   ?stop=<index|id>  jump to a stop and hold          ?p=<0..1>  global ride progress (distance), hold
//   ?t=<s>            freeze simulated time at t        ?yaw=<deg>&pitch=<deg>  look offset from the base view
//   ?text=1           plain page (text view)            ?nogl=1    poster + text view, no WebGL
//   ?debug=1          draw calls / tris / fps / transfer sizes
//   (extra: ?ui=0 hides the HTML overlay, used to capture assets/poster.jpg 1600x1000 + assets/poster-portrait.jpg 390x844@2x)

import { initUI } from './ui.js';

const P = new URLSearchParams(location.search);
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// avatar: hide cleanly if the image is missing (e.g. local preview outside the repo root)
const avatar = document.querySelector('#identity .avatar');
if (avatar) {
  const hide = () => { avatar.hidden = true; };
  if (avatar.complete && avatar.naturalWidth === 0) hide(); else avatar.addEventListener('error', hide);
}

let ridePromise = null;
const ui = initUI({ P, reduced, onWantRide: () => startRide() });

function fallbackToStatic() {
  root.classList.remove('ride', 'gl-ready');
  root.classList.add('text', 'static');
}

function startRide() {
  if (ridePromise) return ridePromise;
  ridePromise = (async () => {
    try {
      const { createRide } = await import('./ride.js');
      const ride = await createRide({
        canvas: document.getElementById('gl'),
        ui, P, reduced,
        onReady: () => root.classList.add('gl-ready'),
      });
      ui.attachRide(ride);
      if (P.get('debug') === '1') window.__ride = ride;
      return ride;
    } catch (err) {
      // no WebGL context, CDN unreachable, GLB failed: keep the page fully usable
      fallbackToStatic();
      if (P.get('debug') === '1') ui.setDebug('3D disabled: ' + (err && err.message ? err.message : err));
      return null;
    }
  })();
  return ridePromise;
}

if (root.classList.contains('ride')) startRide();
