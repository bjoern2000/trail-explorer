// Regional conditions digest — the generated summary.
//
// The sentences at the top of the page. Every one of them is assembled here from
// `model.ts`'s aggregates and NOTHING in them is written for a particular region, scenario
// or day: switch the chrome controls and the same five functions produce five different
// sentences, or refuse to produce one where the grades do not support it.
//
// WHY IT IS A LIST OF CLAIMS AND NOT A PARAGRAPH. A generated paragraph has to hold
// together as prose, which means the generator has to make connective decisions ("but",
// "although", "which means") that the data cannot justify, and the first time two clauses
// disagree the reader stops trusting all of them. A labelled claim carries its own scope,
// says one thing, and can be absent when there is nothing to say. So each claim is a
// question the reader actually asked, answered in one or two sentences, and a claim that
// has no answer on a given day returns the honest negative rather than being dropped.
//
// COPY RULES, all inherited:
//   - No risk language, no recommendation, no hazard named (TRAIL_PLAN §1). These sentences
//     state counts, bands and hours. "The day turns at 14:00" is a fact about the forecast;
//     "leave before 14:00" is advice, and this page does not give it.
//   - No decimal places on percentages, and in fact almost no percentages: at 4 routes in a
//     band a percentage is false precision, so the claims count rather than divide.
//   - No em dashes. First person singular where a first person is used at all.
//   - EVERY CLAIM IS THE ANSWER AND NOT THE REASONING BEHIND IT. Several of these used to
//     close with a second sentence explaining why the first was phrased as it was ("past the
//     horizon the grade is a call about the day, and an outlook cannot say when a day
//     changes"). At five claims that is five short essays on the model's own limits stacked
//     at the top of the page. The limit is still stated; the lecture about it is not.

import type { DigestDay, RegionDigest } from './model';
import { bandDef, bandExtremes, hourLabel } from './model';
import type { GradeLevel } from '../scope/types';

export interface DigestClaim {
  /** Mono overline. Names the question, never restates the sentence. */
  label: string;
  /** One or two sentences. Plain text: the renderer sets tabular figures in CSS. */
  text: string;
}

/**
 * "none" for a zero, everywhere, and not only where it happens to open a clause.
 *
 * Mixing the two forms in one sentence ("5 Good, 0 Mixed, none Poor") reads as though the
 * zero and the none were different measurements. They are the same measurement.
 */
function count(n: number): string {
  return n === 0 ? 'none' : String(n);
}

