/*! chenbao.tech | (c) 2026 Chen Bao | MIT License | https://chenbao.tech | please credit: "Based on chenbao.tech by Chen Bao" */
// ui.js — HTML layer: stops read from the page's [data-stop] sections, scroll -> stop progress,
// cards, route map (stop rail), phone dock, text view toggle, keyboard, hint, debug panel.
// The HTML in index.html is the single source of truth (its text = the owner's page, verbatim). Nothing here adds
// words: stop labels are the page's own headings / title prefixes, the chrome is symbols + aria-labels
// (inventory: _work/content2/ui-strings.md).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
  }
  for (const k of kids) el.append(k);
  return el;
};
const pad2 = (n) => String(n).padStart(2, '0');
// UI icons (no words): text view = lines of text, 3D view = the suspended car, hints = mouse wheel / swipe up
const svg = (body, vb = '0 0 24 24') => `<svg class="ico" viewBox="${vb}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  text: svg('<path d="M4 6h16M4 10.5h16M4 15h16M4 19.5h10"/>'),
  car: svg('<path d="M2.5 3.5h19M12 3.5v3"/><rect x="4" y="6.5" width="16" height="12" rx="3.5"/><path d="M7.5 10.5h3.5v3.5H7.5zM13 10.5h3.5v3.5H13z" stroke-width="1.6"/>'),
  mouse: svg('<rect x="7" y="3" width="10" height="16" rx="5"/><path class="wheel" d="M12 6.5v3"/>', '0 0 24 22'),
  swipe: svg('<path class="up1" d="M7 12l5-5 5 5"/><path class="up2" d="M7 18l5-5 5 5"/>', '0 0 24 22'),
};

const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** Read the stops from the DOM (order = ride order = the page's order). Every string a stop carries is copied from
 *  the page: label = the section heading, or for a paper the part of its title before the colon. */
export function readStops() {
  const els = $$('main [data-stop]');
  const identity = $('#identity');
  return els.map((el, i) => {
    const id = el.dataset.stop;
    const kind = id.startsWith('paper-') ? 'paper' : id;          // news | intro | paper | project | awards
    const item = kind === 'paper' ? el : $('article', el);
    const fullTitle = txt(item && $('.title', item));
    const cut = fullTitle.indexOf(':');
    const heading = txt($('h2', el));                                // News, Intro, Project, Selected Awards and Honors
    const group = txt(el.closest('[data-group]')?.querySelector('h2'));   // Research (papers)
    const s = {
      i, id, kind, el, heading, group,
      fullTitle,
      short: cut > 0 ? fullTitle.slice(0, cut).trim() : fullTitle,          // "HandsOnVLM"
      rest: cut > 0 ? fullTitle.slice(cut + 1).trim() : '',                 // "Vision-Language Models for ..."
      venues: item ? $$('.venue', item).map(txt) : [],
      subhead: txt($('h3.year', el)),                                        // "2021" (Project)
      media: item?.dataset.media || '', mediaType: item?.dataset.mediaType || '',
      mediaW: +(item?.dataset.mediaW || 16), mediaH: +(item?.dataset.mediaH || 9),
      poster: item?.dataset.poster || '', still: item?.dataset.still || '',
      links: item ? $$('.links a', item).map((a) => ({ href: a.href, text: txt(a) })) : [],
    };
    s.label = kind === 'paper' ? s.short : heading;
    if (kind === 'intro') {
      s.name = txt($('.name-en', identity));
      s.nameZh = txt($('.name-zh', identity));
      const p1 = txt($('p', el));
      s.lead = (p1.match(/^.*?[.!?](?=\s|$)/) || [p1])[0];               // the intro's first sentence, verbatim
    }
    if (kind === 'news') {
      s.items = $$('li', el).map((li) => {
        const date = txt($('time', li));
        return { date, text: txt(li).slice(date.length).trim() };
      });
    }
    if (kind === 'awards') s.items = $$('li', el).map((li) => ({ date: '', text: txt(li) }));
    return s;
  });
}

export function initUI({ P, reduced, mode, onWantRide }) {
  const root = document.documentElement;
  window.__uiReady = true;
  const stops = readStops();
  const N = stops.length;
  const phoneMQ = matchMedia('(max-width: 700px), (max-width: 1024px) and (orientation: portrait)');
  // Touch screens ride DISCRETELY: one swipe or dock tap = one stop, and the ride's target is the chosen stop, not
  // a scroll position. The page itself does not scroll in ride mode there (css: #track hidden under the same query).
  // (iOS Safari ignored / snapped back programmatic scrolls of the mandatory-snap root once its toolbar had
  // collapsed, and every drag past the stop's dead zone started the doors closing even when the snap went back.)
  const touchMQ = matchMedia('(pointer: coarse)');
  const discrete = () => touchMQ.matches && root.classList.contains('ride');
  let active = -1;
  let ride = null;            // ride API once 3D is running
  let lockedByParam = P.has('stop') || P.has('p');
  let userMoved = false;

  // ---------- kicker inside each card (UI only, aria-hidden): stop number, the page's group heading for papers
  // (their own "Research" heading is not shown in a card), and a state symbol: ● at the stop, ▸ on the way ----------
  for (const s of stops) {
    const k = h('div', { class: 'kicker', 'aria-hidden': 'true' },
      h('span', { class: 'num', text: `${pad2(s.i + 1)}/${pad2(N)}` }));
    if (s.kind === 'paper' && s.group) k.append(h('span', { class: 'grp', text: s.group }));
    k.append(h('span', { class: 'state', text: '●' }));
    s.el.prepend(k);
    s.kicker = k;
  }
  // the Project section is collapsed on the plain page (as on the source page); its ride card shows it open.
  // Follows the mode wherever it changes (toggle, 3D fallback): open in ride mode, back to collapsed outside it.
  const disclosures = $$('main [data-stop] details');
  let wasRide = null;
  const syncDisclosures = () => {
    const isRide = root.classList.contains('ride');
    if (isRide === wasRide) return;
    wasRide = isRide;
    for (const d of disclosures) d.open = isRide;
  };
  for (const d of disclosures) {
    d.querySelector('summary')?.addEventListener('click', (e) => { if (root.classList.contains('ride')) e.preventDefault(); });
  }
  syncDisclosures();
  if (disclosures.length) new MutationObserver(syncDisclosures).observe(root, { attributes: true, attributeFilter: ['class'] });

  // ---------- scroll track: one viewport per stop ----------
  const track = $('#track');
  track.replaceChildren(...stops.map((s) => h('div', { class: 'snap', 'data-for': s.id })));
  // cached: read every ride frame, and reading offsetHeight right after the ride wrote styles forced a style recalc
  let snapHC = 0;
  const snapH = () => snapHC || (snapHC = track.firstElementChild?.offsetHeight || 0) || innerHeight;
  addEventListener('resize', () => { snapHC = 0; });

  // ---------- ride UI chrome ----------
  const uiRoot = $('#ride-ui');
  const toggle = h('button', { type: 'button', id: 'view-toggle' });
  const tools = h('div', { id: 'tools' }, toggle);

  const railList = h('ol', { style: `--n:${N}` });
  const railCar = h('span', { class: 'car', 'aria-hidden': 'true' });
  railList.append(railCar);
  const firstPaper = stops.findIndex((s) => s.kind === 'paper');
  const lastPaper = stops.map((s) => s.kind).lastIndexOf('paper');
  for (const s of stops) {
    const a = h('a', { href: `#${s.el.id}`, 'data-i': s.i },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'lbl', text: s.label }));
    a.addEventListener('click', (e) => { e.preventDefault(); goTo(s.i); closeRail(); });
    railList.append(h('li', {}, a));
    s.railLink = a;
  }
  const railHead = h('div', { class: 'rail-head', 'aria-hidden': 'true', style: `--n:${N}` });
  if (firstPaper >= 0 && stops[firstPaper].group) railHead.append(h('span', { class: 'grp', style: `grid-column:${firstPaper + 1} / ${lastPaper + 2}`, text: stops[firstPaper].group }));
  const rail = h('nav', { id: 'rail', 'aria-label': 'Stops' }, railHead, railList);
  // phone: the Quick Links row is hidden in the top bar, so the station list carries a copy (same links, same text)
  const ql = $('#identity .quick-links ul');
  if (ql) {
    const copy = ql.cloneNode(true);
    copy.className = 'rail-links';
    rail.append(copy);
  }

  const prevB = h('button', { type: 'button', 'aria-label': 'Previous', text: '‹' });
  const nextB = h('button', { type: 'button', 'aria-label': 'Next', text: '›' });
  const stNum = h('span', { class: 'num' }), stName = h('span', { class: 'nm' });
  const stBtn = h('button', { type: 'button', class: 'station', 'aria-label': 'Stops', 'aria-expanded': 'false' },
    stNum, stName, h('span', { class: 'chev', 'aria-hidden': 'true', text: '▲' }));
  const progI = h('i');
  const dock = h('div', { id: 'dock' }, h('span', { class: 'prog', 'aria-hidden': 'true' }, progI), prevB, stBtn, nextB);
  prevB.addEventListener('click', () => goTo(Math.max(0, active - 1)));
  nextB.addEventListener('click', () => goTo(Math.min(N - 1, active + 1)));
  // phone: the open station list gets the whole height between the top bar and the dock (the card sheet
  // collapses, html.rail-open); a faded bottom edge (.more) says there is more to scroll
  stBtn.addEventListener('click', () => setRail(!rail.classList.contains('open')));
  function setRail(open) {
    rail.classList.toggle('open', open); root.classList.toggle('rail-open', open);
    stBtn.setAttribute('aria-expanded', String(open));
    if (open) { rail.scrollTop = 0; requestAnimationFrame(syncRailMore); }
  }
  function closeRail() { if (rail.classList.contains('open') || root.classList.contains('rail-open')) setRail(false); }
  const syncRailMore = () => rail.classList.toggle('more', rail.classList.contains('open') && rail.scrollTop + rail.clientHeight < rail.scrollHeight - 4);
  rail.addEventListener('scroll', syncRailMore, { passive: true });
  // a tap anywhere outside the list and the dock closes it; so does leaving the phone layout
  document.addEventListener('pointerdown', (e) => {
    if (rail.classList.contains('open') && !(e.target.closest && e.target.closest('#rail, #dock'))) closeRail();
  });
  phoneMQ.addEventListener?.('change', closeRail);

  // how to ride, without words: a mouse with a rolling wheel (desktop) / chevrons swiping up (touch)
  const hint = h('div', { id: 'hint', 'aria-hidden': 'true' });
  const setHintText = () => { hint.innerHTML = phoneMQ.matches ? ICON.swipe : ICON.mouse; };
  setHintText(); phoneMQ.addEventListener?.('change', setHintText);
  uiRoot.append(tools, rail, dock, hint);
  if (P.has('stop') || P.has('p') || P.has('t')) hint.classList.add('gone');

  let debugEl = null;
  if (P.get('debug') === '1') { debugEl = h('div', { id: 'debug', 'aria-live': 'off' }); uiRoot.append(debugEl); }

  // ---------- helpers ----------
  const clampS = (s) => Math.max(0, Math.min(N - 1, s));
  function getTargetS() { return discrete() ? clampS(Math.max(0, active)) : clampS(scrollY / snapH()); }

  function setActive(i) {
    if (i === active) return;
    active = i;
    for (const s of stops) {
      const on = s.i === i;
      s.el.classList.toggle('is-active', on);
      if (on) s.railLink.setAttribute('aria-current', 'step'); else s.railLink.removeAttribute('aria-current');
    }
    stNum.textContent = `${pad2(i + 1)}/${pad2(N)}`;
    stName.textContent = stops[i].label;
    prevB.disabled = i === 0; nextB.disabled = i === N - 1;
    stops[i].el.scrollTop = 0;
    syncSheet();
  }

  // phone bottom sheet fits its card (max 41% of the height); the dock / station list / hint sit on top of it.
  // Everywhere: --id-bottom keeps the stop card clear of the identity panel on short viewports.
  function syncSheet() {
    const el = stops[Math.max(0, active)]?.el;
    if (el) root.style.setProperty('--sheet-h', el.getBoundingClientRect().height.toFixed(1) + 'px');
    const idr = $('#identity')?.getBoundingClientRect();
    if (idr) root.style.setProperty('--id-bottom', Math.round(idr.bottom) + 'px');
  }
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => syncSheet());
    for (const s of stops) ro.observe(s.el);
    ro.observe($('#identity'));
  }
  document.fonts?.ready?.then(syncSheet);

  // navTarget: a programmatic (smooth) jump is in flight; intermediate scroll events must not flip the card
  // back to the origin / through the stops in between. A real user scroll clears it.
  let navTarget = null;
  function goTo(i, instant = false) {
    i = Math.max(0, Math.min(N - 1, i));
    userMoved = true; lockedByParam = false;
    if (root.classList.contains('ride')) {
      // Ride mode: the (invisible) scroll track only stores the position, so jump it at once. The ride reads the
      // new target on its next frame and pulls away immediately (a smooth scroll made it wait ~0.3 s, then it
      // crawled through the dead zones of the stops in between).
      navTarget = null;
      lastS = i;
      if (discrete()) hint.classList.add('gone');                 // touch: the chosen stop is the target itself
      else window.scrollTo({ top: i * snapH(), behavior: 'auto' });
      setActive(i);
    } else {
      stops[i].el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }
  }

  let sInitial = 0;
  let lastS = null;          // stop progress (scrollY / snap height) of the last scroll, used to restore on resize
  let lastScrollT = -1e9;    // time of the last scroll event (a fling in progress must not be interrupted)
  function onScroll() {
    lastScrollT = performance.now();
    if (!root.classList.contains('ride') || discrete()) return;
    if (P.has('t') && lockedByParam && !userMoved && scrollY < 8) return;
    const s = getTargetS();
    lastS = s;
    if (navTarget !== null) {
      if (Math.abs(s - navTarget) < 0.02) navTarget = null;
      else return;
    }
    setActive(Math.round(s));
    // programmatic scrolls (?stop / ?p) land on sInitial; only a real move releases the hold
    if (Math.abs(s - sInitial) > 0.05) { hint.classList.add('gone'); userMoved = true; lockedByParam = false; }
  }
  addEventListener('scroll', onScroll, { passive: true });
  const endNav = () => { if (navTarget !== null) { navTarget = null; onScroll(); } };
  addEventListener('scrollend', endNav);
  addEventListener('touchstart', endNav, { passive: true });

  // ---------- mouse wheel / trackpad: one flick = one stop, at once ----------
  // With native scrolling a few wheel notches were snapped back to the stop (nothing happened), and a fast spin
  // could park the car between stations. In ride mode the wheel is taken over: a gesture moves exactly one stop;
  // holding a spinning wheel keeps stepping (one stop / 0.4 s). A card or station list that can still scroll in
  // the wheel's direction scrolls natively first; a gesture that started there never jumps stops.
  const W = { last: 0, stepT: -1e9, armed: true, acc: 0, prevAbs: 0, dir: 0, inner: false };
  const canScroll = (el, dy) => {
    for (let n = el; n && n !== document.body && n !== root; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) return true;
    }
    return false;
  };
  addEventListener('wheel', (e) => {
    if (!root.classList.contains('ride') || e.ctrlKey) return;
    let dy = e.deltaY;
    const dx = e.deltaX;
    if (e.deltaMode === 1) dy *= 40; else if (e.deltaMode === 2) dy *= innerHeight;
    if (Math.abs(dy) <= Math.abs(dx) * (e.deltaMode ? 40 : 1)) return;        // sideways: not ours
    const now = performance.now(), gap = now - W.last, a = Math.abs(dy), dir = Math.sign(dy);
    W.last = now;
    if (gap > 200) { W.armed = true; W.acc = 0; W.inner = false; }            // a new gesture
    else if (dir !== W.dir && W.dir !== 0 && !W.inner) { W.armed = true; W.acc = 0; }   // changed its mind
    else if (!W.armed && !W.inner && now - W.stepT > 400 &&
      (((e.deltaMode !== 0 || (Number.isInteger(dy) && a >= 50)) && a >= 0.95 * W.prevAbs) ||   // wheel still spinning (steady notches; a coasting trackpad decays)
       (a > 2.2 * W.prevAbs && a > 12))) { W.armed = true; W.acc = 0; }      // fresh swipe on a coasting trackpad
    W.prevAbs = a; W.dir = dir;
    const t = e.target instanceof Element ? e.target : null;
    if (t && canScroll(t, dy)) { if (gap > 200 || W.inner) W.inner = true; if (W.inner) return; }
    e.preventDefault();
    if (W.inner || !W.armed) return;
    W.acc += dy;
    if (Math.abs(W.acc) < 24) return;
    W.armed = false; W.acc = 0; W.stepT = now;
    const k = Math.max(0, Math.min(N - 1, active + dir));
    if (k !== active) goTo(k); else if (hint) hint.classList.add('gone');
  }, { passive: false });

  // ---------- touch (discrete mode): one vertical swipe = one stop, decided when the finger lifts ----------
  // Far enough (7 % of the height, >= 48 px) or a flick (>= 24 px at >= 0.3 px/ms: the release speed, or the average
  // of a gesture shorter than 0.3 s) moves exactly one stop. A short drag, or one the finger pulled back from (by a
  // quarter of its reach, or still moving back at release) changes nothing, so the doors never start to close for it.
  // Not ours: a gesture that starts in something that scrolls itself (a long card, the open station list), a second
  // finger (pinch-zoom), or any drag while the page is zoomed in (panning the zoomed view). A vertical nav drag is
  // preventDefault-ed (non-passive touchmove), so no rubber band / pull-to-refresh / toolbar move happens under it.
  const scrollsY = (el) => {
    for (let n = el; n && n !== document.body && n !== root; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return true;
    }
    return false;
  };
  const TG = { id: null, x0: 0, y0: 0, t0: 0, axis: '', up: 0, down: 0, trail: [] };
  const touchOf = (list) => { for (const t of list) if (t.identifier === TG.id) return t; return null; };
  addEventListener('touchstart', (e) => {
    TG.id = null;
    if (!discrete() || e.touches.length !== 1) return;
    const t = e.changedTouches[0], el = e.target instanceof Element ? e.target : null;
    if (el && (el.closest('#rail.open') || scrollsY(el))) return;
    if (window.visualViewport && visualViewport.scale > 1.01) return;
    TG.id = t.identifier; TG.x0 = t.clientX; TG.y0 = t.clientY; TG.axis = ''; TG.up = 0; TG.down = 0;
    TG.t0 = e.timeStamp || performance.now();
    TG.trail = [[TG.t0, t.clientY]];
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (TG.id === null) return;
    if (e.touches.length !== 1) { TG.id = null; return; }
    const t = touchOf(e.changedTouches); if (!t) return;
    const dx = t.clientX - TG.x0, dy = t.clientY - TG.y0;
    if (!TG.axis && Math.hypot(dx, dy) >= 8) TG.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    if (TG.axis === 'x') { TG.id = null; return; }                  // sideways: look-around drag (ride.js)
    TG.up = Math.max(TG.up, -dy); TG.down = Math.max(TG.down, dy);
    const now = e.timeStamp || performance.now();
    TG.trail.push([now, t.clientY]);
    while (TG.trail.length > 2 && now - TG.trail[0][0] > 120) TG.trail.shift();
    if (TG.axis === 'y' && e.cancelable) e.preventDefault();
  }, { passive: false });
  addEventListener('touchend', (e) => {
    if (TG.id === null) return;
    const t = touchOf(e.changedTouches); if (!t) return;
    TG.id = null;
    if (TG.axis !== 'y') return;
    const now = e.timeStamp || performance.now();
    const dy = t.clientY - TG.y0, dx = t.clientX - TG.x0, dir = Math.sign(dy), dist = Math.abs(dy);
    if (!dir || dist < 1.2 * Math.abs(dx)) return;
    const [ta, ya] = TG.trail[0];
    const v = now - ta > 8 ? (t.clientY - ya) / (now - ta) : 0;           // px/ms over the last ~120 ms
    const reach = dir < 0 ? TG.up : TG.down;
    if (reach - dist > Math.max(24, 0.25 * reach)) return;                 // pulled back: changed its mind
    if (Math.sign(v) === -dir && Math.abs(v) > 0.2) return;                // still moving back at release
    const dur = now - TG.t0;
    const speed = Math.max(Math.sign(v) === dir ? Math.abs(v) : 0, dur > 0 && dur < 300 ? dist / dur : 0);
    const far = dist >= Math.max(48, 0.07 * innerHeight);
    const flick = dist >= 24 && speed >= 0.3;
    if (!far && !flick) return;
    const k = Math.max(0, Math.min(N - 1, active - dir));                // finger up = onward
    if (k !== active) goTo(k); else hint.classList.add('gone');
  }, { passive: true });
  addEventListener('touchcancel', () => { TG.id = null; }, { passive: true });
  // leaving / entering the discrete mode at run time (a pointer attached or removed): the page scroll resumes /
  // stops storing the position
  touchMQ.addEventListener?.('change', () => {
    snapHC = 0;
    if (root.classList.contains('ride') && !discrete()) requestAnimationFrame(() => { window.scrollTo(0, Math.max(0, active) * snapH()); lastS = Math.max(0, active); });
  });
  // Resize / rotation: restore the stop progress recorded before the layout changed. (The browser may already
  // have re-snapped scrollY to the same stop in the new layout; rescaling that value again moved the ride.)
  // Only when the snap height really changed (rotation, window resize): the mobile toolbar hiding / showing
  // resizes the viewport but not the 100svh snaps, and restoring then would stop the visitor's fling. Nor
  // within 200 ms of a scroll event (a fling in progress).
  let lastSnapH = snapH();
  addEventListener('resize', () => {
    syncSheet();
    syncRailMore();
    const hNow = snapH();
    if (Math.abs(hNow - lastSnapH) < 0.5) return;
    lastSnapH = hNow;
    if (!root.classList.contains('ride') || discrete() || lastS === null) return;
    if (performance.now() - lastScrollT < 200) return;
    let s = navTarget ?? lastS;
    const r = Math.round(s);
    if (Math.abs(s - r) < 0.02) s = r;
    requestAnimationFrame(() => { window.scrollTo(0, s * snapH()); lastS = s; });
  });

  // in-page hash links (Quick Links etc.) become stop jumps in ride mode
  const stopForId = (id) => {
    const target = id && document.getElementById(id);
    if (!target) return -1;
    let st = target.closest('[data-stop]');
    if (!st && id === 'research') st = stops[firstPaper]?.el;
    return st ? stops.findIndex((s) => s.el === st) : -1;
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || !root.classList.contains('ride') || a.closest('#rail ol')) return;
    const id = a.getAttribute('href').slice(1);
    if (id === 'content') {
      // skip link: move focus to the current stop card without moving the ride
      e.preventDefault();
      const card = stops[Math.max(0, active)].el;
      card.setAttribute('tabindex', '-1');
      card.focus({ preventScroll: true });
      return;
    }
    const k = stopForId(id);
    if (k < 0) return;
    e.preventDefault();
    closeRail();
    goTo(k);
  });

  addEventListener('keydown', (e) => {
    if (!root.classList.contains('ride') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    // a focused card that can still scroll keeps the vertical keys (reading a long card)
    const vert = ['ArrowDown', 'ArrowUp', ' ', 'Home', 'End'].includes(e.key);
    if (vert && e.target instanceof Element && e.target.closest('main [data-stop], #rail') &&
      canScroll(e.target, e.key === 'ArrowUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey) ? -1 : 1)) return;
    if (e.target instanceof Element && e.target.closest('button, a') && e.key === ' ') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); goTo(active + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); goTo(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
    else if (e.key === 'End') { e.preventDefault(); goTo(N - 1); }
    else if (e.key === 'Escape') closeRail();
  });

  // ---------- text view toggle ----------
  // an icon (lines of text / the monorail car) that names the view it switches to; words only in aria-label
  function syncToggle() {
    const isText = root.classList.contains('text');
    toggle.innerHTML = isText ? ICON.car : ICON.text;
    toggle.setAttribute('aria-label', isText ? '3D view' : 'Text view');
  }
  toggle.addEventListener('click', () => setText(!root.classList.contains('text')));
  function setText(on) {
    const cur = Math.max(0, active);
    snapHC = 0;
    if (on) {
      ride?.pause();
      root.classList.remove('ride'); root.classList.add('text');
      syncToggle();
      requestAnimationFrame(() => {
        if (cur > 0) stops[cur].el.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
      });
    } else {
      root.classList.remove('text'); root.classList.add('ride');
      railW = -1;
      syncToggle();
      requestAnimationFrame(() => { window.scrollTo(0, discrete() ? 0 : cur * snapH()); setActive(cur); });
      if (ride) ride.resume(); else onWantRide?.();
    }
  }
  syncToggle();

  // ---------- initial position from URL (?stop= index|id, ?p= 0..1) ----------
  let initial = 0;
  if (P.has('stop')) {
    const v = P.get('stop');
    const byId = stops.findIndex((s) => s.id === v || s.el.id === v);
    initial = byId >= 0 ? byId : Math.max(0, Math.min(N - 1, parseInt(v, 10) || 0));
  } else if (P.has('p')) {
    const p = Math.max(0, Math.min(1, parseFloat(P.get('p')) || 0));
    initial = Math.min(N - 1, Math.ceil(p * (N - 1) - 1e-6));   // the stop the car is heading to
  } else if (location.hash.length > 1) {
    // deep links from the old site (/#research, /#news, /#intro, /#project ...) open at their stop
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    const k = stopForId(id);
    if (k >= 0) initial = k;
  }
  const pInit = P.has('p') ? Math.max(0, Math.min(1, parseFloat(P.get('p')) || 0)) : null;
  // With ?t (frozen time, used for screenshots) the stop is held without scrolling the document:
  // headless --screenshot does not paint position:fixed layers of a scrolled document.
  if (root.classList.contains('ride') && !P.has('t') && !discrete()) {
    const sInit = pInit !== null ? pInit * (N - 1) : initial;
    sInitial = sInit;
    lastS = sInit;
    window.scrollTo(0, sInit * snapH());
    requestAnimationFrame(() => window.scrollTo(0, sInit * snapH()));
  }
  setActive(initial);
  // Warm-up: draw every card once (invisibly) while the 3D is still loading, so the first switch to a card does
  // not rasterise it and compile Skia's blur/text shaders on the GPU thread in the middle of a departing frame.
  if (root.classList.contains('ride')) {
    root.classList.add('warm-cards');
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('warm-cards'))));
  }

  // ---------- ride state -> rail car marker, kicker state, dock progress ----------
  let lastState = '';
  let railW = -1;
  addEventListener('resize', () => { railW = -1; });
  function onRideState(st) {
    // st: { s (actual stop progress, float), moving (bool), atStop (index|-1), doorU }
    const x = N > 1 ? st.s / (N - 1) : 0;
    if (railW < 0) railW = railList.clientWidth;
    if (railW) railCar.style.transform = `translateX(${(railW / N) * (0.5 + clampS(st.s))}px)`;
    progI.style.transform = `scaleX(${Math.max(0.001, x)})`;
    const key = `${active}|${st.atStop === active ? 'now' : 'next'}`;
    if (key !== lastState) {
      lastState = key;
      const sEl = stops[active]?.kicker.querySelector('.state');
      if (sEl) {
        const now = st.atStop === active;
        sEl.textContent = now ? '●' : '▸';
        sEl.classList.toggle('moving', !now);
      }
    }
  }

  function setDebug(text) { if (debugEl) debugEl.textContent = text; }

  return {
    stops, N, getTargetS, goTo, onRideState, setDebug,
    get locked() { return lockedByParam && !userMoved; },
    initial, pInit,
    attachRide(r) {
      ride = r;
      // the visitor may have switched to Text view while the 3D was still loading
      if (!root.classList.contains('ride')) r.pause();
    },
    hologramClicked(i) {
      if (i !== active) { goTo(i); return; }
      const link = stops[i].links[0];
      if (link) window.open(link.href, '_blank', 'noopener');
    },
  };
}
