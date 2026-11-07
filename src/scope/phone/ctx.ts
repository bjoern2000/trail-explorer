// Trail Scope phone — the render context, types only.
//
// Every screen module is a pure function of this object: it reads state and derived
// results, and it writes back through `set` / `setUi`, which re-render. Keeping the
// interface in its own file (no runtime exports) means app.ts can import every screen and
// every screen can import this, with no import cycle.

import type { DisplaySet } from '../data';
import type { Units } from '../../types';
import type {
  ConditionGrade,
  PhoneState,
  RegionDef,
  ScopeTrail,
  WeatherProvider,
  WeatherResult,
} from '../types';

/** Which modal sheet is open. `peek` is a screen in PhoneState, so it is not listed here. */
export type SheetId = 'filters' | 'sort' | null;

/** Which filter group the sheet should scroll to when it opens. */
export type FilterGroupId = 'conditions' | 'effort' | 'character';

/**
 * Prototype-only view state that PhoneState (frozen in types.ts) does not carry, because
 * none of it is part of the product's own state model.
 */
export interface UiExtras {
  sheet: SheetId;
  /** The reader chose to see the trails the display rules exclude. */
  includeExcluded: boolean;
  /** Group the filter sheet scrolls to on open. */
  filterGroup: FilterGroupId;
  /** Search field has focus, so the entry screen shows suggestions rather than results. */
  searching: boolean;
}

export interface Ctx {
  state: PhoneState;
  ui: UiExtras;
  units: Units;
  region: RegionDef;
  provider: WeatherProvider;

  /** Counts behind the exclusion disclosure line. */
  display: DisplaySet;
  /** Everything eligible before search and filters. */
  pool: ScopeTrail[];
  /** After search, filters and sort. What the list and the map draw. */
  results: ScopeTrail[];
  /**
   * What the list would show right now: the filter sheet's live count. Identical to
   * `results.length` and stated separately so the sheet's Show button and the header
   * behind it can never disagree, which is the one thing that makes a live count useless.
   */
  filteredCount: number;

  /** Cached grade for the selected day, or for `day` when given. Null while pending. */
  grade(trail: ScopeTrail, day?: number): ConditionGrade | null;
  /** Cached hourly weather for a trail. Null while pending. */
  weather(trail: ScopeTrail): WeatherResult | null;
  /** Result count a candidate filter set would produce, for the live count in the sheet. */
  countWith(filters: PhoneState['filters']): number;

  set(patch: Partial<PhoneState>): void;
  setUi(patch: Partial<UiExtras>): void;
}
