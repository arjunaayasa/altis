import { cn } from '@/lib/utils';

/** A wizard's numbered steps; the current one is marked (`aria-current="step"`), the ones before it as done. */
export function Steps({ steps, current, label, doneLabel }: { steps: readonly string[]; current: number; label: string; doneLabel: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
      {steps.map((text, i) => {
        const state = i === current ? 'current' : i < current ? 'done' : 'next';
        return (
          <li key={text} aria-current={state === 'current' ? 'step' : undefined} className={cn('flex items-center gap-2', state === 'current' ? 'font-bold text-foreground' : state === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/80')}>
            <span
              className={cn(
                'inline-grid size-5.5 place-items-center rounded-md border text-xs font-bold tabular-nums',
                state === 'current' && 'border-primary bg-primary text-primary-foreground',
                state === 'done' && 'border-ok-line text-ok',
              )}>
              {i + 1}
            </span>
            {text}
            {state === 'done' && <span className="sr-only"> ({doneLabel})</span>}
          </li>
        );
      })}
    </ol>
  );
}