/** "none of 10" reads better than "0 of 10" in a sentence, and means the same thing. */
function ofCount(n: number, total: number): string {
  return `${count(n)} of ${total}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Band labels are stored in sentence case for the matrix; a sentence may need them capital. */
function upperFirst(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** How the sentences name the day: "Wednesday" now, "Wednesday (today)" for the near two. */
function dayName(day: DigestDay): string {
  return day.relative ? `${day.weekday} (${day.relative.toLowerCase()})` : day.weekday;
}

/**
 * What the region grades on this day, in the pill's own three words.
 *
 * The one claim that is always present, because a level exists for every route on every day
 * the scrubber offers, including past the horizon: `outlookGrade` returns a real level
 * rather than refusing, which is the whole reason the filtered list stopped emptying out
 * there. The sentence names the outlook where it applies, so the count is never read as a
 * route-specific claim.
 */
function levelsClaim(day: DigestDay): DigestClaim {
  const { prime, mixed, poor } = day.counts;
  const where = day.outlook ? ' That grade is for the area, not the route.' : '';
  return {
    label: 'The grades',
    text:
      `${ofCount(prime, day.total)} ${plural(day.total, 'route', 'routes')} grade Good on ` +
      `${dayName(day)}, ${count(mixed)} Mixed and ${count(poor)} Poor.${where}`,
  };
}

/** "69 Good, 4 Mixed, none Poor" — the whole distribution, never one level of it. */
function levelBreak(counts: Record<GradeLevel, number>): string {
  return `${count(counts.prime)} Good, ${count(counts.mixed)} Mixed, ${count(counts.poor)} Poor`;
}

/**
 * The band split: the finding, when there is one.
 *
 * BOTH BANDS PRINT ALL THREE LEVELS, rather than the sentence naming the Good count on each
 * side. The Good count alone is silent on exactly the days the split is starkest: past the
 * horizon under storms at RMNP nothing in the region grades Good, so a Good-count sentence
 * reads "none of 73 below treeline, none of 10 above" and describes two identical bands
 * where one is 72 Mixed against 1 Poor and the other is 1 against 9.
 *
 * Returns the honest negative rather than nothing when the bands genuinely do not separate.
 * A day on which the terrain makes no difference is a real result, and it is the one the
 * Ozarks produces under half the scenarios, so hiding it would leave the page arguing for
 * terrain-awareness only on the days that happen to flatter it.
 */
function patternClaim(digest: RegionDigest, day: DigestDay): DigestClaim {
  const axisWord = digest.bands.axis === 'treeline' ? 'elevation' : 'drainage';
  const ends = bandExtremes(day);
  if (!ends) {
    return {
      label: 'The pattern',
      text: `Every band grades alike on ${dayName(day)}: ${axisWord} separates nothing here.`,
    };
  }
  const best = bandDef(digest, ends.best.bandId).label.toLowerCase();
  const worst = bandDef(digest, ends.worst.bandId).label.toLowerCase();
  return {
    label: 'The pattern',
    text:
      `${upperFirst(best)} highest: ${levelBreak(ends.best.counts)} of ${ends.best.total}. ` +
      `${upperFirst(worst)} lowest: ${levelBreak(ends.worst.counts)} of ${ends.worst.total}.`,
  };
}

/**
 * When the day turns, from the hours the grades themselves name.
 *
 * Past the horizon there is no hour to give, and the claim says so in as many words instead
 * of going missing: "no hour" is the single most load-bearing consequence of the +36 h
 * constraint for a reader planning a weekend, and a silently absent sentence would let them
 * conclude the day simply does not turn.
 */
function turnClaim(digest: RegionDigest, day: DigestDay): DigestClaim {
  if (day.outlook) {
    return {
      label: 'When it turns',
      text: `No hour on ${dayName(day)}: an outlook is a call about the day and cannot say when one changes.`,
    };
  }
  if (day.turnHour === null) {
    return {
      label: 'When it turns',
      text: `Nothing on ${dayName(day)} is time-bound: no route names an hour.`,
    };
  }
  return {
    label: 'When it turns',
    text:
      `${day.turnCount} ${plural(day.turnCount, 'route names an hour', 'routes name an hour')}, ` +
      `median ${hourLabel(digest, day.turnHour)}.`,
  };
}

/**
 * Where the windows agree, and how many routes have none.
 *
 * The count with no window is stated every time it is non-zero, because it is the number a
 * summary is most tempted to leave out: a page that shows a consensus window and quietly
 * omits the routes that do not fit inside it has described a better day than the grades
 * did.
 */
/*
 * The label is "The windows" and not "Where the windows agree", which is what it used to be
 * and is verbatim the heading of section 3 two objects below it. `DigestClaim.label` says an
 * overline names the question and never restates the sentence; the same rule has to hold
 * against the rest of the page, or the page says one phrase twice in two different type
 * sizes.
 */
function windowClaim(digest: RegionDigest, day: DigestDay): DigestClaim {
  if (day.outlook) {
    return {
      label: 'The windows',
      text: `No window on ${dayName(day)}: a window is an hourly claim and there are no hours out there.`,
    };
  }
  if (!day.consensus) {
    return {
      label: 'The windows',
      text: `No route carries a window on ${dayName(day)}.`,
    };
  }
  // The peak is stated as a peak, not as a window every one of those routes shares. Two
  // hours can both sit at the peak count without the same routes being behind them, so
  // "56 of 87 share 08:00 to 12:00" would be a claim the coverage curve does not support.
  // "Agreement peaks at N routes in each of those hours" is exactly what was measured.
  const from = hourLabel(digest, day.consensus.startHour);
  const to = hourLabel(digest, day.consensus.endHour);
  const span =
    day.consensus.endHour - day.consensus.startHour <= 1
      ? `Peaks at ${from}, ${day.consensus.count} of ${day.total} routes over it.`
      : `Peaks ${from} to ${to}, ${day.consensus.count} of ${day.total} routes in each hour.`;
  // "Every route carries one" beside "125 of 180 over that hour" needs the qualifier, or the
  // two counts read as a contradiction rather than as an hour and a day.
  const none =
    day.noWindow === 0
      ? ' Every route carries one somewhere.'
      : ` ${day.noWindow} ${plural(day.noWindow, 'carries', 'carry')} none.`;
  return { label: 'The windows', text: `${span}${none}` };
}

/**
 * How much of the week is route-specific. The claim that does not move with the day.
 *
 * Written off `firstOutlook`, which `phone/grading.ts` derives from `provider.horizonHours`,
 * so a provider with a longer horizon rewrites this sentence without anyone editing it.
 */
function horizonClaim(digest: RegionDigest): DigestClaim {
  const inHorizon = digest.days.filter((d) => !d.outlook);
  const outlook = digest.days.length - inHorizon.length;
  const named = inHorizon.map((d) => d.weekday).join(' and ');
  const horizon = `+${Math.round(digest.horizonH)} h`;
  if (inHorizon.length === 0) {
    return {
      label: 'How far ahead',
      text: `No day in the week is inside the ${horizon} horizon, so every column is a regional outlook.`,
    };
  }
  return {
    label: 'How far ahead',
    text:
      `${named} ${plural(inHorizon.length, 'is', 'are')} hourly and route-specific, inside ${horizon}. ` +
      `The other ${outlook} are outlook: no hour, no window.`,
  };
}

/**
 * The whole summary, in reading order: what, where, when, how long the window is, how far
 * ahead any of it holds. Order is fixed rather than ranked by interest, because a digest a
 * reader returns to has to be in the same order every time.
 */
export function summaryClaims(digest: RegionDigest, day: DigestDay): DigestClaim[] {
  return [
    levelsClaim(day),
    patternClaim(digest, day),
    turnClaim(digest, day),
    windowClaim(digest, day),
    horizonClaim(digest),
  ];
}
