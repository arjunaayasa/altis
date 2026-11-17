import type { SystemConfigView } from '@altis/shared/api/system-config';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, BRANCH_NORTH, USERS, adminMe, startApp, superMe, type FakeHandler } from './fake-api';

// Focus after a dialog (WCAG 2.4.3, 2.4.7): a keyboard or screen-reader user goes back to where they were, never to
// <body>. A secret shown after a confirmation opens only once the confirmation has closed (one modal at a time), so
// its "Selesai" returns to the row the action started from.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function usersRoutes(extra: Record<string, FakeHandler>): Record<string, FakeHandler> {
  return {
    'GET users': () => ({ items: USERS, total: USERS.length, page: 1, pageSize: 25 }),
    'GET branches': () => ({ items: [BRANCH_MAIN] }),
    ...extra,
  };
}

const rowOf = (username: string): HTMLElement => screen.getByRole('link', { name: username }).closest('tr')!;

/** The ⋯ button of a row, focused and opened as a keyboard user does; answers the button. */
async function openRowMenu(row: HTMLElement): Promise<HTMLElement> {
  const more = within(row).getByRole('button', { name: /^Tindakan untuk / });
  more.focus();
  fireEvent.keyDown(more, { key: 'Enter' });
  await screen.findByRole('menu');
  return more;
}

/** Watches the page for a moment when a confirmation and another dialog are open together; `stop()` tells. */
function watchStackedDialogs(): { stop(): boolean } {
  let stacked = false;
  const observer = new MutationObserver(() => {
    stacked ||= document.querySelector('[role="alertdialog"]') !== null && document.querySelector('[role="dialog"]') !== null;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    stop: () => {
      observer.disconnect();
      return stacked;
    },
  };
}

describe('users list', () => {
  it('the temporary password opens after the confirmation closed; "Selesai" returns to the row\'s ⋯ button', async () => {
    let reset = false;
    startApp({
      me: adminMe(),
      path: '/admin/users',
      routes: usersRoutes({
        // The list read after the reset takes a moment, as it does over a real network.
        'GET users': async () => {
          if (reset) await new Promise((resolve) => setTimeout(resolve, 50));
          return { items: USERS, total: USERS.length, page: 1, pageSize: 25 };
        },
        'POST users/:id/reset-password': () => {
          reset = true;
          return { temporaryPassword: 'abcd-efgh-jkmn-pqrs' };
        },
      }),
    });
    await screen.findByRole('link', { name: 'budi' });
    const more = await openRowMenu(rowOf('budi'));
    fireEvent.click(screen.getByRole('menuitem', { name: /kata sandi/ }));
    const confirm = await screen.findByRole('alertdialog');
    const watch = watchStackedDialogs();
    fireEvent.click(within(confirm).getAllByRole('button').at(-1)!);
    const shown = await screen.findByRole('dialog', { name: 'Kata sandi sementara' });
    // One modal at a time: the confirmation was gone before the password showed.
    expect(watch.stop()).toBe(false);
    fireEvent.click(within(shown).getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

});

describe('branches list', () => {
  it('when the action removed the row it started from, the focus goes to the main region, not <body>', async () => {
    let branches = [BRANCH_MAIN, BRANCH_NORTH];
    startApp({
      me: adminMe(),
      path: '/admin/branches',
      routes: {
        'GET branches': () => ({ items: branches }),
        'DELETE branches/:id': () => {
          branches = [BRANCH_MAIN];
          return { ...BRANCH_NORTH, archivedAt: 1, version: BRANCH_NORTH.version + 1 };
        },
      },
    });
    const row = (await screen.findByText(BRANCH_NORTH.code)).closest('tr')!;
    await openRowMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Arsipkan' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(screen.queryByText(BRANCH_NORTH.code)).toBeNull());
    await waitFor(() => expect(document.activeElement?.id).toBe('main'));
  });
});

describe('the cron token', () => {
  const VIEW: SystemConfigView = {
    baseUrl: 'https://perpus.example',
    trustProxy: { hops: 1 },
    allowedOrigins: [],
    smtp: { host: null, port: 587, security: 'starttls', username: null, password: { isSet: false }, from: null },
    cronToken: { isSet: true },
    locked: {},
  };

  it('opens after the confirmation closed; "Selesai" returns to "Ganti token cron"', async () => {
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: {
        'GET system/config': () => VIEW,
        // The answer takes a moment, as it does over a real network (and the reauth dialog may come first).
        'POST system/cron-token/rotate': async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { cronToken: 'cron-token-baru-0123456789abcdef' };
        },
      },
    });
    const rotate = await screen.findByRole('button', { name: 'Ganti token cron' });
    rotate.focus();
    fireEvent.click(rotate);
    const confirm = await screen.findByRole('alertdialog', { name: 'Ganti token cron?' });
    const watch = watchStackedDialogs();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Ganti token cron' }));
    const shown = await screen.findByRole('dialog', { name: 'Token cron baru' });
    expect(watch.stop()).toBe(false);
    fireEvent.click(within(shown).getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ganti token cron' })));
  });
});
