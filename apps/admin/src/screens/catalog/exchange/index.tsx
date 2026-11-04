import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { ExportForm, clearExportSelection, readExportSelection, type ExportSelection } from './export-form';
import { ImportWizard } from './import-wizard';
import { RunsTable } from './runs-table';
import { isExchangeTab, validateExchangeSearch, type ExchangeTab } from './search';

/**
 * Impor/Ekspor (Phase 2 spec §13, §5.3, §5.4; plan Task 29): the tabs Impor (the wizard, `catalog.import.run`),
 * Ekspor (the form, `catalog.export.run`) and Riwayat (the catalog runs, for every reader of the catalog).
 *
 * - The open tab is the `tab` search param, so a tab can be linked to (the run page's way back opens Riwayat); a tab
 *   the user may not use falls back to the first one offered.
 * - The wizard and the form stay mounted while another tab is open (hidden), so a dry run being read or a form being
 *   filled survives a look at Riwayat. Riwayat is read afresh each time it opens.
 * - `?export=selection` (Bibliografi's "Ekspor terpilih", M2) opens Ekspor with the stored selection: it is read once
 *   when the page opens, the storage is cleared, and the address becomes `?tab=export`.
 */

const PATH = '/admin/catalog/exchange';

export function ExchangeScreen() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const search = validateExchangeSearch(useSearch({ strict: false }));
  const canImport = holds(me, 'catalog.import.run');
  const canExport = holds(me, 'catalog.export.run');
  const tabs: ExchangeTab[] = [...(canImport ? (['import'] as const) : []), ...(canExport ? (['export'] as const) : []), 'runs'];
  const wanted = search.export === 'selection' ? 'export' : search.tab;
  const tab: ExchangeTab = wanted !== undefined && tabs.includes(wanted) ? wanted : tabs[0]!;

  // Read once, as the page opens (a pure read: React may run this twice); the effect below clears the storage.
  const [selection, setSelection] = useState<ExportSelection | null>(() =>
    search.export === 'selection' && canExport ? readExportSelection() : null,
  );
  const askedSelection = search.export === 'selection';
  useEffect(() => {
    if (!askedSelection) return;
    clearExportSelection();
    void navigate({ to: PATH, search: canExport ? { tab: 'export' } : {}, replace: true });
  }, [askedSelection, canExport, navigate]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex max-w-2xl flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('nav.catalog.exchange')}</h1>
        <p className="text-sm text-muted-foreground">{t('catalog.exchange.description')}</p>
      </header>
      <Tabs value={tab} onValueChange={(value) => isExchangeTab(value) && value !== tab && void navigate({ to: PATH, search: { tab: value } })}>
        <TabsList aria-label={t('catalog.exchange.tabs')}>
          {tabs.map((k) => (
            <TabsTrigger key={k} value={k}>
              {t(`catalog.exchange.tab.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {canImport && (
          <TabsContent value="import" forceMount hidden={tab !== 'import'} className="pt-2">
            <ImportWizard />
          </TabsContent>
        )}
        {canExport && (
          <TabsContent value="export" forceMount hidden={tab !== 'export'} className="pt-2">
            <ExportForm selection={selection} onDropSelection={() => setSelection(null)} />
          </TabsContent>
        )}
        <TabsContent value="runs" className="pt-2">
          <RunsTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}
