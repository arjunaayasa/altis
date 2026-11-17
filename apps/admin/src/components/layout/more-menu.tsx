import { EllipsisIcon } from 'lucide-react';
import { createContext, useContext, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** The action chosen in an open {@link MoreMenu}, run once the menu has closed and given the focus back. */
const MoreMenuChoice = createContext<{ current: (() => void) | null }>({ current: null });

/**
 * The ⋯ button of a row or a page head: the shared dropdown menu (arrow keys, Home/End, Esc, type-ahead; the focus
 * returns to the button when it closes), its list drawn over the page so a table's scroll box never clips it. The
 * chosen action runs once the focus is back on the button, so an inline panel or a dialog it opens gives the focus
 * back there when it closes.
 */
export function MoreMenu({ label, small = false, children }: { label: string; small?: boolean; children: ReactNode }) {
  const choice = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <MoreMenuChoice.Provider value={choice}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} type="button" variant={small ? 'ghost' : 'outline'} size="icon" className={small ? 'size-8' : undefined} aria-label={label}>
            <EllipsisIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-52"
          onCloseAutoFocus={(event) => {
            const run = choice.current;
            choice.current = null;
            if (run === null) return;
            event.preventDefault();
            trigger.current?.focus();
            run();
          }}>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </MoreMenuChoice.Provider>
  );
}

/** One action of a {@link MoreMenu} (Enter, Space or a click chooses it), red when it destroys data. */
export function MoreMenuItem({ danger = false, onSelect, children, ...props }: { danger?: boolean; onSelect(): void; children: ReactNode; 'aria-label'?: string }) {
  const choice = useContext(MoreMenuChoice);
  return (
    <DropdownMenuItem
      variant={danger ? 'destructive' : 'default'}
      className="h-8 px-2.5 whitespace-nowrap"
      onSelect={() => {
        choice.current = onSelect;
      }}
      {...props}>
      {children}
    </DropdownMenuItem>
  );
}

/** A thin rule between groups of a {@link MoreMenu}. */
export function MoreMenuRule() {
  return <DropdownMenuSeparator />;
}
