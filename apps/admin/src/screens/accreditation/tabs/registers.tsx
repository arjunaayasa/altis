import type { RegisterKind } from '@altis/shared/api/accreditation';
import { useId, useState, type JSX } from 'react';
import { ActivitiesRegister } from '@/components/accreditation/registers/activities';
import { BudgetsRegister } from '@/components/accreditation/registers/budgets';
import { DocumentsRegister } from '@/components/accreditation/registers/documents';
import { PartnershipsRegister } from '@/components/accreditation/registers/partnerships';
import { useCanManage } from '@/components/accreditation/registers/register-table';
import { StaffRegister } from '@/components/accreditation/registers/staff';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '@/i18n';

/**
 * The workspace tab Register (spec §6, §10.6): the library's five registers as sub-tabs, Kegiatan (activities with
 * their two flags), Tenaga & PKB (staff with their trainings inline), Kerja Sama (partnerships), Anggaran (budgets in
 * major units) and Dokumen (documents with their aspect checkboxes). Each lists, creates, edits and archives its rows,
 * and holds each row's attachments (components/accreditation/registers/). The registers belong to the whole library,
 * not to the period on screen, and stay editable while the period is frozen; without
 * `accreditation.workspace.manage` they are read only.
 */

const REGISTER_TABS: readonly RegisterKind[] = ['activities', 'staff', 'partnerships', 'budgets', 'documents'];

const isRegisterTab = (value: string): value is RegisterKind => (REGISTER_TABS as readonly string[]).includes(value);

export function RegistersTab(props: { periodId: string }): JSX.Element {
  const t = useT();
  const canManage = useCanManage();
  const headingId = useId();
  const [tab, setTab] = useState<RegisterKind>('activities');
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4" data-period-id={props.periodId}>
      <div className="grid gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('accreditation.registers.title')}
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('accreditation.registers.intro')}</p>
      </div>
      {!canManage && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('accreditation.registers.read_only')}</p>}
      <Tabs value={tab} onValueChange={(value) => (isRegisterTab(value) ? setTab(value) : undefined)}>
        <TabsList aria-label={t('accreditation.registers.tabs_label')} className="h-auto flex-wrap justify-start">
          {REGISTER_TABS.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {t(`accreditation.registers.tab.${kind}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="activities">
          <ActivitiesRegister />
        </TabsContent>
        <TabsContent value="staff">
          <StaffRegister />
        </TabsContent>
        <TabsContent value="partnerships">
          <PartnershipsRegister />
        </TabsContent>
        <TabsContent value="budgets">
          <BudgetsRegister />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsRegister />
        </TabsContent>
      </Tabs>
    </section>
  );
}
