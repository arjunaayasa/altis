import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library unmounts what a test rendered only when `afterEach` is a global; Vitest runs without globals.
afterEach(() => {
  cleanup();
});

// What jsdom does not implement and the UI calls: cmdk measures its list (ResizeObserver) and scrolls the selected
// option into view, the router resets the scroll position after a navigation (jsdom would report "Not implemented").
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
window.scrollTo = () => {};
globalThis.ResizeObserver ??= class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
