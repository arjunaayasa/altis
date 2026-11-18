import { OPAC_HOME_CONTACT_LIMITS, OPAC_HOME_LIMITS, OPAC_HOME_WEEKDAYS } from '@altis/shared/api/opac-home';
import { Link } from '@tanstack/react-router';
import { CheckField, Field } from '@/components/form-field';
import { Card, FORM_FULL, FormSection } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { newRowKey } from './draft';
import { ControlError, EditableList, useHomeEditor } from './parts';

/**
 * The tab "Jam & kontak": the opening hours (each row the days and the time as visitors read them, and the weekdays it
 * covers, by which the site marks today's row) and the telephone number and e-mail address the site publishes.
 */
export function HoursTab() {
  const t = useT();
  const { draft, edit, errorAt } = useHomeEditor();
  return (
    <Card>
      <FormSection title={t('opacHome.hours.title')} intro={t('opacHome.hours.description')}>
        <EditableList
          className={FORM_FULL}
          legend={t('opacHome.hours.title')}
          rows={draft.hours}
          max={OPAC_HOME_LIMITS.hours}
          empty={t('opacHome.hours.empty')}
          addLabel={t('opacHome.hours.add')}
          labels={(n) => ({ up: t('opacHome.hours.up_label', { n }), down: t('opacHome.hours.down_label', { n }), remove: t('opacHome.hours.remove_label', { n }) })}
          create={() => ({ key: newRowKey(), days: '', time: '', weekdays: [] as number[] })}
          update={(change, places) => edit((d) => ({ ...d, hours: change(d.hours) }), places ? ['home.hours'] : undefined)}>
          {(row, i, set) => {
            const n = i + 1;
            const weekdaysError = errorAt(`home.hours.${i}.weekdays`);
            return (
              <>
                <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                  <Field label={t('opacHome.hours.days', { n })} error={errorAt(`home.hours.${i}.days`)}>
                    {(c) => <Input {...c} value={row.days} maxLength={OPAC_HOME_LIMITS.hoursDays} placeholder={t('opacHome.hours.days_placeholder')} onChange={(e) => set({ days: e.target.value })} />}
                  </Field>
                  <Field label={t('opacHome.hours.time', { n })} error={errorAt(`home.hours.${i}.time`)}>
                    {(c) => <Input {...c} value={row.time} maxLength={OPAC_HOME_LIMITS.hoursTime} placeholder={t('opacHome.hours.time_placeholder')} onChange={(e) => set({ time: e.target.value })} />}
                  </Field>
                </div>
                <fieldset aria-describedby={weekdaysError === undefined ? undefined : `hours-${row.key}-weekdays-error`}>
                  <legend className="mb-1 text-meta font-semibold">{t('opacHome.hours.weekdays', { n })}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {OPAC_HOME_WEEKDAYS.map((day) => (
                      <CheckField
                        key={day}
                        label={t(`opacHome.hours.weekday.${day}` as TKey)}
                        checked={row.weekdays.includes(day)}
                        onChange={(e) => {
                          const on = e.target.checked;
                          set({ weekdays: OPAC_HOME_WEEKDAYS.filter((w) => (w === day ? on : row.weekdays.includes(w))) });
                        }}
                      />
                    ))}
                  </div>
                  {weekdaysError !== undefined && <ControlError id={`hours-${row.key}-weekdays-error`}>{t(weekdaysError)}</ControlError>}
                </fieldset>
              </>
            );
          }}
        </EditableList>
      </FormSection>

      <FormSection title={t('opacHome.identity.title')} intro={t('opacHome.identity.description')}>
        {/* The logo is part of the site's identity; the one loaded here is sent back as it was. */}
        <p className={cn('text-meta text-muted-foreground', FORM_FULL)}>
          {t('siteIdentity.moved.note')}{' '}
          <Link to="/admin/opac/identitas" className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('siteIdentity.moved.link')}
          </Link>
        </p>
        <Field label={t('opacHome.contact.phone')} hint={t('opacHome.contact.phone_hint')} error={errorAt('home.contact.phone')}>
          {(c) => <Input {...c} type="tel" autoComplete="off" value={draft.phone} maxLength={OPAC_HOME_CONTACT_LIMITS.phone} onChange={(e) => edit((d) => ({ ...d, phone: e.target.value }), ['home.contact.phone'])} />}
        </Field>
        <Field label={t('opacHome.contact.email')} hint={t('opacHome.contact.email_hint')} error={errorAt('home.contact.email')}>
          {(c) => <Input {...c} type="email" autoComplete="off" value={draft.email} maxLength={OPAC_HOME_CONTACT_LIMITS.email} onChange={(e) => edit((d) => ({ ...d, email: e.target.value }), ['home.contact.email'])} />}
        </Field>
      </FormSection>
    </Card>
  );
}
