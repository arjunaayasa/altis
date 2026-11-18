import { sha256hex } from '@altis/core';

// The hero slider's script: the OPAC's one script file, served from memory under a content hash (`opac.assets`) like
// the stylesheet, so the Content-Security-Policy needs nothing but `script-src 'self'`. It holds no inline handler and
// builds no markup from text; it only moves classes and attributes the page already carries.
//
// Without it the hero still works: the slides lie on top of each other in one grid cell (there is nothing to scroll),
// the first on top, and each indicator is a link `#slide-n` that brings its slide to the top (`:target`). With it:
//
// - the track gets the class `js`; one slide is `is-on`, the others are hidden from sight and from assistive technology
//   (`aria-hidden`, `inert`); a change fades (the stylesheet; no transition under `prefers-reduced-motion`);
// - the previous, next and pause buttons appear (`[data-js]`), the indicators change the slide without leaving the page;
// - the slides advance by themselves every `data-interval` seconds when `data-autoplay` says so, hold while the pointer
//   is over the hero or the focus is in it, and never start under `prefers-reduced-motion`; the pause button stops and
//   starts them and its label says which;
// - a touch swipe of more than 40 px changes the slide (pointer events; the page still scrolls up and down);
// - a change the visitor made is announced (`aria-live="polite"`); one the timer made is not.

/** The script (ES5, no dependency). */
export const OPAC_SLIDER_JS = `(function () {
  'use strict';
  var root = document.querySelector('[data-hero]');
  if (!root) return;
  var track = root.querySelector('.hero-track');
  var pauseBtn = root.querySelector('[data-pause]');
  var prevBtn = root.querySelector('[data-prev]');
  var nextBtn = root.querySelector('[data-next]');
  if (!track || !pauseBtn || !prevBtn || !nextBtn) return;
  var slides = Array.prototype.slice.call(track.children);
  if (slides.length < 2) return;
  var dots = Array.prototype.slice.call(root.querySelectorAll('.hero-dots a'));
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var seconds = Number(root.getAttribute('data-interval'));
  var interval = (seconds >= 3 && seconds <= 60 ? seconds : 7) * 1000;
  var auto = root.getAttribute('data-autoplay') === 'true';
  var i = 0, timer = null, paused = !auto || reduce.matches, held = false;

  slides.forEach(function (s, k) { if (location.hash === '#' + s.id) i = k; });
  Array.prototype.forEach.call(root.querySelectorAll('[data-js]'), function (el) { el.hidden = false; });
  track.classList.add('js');

  function sync(announce) {
    dots.forEach(function (d, k) { d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    slides.forEach(function (s, k) {
      s.classList.toggle('is-on', k === i);
      s.setAttribute('aria-hidden', k === i ? 'false' : 'true');
      s.inert = k !== i;
    });
    track.setAttribute('aria-live', announce || paused ? 'polite' : 'off');
  }
  function show(n, announce) {
    i = (n + slides.length) % slides.length;
    sync(announce);
  }
  function stop() { if (timer !== null) clearInterval(timer); timer = null; }
  function start() {
    stop();
    if (!paused) timer = setInterval(function () { if (!held) show(i + 1, false); }, interval);
  }
  function setPaused(p) {
    paused = p;
    pauseBtn.setAttribute('aria-label', p ? pauseBtn.getAttribute('data-label-play') : pauseBtn.getAttribute('data-label-pause'));
    var pauseIcon = pauseBtn.querySelector('[data-icon-pause]');
    var playIcon = pauseBtn.querySelector('[data-icon-play]');
    if (pauseIcon) pauseIcon.hidden = p;
    if (playIcon) playIcon.hidden = !p;
    if (p) stop(); else start();
    sync(false);
  }

  prevBtn.addEventListener('click', function () { show(i - 1, true); });
  nextBtn.addEventListener('click', function () { show(i + 1, true); });
  dots.forEach(function (d, k) { d.addEventListener('click', function (e) { e.preventDefault(); show(k, true); }); });
  pauseBtn.addEventListener('click', function () { setPaused(!paused); });
  root.addEventListener('mouseenter', function () { held = true; });
  root.addEventListener('mouseleave', function () { held = false; });
  root.addEventListener('focusin', function () { held = true; });
  root.addEventListener('focusout', function (e) { if (!root.contains(e.relatedTarget)) held = false; });

  var x0 = null;
  track.addEventListener('pointerdown', function (e) { x0 = e.pointerType === 'mouse' ? null : e.clientX; });
  track.addEventListener('pointerup', function (e) {
    if (x0 === null) return;
    var dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) show(dx < 0 ? i + 1 : i - 1, true);
  });
  track.addEventListener('pointercancel', function () { x0 = null; });

  setPaused(paused);
})();
`;

/** The file name the script is served under (`/assets/<file>`): it changes whenever the script does. */
export const OPAC_SLIDER_FILE = `opac-slider-${sha256hex(OPAC_SLIDER_JS).slice(0, 10)}.js`;
