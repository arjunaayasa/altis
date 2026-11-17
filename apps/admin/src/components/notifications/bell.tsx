import { BellIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { NotificationPanel, useUnreadNotifications } from './panel';

/**
 * The bell in the shell's header (spec §13.3 "pusat notifikasi"; Task 28): the caller's unread count, read again
 * whenever the realtime client hears a `notification` event (the shell makes `['notifications']` stale), and the
 * notification panel in a popover.
 */
export function NotificationBell() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const unread = useUnreadNotifications();
  const label = unread > 0 ? t('notifications.bell_unread', { count: unread }) : t('notifications.bell');
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label} title={label}>
          <BellIcon aria-hidden="true" />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground tabular-nums"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('notifications.title')}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-md border bg-popover text-popover-foreground shadow-md outline-none"
        >
          <NotificationPanel onNavigate={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
