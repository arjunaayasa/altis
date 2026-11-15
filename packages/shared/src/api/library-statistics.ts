/**
 * The library's figures at a glance on the dashboard, each from its own module's endpoint and for the holders of that
 * module's read permission. Counts only, never a name or a number of a person. `today` is today in the library's time
 * zone and `year` its year; a month series (`byMonth`) holds the twelve months of that year, January first.
 *
 * - `GET catalog/statistics` (`catalog.records.read`) → {@link CollectionStatistics}: the titles and copies in the
 *   stock today, and the copies received this year (by the acquisition date the collection reports use: the receiving
 *   date, else the date entered in the source system, else the day the copy was made here, or for a migrated copy the
 *   day its record was made in the source system).
 * - `GET members/statistics` (`members.records.read`) → {@link MemberStatistics}: the members on the register, those
 *   whose membership is valid today, and those who joined this year.
 * - `GET visits/statistics` (`visits.records.read`) → {@link VisitStatistics}: people who visited (head counts, voided
 *   visits left out) this month, this year and per month of the year.
 * - `GET circulation/statistics` (`circulation.records.read`) → {@link LoanStatistics}: loans lent (voided ones left
 *   out) this month, this year and per month of the year, the open loans and the overdue ones.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/library-statistics`.
 */

export interface CollectionStatistics {
  today: string;
  year: number;
  titles: number;
  items: number;
  receivedThisYear: number;
}

export interface MemberStatistics {
  today: string;
  year: number;
  registered: number;
  valid: number;
  joinedThisYear: number;
}

export interface VisitStatistics {
  today: string;
  year: number;
  thisMonth: number;
  thisYear: number;
  byMonth: number[];
}

export interface LoanStatistics {
  today: string;
  year: number;
  thisMonth: number;
  thisYear: number;
  byMonth: number[];
  open: number;
  overdue: number;
}
