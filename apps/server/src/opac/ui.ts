import { sha256hex } from '@altis/core';

// Progressive-enhancement UI script for OPAC pages (`opac.assets`), served under a content hash so CSP stays
// `script-src 'self'` with zero inline handlers. Without JavaScript, every OPAC page still works completely:
// `prefers-color-scheme` sets light/dark, native links navigate, and `<details>` opens the mobile menu.
//
// With JavaScript enabled:
// 1. Theme toggle (`[data-theme-toggle]`): reads/saves `altis.opac.theme` (`light` | `dark`) on `<html data-theme>`,
//    syncs `<picture><source>` dark logos, and smoothly cross-fades theme colours when clicked.
// 2. Smooth anchor scrolling: scrolls to `#id` targets on the current page (respecting `prefers-reduced-motion`) and
//    hands focus cleanly to the destination element.
// 3. Intent-debounced link preloading + top navigation progress bar (`[data-nav-progress]`): prefetches safe internal
//    GET pages on hover/touchstart (skipped when `saveData` is on) and glides a slim progress bar during navigation.
// 4. Below-the-fold scroll reveal: gently fades in sections below the initial viewport fold as they scroll into view
//    (never delaying above-the-fold LCP content, and disabled under `prefers-reduced-motion`).

export const OPAC_UI_JS = `(function () {
  'use strict';
  var doc = document.documentElement;
  var STORAGE_KEY = 'altis.opac.theme';
  var darkMedia = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var schemeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };

  function readStoredTheme() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function effectiveTheme() {
    var attr = doc.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return schemeMedia.matches ? 'dark' : 'light';
  }

  var stored = readStoredTheme();
  if (stored) doc.setAttribute('data-theme', stored);

  function syncThemeUi() {
    var active = effectiveTheme();
    var isDark = active === 'dark';
    var sources = document.querySelectorAll('.sitelogo picture source');
    for (var s = 0; s < sources.length; s++) {
      sources[s].setAttribute('media', stored ? (isDark ? 'all' : 'not all') : '(prefers-color-scheme: dark)');
    }
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      btn.hidden = false;
      btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      var label = btn.getAttribute(isDark ? 'data-label-to-light' : 'data-label-to-dark');
      if (label) btn.setAttribute('aria-label', label);
      var moon = btn.querySelector('[data-icon-moon]');
      var sun = btn.querySelector('[data-icon-sun]');
      if (moon) moon.hidden = isDark;
      if (sun) sun.hidden = !isDark;
    }
  }

  function toggleTheme() {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    stored = next;
    if (!darkMedia.matches) {
      doc.setAttribute('data-theme-switching', '');
      setTimeout(function () { doc.removeAttribute('data-theme-switching'); }, 260);
    }
    doc.setAttribute('data-theme', next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    syncThemeUi();
  }

  function boot() {
    syncThemeUi();
    if (schemeMedia.addEventListener) {
      schemeMedia.addEventListener('change', function () { if (!stored) syncThemeUi(); });
    }

    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', toggleTheme);
    }

    // Close mobile <details class="mobnav"> on Escape or outside click
    var mobnav = document.querySelector('details.mobnav');
    if (mobnav) {
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && mobnav.open) {
          mobnav.open = false;
          var sum = mobnav.querySelector('summary');
          if (sum) sum.focus();
        }
      });
      document.addEventListener('click', function (e) {
        if (mobnav.open && !mobnav.contains(e.target)) mobnav.open = false;
      });
    }

    // Navigation progress bar + smart link prefetching
    var bar = document.querySelector('[data-nav-progress]');
    var barTimer = null;
    function startBar() {
      if (!bar) return;
      if (barTimer) clearTimeout(barTimer);
      barTimer = setTimeout(function () {
        bar.hidden = false;
        bar.classList.remove('is-done');
        void bar.offsetWidth;
        bar.classList.add('is-active');
      }, 60);
    }
    function resetBar() {
      if (barTimer) { clearTimeout(barTimer); barTimer = null; }
      if (!bar) return;
      bar.classList.remove('is-active');
      bar.classList.add('is-done');
      setTimeout(function () {
        bar.hidden = true;
        bar.classList.remove('is-done');
      }, 220);
    }
    window.addEventListener('pageshow', resetBar);
    window.addEventListener('pagehide', resetBar);

    var prefetched = {};
    var prefetchCount = 0;
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var canPrefetch = !(conn && (conn.saveData || /2g/.test(conn.effectiveType || '')));

    function safeInternalUrl(anchor) {
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return null;
      var href = anchor.getAttribute('href');
      if (!href || href.charAt(0) === '#') return null;
      var u;
      try { u = new URL(anchor.href, location.href); } catch (e) { return null; }
      if (u.origin !== location.origin) return null;
      if (/^\\/(?:admin|api|files|site-icon|akun\\/keluar)(?:\\/|$)/.test(u.pathname)) return null;
      return u;
    }

    function prefetchUrl(u) {
      if (!canPrefetch || prefetchCount >= 14) return;
      var key = u.pathname + u.search;
      if (key === location.pathname + location.search || prefetched[key]) return;
      prefetched[key] = true;
      prefetchCount++;
      var link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = key;
      document.head.appendChild(link);
    }

    var hoverTimer = null;
    document.addEventListener('mouseover', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      var u = safeInternalUrl(a);
      if (!u) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { prefetchUrl(u); }, 65);
    });
    document.addEventListener('touchstart', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      var u = safeInternalUrl(a);
      if (u) prefetchUrl(u);
    }, { passive: true });

    // Smooth anchor scroll + navigation progress trigger
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.target || a.hasAttribute('download')) return;
      var u;
      try { u = new URL(a.href, location.href); } catch (err) { return; }
      if (u.origin !== location.origin) return;
      if (u.pathname === location.pathname && u.search === location.search && u.hash) {
        if (a.closest('.hero-dots')) return;
        var target = document.getElementById(u.hash.slice(1));
        if (target) {
          e.preventDefault();
          if (mobnav && mobnav.open) mobnav.open = false;
          target.scrollIntoView({ behavior: darkMedia.matches ? 'auto' : 'smooth', block: 'start' });
          if (history.pushState) history.pushState(null, '', u.hash);
          if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
        return;
      }
      if (u.pathname !== location.pathname || u.search !== location.search) {
        if (!/^\\/(?:files|berita\\/rss)(?:\\/|$)/.test(u.pathname) && !u.searchParams.has('unduh')) {
          startBar();
        }
      }
    });

    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (f && f.tagName === 'FORM' && (!f.method || f.method.toLowerCase() === 'get')) startBar();
    });

    // Subtle below-the-fold scroll reveal (never hides above-the-fold content; skipped on reduced motion)
    if (!darkMedia.matches && 'IntersectionObserver' in window) {
      var blocks = document.querySelectorAll('main > .section, main > .wrap.page > *');
      var fold = window.innerHeight * 0.94;
      var io = new IntersectionObserver(function (entries) {
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].isIntersecting) {
            var el = entries[j].target;
            el.classList.add('reveal-in');
            el.classList.remove('reveal-wait');
            io.unobserve(el);
          }
        }
      }, { threshold: 0.06, rootMargin: '0px 0px -24px 0px' });

      for (var k = 0; k < blocks.length; k++) {
        var b = blocks[k];
        if (b.getBoundingClientRect().top > fold) {
          b.classList.add('reveal-wait');
          io.observe(b);
        }
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;

/** Served under `/assets/<file>`; content-hashed and immutable. */
export const OPAC_UI_FILE = `opac-ui-${sha256hex(OPAC_UI_JS).slice(0, 10)}.js`;
