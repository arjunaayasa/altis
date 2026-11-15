/**
 * The numbers of the day at a desk's branch, for the dashboard: `GET branches/:branchId/circulation/summary`
 * (`circulation.desk.use` at the branch). `on` is today in the branch's time zone; `loaned` counts the loans lent there
 * today (a voided one not), `returned` the copies given back there today, `overdue` the open loans of the branch due
 * before today, `holdsReady` the holds kept on its shelf for pickup.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/circulation-summary`.
 */
export interface CirculationDaySummary {
  branchId: string;
  on: string;
  loaned: number;
  returned: number;
  overdue: number;
  holdsReady: number;
}
