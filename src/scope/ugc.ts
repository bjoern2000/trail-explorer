// Trail Scope — user-generated content.
//
// WHY THIS FILE EXISTS. The benchmark established that open data carries no ratings, no
// photos and no reviews, and §6's finding is that this leaves no honest popularity sort:
// the prominence proxy is a weak substitute and the page says so. UGC is the answer to
// that gap. It is how a product EARNS the crowd signal open data cannot supply, so
// prototyping it here is prototyping the cold-start plan, not decorating the card.
//
// THE HONESTY RULE, and how this file keeps it.
//
//   Seeded content is FABRICATED. It is generated deterministically from the trail id, so
//   it is stable across reloads and across renders, but it is not a measurement of
//   anything. Every seeded artefact carries `origin: 'sample'` and every surface that
//   prints one must label it, exactly as simulated weather is labelled.
//
//   Reader contributions carry `origin: 'mine'`. They are NEVER folded into the seeded
//   counts: `ratingAvg` and `ratingCount` describe the sample population alone, and the
//   reader's own rating rides separately in `myRating`. Mixing them would make one number
//   part-real and part-invented, which is the exact failure the page argues against.
//
//   Sample comment text is deliberately flat and self-describing. It must never read as a
//   real person's testimony about a real place: a fabricated trip report is a different
//   and worse thing than an obviously illustrative placeholder.
//
// DETERMINISM. No Math.random() at render time. A card that reshuffled its review count on
// every re-render would be visibly fake in the wrong way, and the Top rated sort would not
// be a sort at all.

import { allTrails } from './data';
import type { RegionId, TrailUgc, UgcComment, UgcPhoto } from './types';

// ============================================================================
// SEEDED RANDOMNESS
// ============================================================================

/** FNV-1a. Small, fast, and stable across engines, which is all this needs. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: one seed in, a repeatable stream of 0..1 out. */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ============================================================================
// THE TRAIL BEHIND AN ID
// ============================================================================

/**
 * The prominence proxy gates who gets any seeded content at all. It is the only signal
 * available that correlates with the routes a first cohort would actually walk, so the
 * few trails that carry a rating are the flagships rather than a random scatter.
 *
 * Trail ids are `<region>/<slug>`, so the region falls out of the id and this stays a
 * lookup by id as the API promises.
 */
function prominenceOf(trailId: string): number {
  const region = trailId.split('/')[0] as RegionId;
  if (region !== 'rmnp' && region !== 'adk' && region !== 'ozarks') return 0.3;
  const hit = allTrails(region).find((t) => t.id === trailId);
  return hit ? hit.prominence : 0.3;
}

// ============================================================================
// SAMPLE CONTENT
// ============================================================================

// Flat, generic, and self-describing on purpose. See the honesty rule in the header.
const SAMPLE_TEXT: string[] = [
  'Sample review text. A real review would sit here.',
  'Placeholder text, generated to show the layout.',
  'Sample text standing in for a hiker report.',
  'Illustrative only. Not a real account of this trail.',
  'Sample review text, seeded from the trail id.',
];

const SAMPLE_CAPTION: string[] = [
  'Sample photo slot',
  'Placeholder image',
  'Sample photo slot',
];

/** Numbered rather than named: a fake persona is a fake person. */
const sampleAuthor = (n: number): string => `Sample reviewer ${n}`;

function relativeWhen(days: number): string {
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

// ============================================================================
// THE SEED
// ============================================================================

interface Seeded {
  ratingAvg: number | null;
  ratingCount: number;
  photos: UgcPhoto[];
  comments: UgcComment[];
}

const SEED_CACHE = new Map<string, Seeded>();

// ---- the distribution, and why it is this shape -------------------------------------
//
// DAY ONE HAS NO CROWD. An earlier pass seeded nearly every trail with a rating and gave
// the flagships hundreds of reviews, which was wrong on the argument and not only on the
// pixels: a populated community is exactly what open data cannot hand you, so drawing one
// hides the problem this page exists to show. The honest picture is a large majority of
// trails with nothing at all, a handful with a little, and fewer still with a photo.
//
// Three gates, all deterministic from the trail id:
//
//   RATED_FLOOR  no trail below this prominence gets seeded content at all, so the few
//                that carry a rating are the routes a first cohort would plausibly walk.
//   RATED_SLOPE  above the floor the chance rises linearly with prominence and still tops
//                out well under a coin flip, so even the flagships mostly have nothing.
//   the counts   single digits to low teens. A first cohort leaves a handful of ratings,
//                not a review corpus.
//
// Measured over the three committed regions (the display set, which is what the list
// shows): RMNP 12 of 87 rated, 5 with a photo, 7 with a comment; Adirondacks 10 of 180,
// 2, 8; Ozarks 4 of 38, 2, 4. So 86, 94 and 89 percent of each list has nothing at all.
// Retune here and re-measure against the derived data, never by eye.
const RATED_FLOOR = 0.4;
const RATED_SLOPE = 1.5;
/** Of the trails that have a rating, roughly this share carry a sample comment. */
const COMMENT_CHANCE = 0.6;
/** Photos are the rarest artefact: they cost the most effort to contribute. */
const PHOTO_CHANCE = 0.45;

/**
 * One shared instance for the large majority of trails that have nothing. Frozen because
 * it is shared: pushing into it would give every unrated trail in the app one trail's
 * photos, and a frozen object turns that mistake into an immediate error instead.
 * `getUgc` copies these arrays before handing them out, so callers are unaffected.
 */
const EMPTY: Seeded = Object.freeze({
  ratingAvg: null,
  ratingCount: 0,
  photos: Object.freeze([] as UgcPhoto[]) as UgcPhoto[],
  comments: Object.freeze([] as UgcComment[]) as UgcComment[],
});

function seededFor(trailId: string): Seeded {
  const hit = SEED_CACHE.get(trailId);
  if (hit) return hit;

  const p = prominenceOf(trailId);
  const rnd = rngFrom(hash32(trailId));

  // Gate one: does this trail have anything at all? For the large majority, no.
  const chance = p <= RATED_FLOOR ? 0 : (p - RATED_FLOOR) * RATED_SLOPE;
  if (rnd() >= chance) {
    SEED_CACHE.set(trailId, EMPTY);
    return EMPTY;
  }

  // A first cohort's worth: one rating to about a dozen, the ceiling scaled by prominence.
  const ratingCount = 1 + Math.floor(rnd() * (2 + p * 12));

  // The mean is the mean of the individual seeded stars rather than a number invented
  // beside them. With counts this small the two visibly disagree otherwise: three ratings
  // cannot average 4.4, and a reader who can count the reviews would see it.
  let sum = 0;
  const stars: number[] = [];
  for (let i = 0; i < ratingCount; i++) {
    const star = clamp(Math.round(3.4 + p * 0.7 + (rnd() - 0.35) * 1.7), 1, 5);
    stars.push(star);
    sum += star;
  }
  const ratingAvg = Math.round((sum / ratingCount) * 10) / 10;

  const photos: UgcPhoto[] = [];
  const comments: UgcComment[] = [];

  // Gate two: a comment, on rather more than half of the rated trails. Never more than
  // there are ratings, and it reuses one of the seeded stars, so the numbers agree.
  if (rnd() < COMMENT_CHANCE) {
    const nComments = Math.min(ratingCount, 1 + Math.floor(rnd() * 2));
    // Distinct numbers within a trail. Two adjacent rows both reading "Sample reviewer 5"
    // looks like a rendering bug rather than like sample content.
    const base = 1 + Math.floor(rnd() * 5);
    for (let i = 0; i < nComments; i++) {
      comments.push({
        id: `${trailId}#c${i}`,
        authorName: sampleAuthor(base + i),
        when: relativeWhen(1 + Math.floor(rnd() * 120)),
        text: SAMPLE_TEXT[Math.floor(rnd() * SAMPLE_TEXT.length)],
        rating: stars[i],
        origin: 'sample',
      });
    }
  }

  // Gate three: a photo, rarer than either.
  if (rnd() < PHOTO_CHANCE) {
    const nPhotos = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < nPhotos; i++) {
      photos.push({
        id: `${trailId}#p${i}`,
        caption: SAMPLE_CAPTION[Math.floor(rnd() * SAMPLE_CAPTION.length)],
        authorName: sampleAuthor(1 + Math.floor(rnd() * 9)),
        when: relativeWhen(1 + Math.floor(rnd() * 90)),
        origin: 'sample',
      });
    }
  }

  const made: Seeded = { ratingAvg, ratingCount, photos, comments };
  SEED_CACHE.set(trailId, made);
  return made;
}

// ============================================================================
// THE SESSION STORE
// ============================================================================
//
// What the reader adds. Ratings and comments persist to localStorage so a reload does not
// erase the demo; photos do not, because an object URL is dead the moment the document
// that minted it goes away. Persisting a photo record with no usable src would render an
// empty tile that claims to be the reader's upload, which is worse than losing it.

const STORAGE_KEY = 'trailscope.ugc.v1';

interface MineRecord {
  myRating: number | null;
  comments: UgcComment[];
}

type MineStore = Record<string, MineRecord>;

let mine: MineStore = loadMine();

function loadMine(): MineStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: MineStore = {};
    for (const [id, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Partial<MineRecord>;
      out[id] = {
        myRating: typeof r.myRating === 'number' ? r.myRating : null,
        comments: Array.isArray(r.comments) ? r.comments.filter(isComment) : [],
      };
    }
    return out;
  } catch {
    // A private-mode browser or a corrupt entry must not take the page down with it.
    return {};
  }
}

function isComment(v: unknown): v is UgcComment {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<UgcComment>;
  return typeof c.id === 'string' && typeof c.text === 'string' && c.origin === 'mine';
}

function saveMine(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mine));
  } catch {
    /* Quota or private mode. The session still works; only persistence is lost. */
  }
}

function recordFor(trailId: string): MineRecord {
  const hit = mine[trailId];
  if (hit) return hit;
  const made: MineRecord = { myRating: null, comments: [] };
  mine[trailId] = made;
  return made;
}

/** Reader photos, memory only. Keyed by trail id; the object URLs are revoked on destroy. */
const myPhotos = new Map<string, UgcPhoto[]>();
const objectUrls: string[] = [];

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Everything known about a trail's UGC: the seeded sample population, plus whatever the
 * reader added this session, kept separable by `origin`.
 *
 * `ratingAvg` and `ratingCount` describe the SEEDED population only. The reader's own
 * rating never moves them; it rides in `myRating` and the UI shows it as theirs.
 */
export function getUgc(trailId: string): TrailUgc {
  const seed = seededFor(trailId);
  const rec = mine[trailId];
  return {
    ratingAvg: seed.ratingAvg,
    ratingCount: seed.ratingCount,
    // Reader contributions first: they are the freshest thing on the sheet.
    photos: [...(myPhotos.get(trailId) ?? []), ...seed.photos],
    comments: [...(rec?.comments ?? []), ...seed.comments],
    myRating: rec?.myRating ?? null,
  };
}

/** The reader's own rating, 1..5. Passing the current value again clears it. */
export function setMyRating(trailId: string, stars: number | null): void {
  const rec = recordFor(trailId);
  rec.myRating = stars === null ? null : clamp(Math.round(stars), 1, 5);
  saveMine();
}

/** Append a reader comment. Returns it, so a caller can scroll to what it just added. */
export function addComment(trailId: string, text: string, stars: number | null): UgcComment | null {
  const body = text.trim();
  if (!body) return null;
  const rec = recordFor(trailId);
  const comment: UgcComment = {
    id: `${trailId}#mine-${Date.now()}`,
    authorName: 'You',
    when: 'just now',
    text: body.slice(0, 280),
    rating: stars === null ? (rec.myRating ?? 0) : clamp(Math.round(stars), 1, 5),
    origin: 'mine',
  };
  rec.comments = [comment, ...rec.comments];
  saveMine();
  return comment;
}

/**
 * A real file, a real object URL, a real image on screen. The flow is genuinely
 * demonstrated rather than mocked, which is the only version of it worth showing.
 */
export function addPhoto(trailId: string, file: File): UgcPhoto | null {
  if (!file || !file.type.startsWith('image/')) return null;
  const src = URL.createObjectURL(file);
  objectUrls.push(src);
  const photo: UgcPhoto = {
    id: `${trailId}#mine-${Date.now()}`,
    caption: file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40),
    authorName: 'You',
    when: 'just now',
    origin: 'mine',
    src,
  };
  myPhotos.set(trailId, [photo, ...(myPhotos.get(trailId) ?? [])]);
  return photo;
}

/** Release every object URL this module minted. Called from the phone's destroy(). */
export function revokeUgcObjectUrls(): void {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.length = 0;
  myPhotos.clear();
}

// ---- the comment composer's draft --------------------------------------------------
//
// The phone rebuilds its DOM on every render, so a textarea the reader is halfway through
// would lose its text the moment they tapped a star. The draft lives here instead.

const drafts = new Map<string, string>();

export function ugcDraft(trailId: string): string {
  return drafts.get(trailId) ?? '';
}

export function setUgcDraft(trailId: string, text: string): void {
  drafts.set(trailId, text);
}

export function clearUgcDraft(trailId: string): void {
  drafts.delete(trailId);
}

// ============================================================================
// SORTING
// ============================================================================

/** True when a trail carries any seeded rating. The card and the sort both branch on it. */
export function isRated(trailId: string): boolean {
  const seed = seededFor(trailId);
  return seed.ratingAvg !== null && seed.ratingCount > 0;
}

/**
 * The Top rated ordering: the sort open data alone could not support, and now the sort
 * that has to cope with almost nothing being rated.
 *
 * THE RULE, in full: rated trails first, highest rating first, more ratings breaking a
 * tie. Everything unrated keeps its order below them. That is all it does.
 *
 * An earlier version damped the mean with a Bayesian prior at 20 ratings. That was the
 * wrong instrument once the whole population is single digits: with counts of 1 to 12 the
 * prior does not adjudicate between a lucky average and an earned one, it simply pulls
 * every trail towards the prior and orders them by review count wearing a rating's
 * clothes. A reader cannot reconstruct that from the numbers on screen, and a ranking
 * nobody can reconstruct is the thing this page argues against. Sorting by the visible
 * number is legible: the order down the list is the order of the printed ratings.
 *
 * The trade is real and is not hidden: one 5.0 from a single rating leads eight 4.5s. The
 * UI states the count beside every rating and names the rule in the sort sheet, which is
 * the honest version of a small-sample sort. A product with real volume would revisit it.
 */
export function compareByRating(aId: string, bId: string): number {
  const a = seededFor(aId);
  const b = seededFor(bId);
  const aRated = a.ratingAvg !== null && a.ratingCount > 0;
  const bRated = b.ratingAvg !== null && b.ratingCount > 0;
  if (aRated !== bRated) return aRated ? -1 : 1;
  if (!aRated || !bRated) return 0;
  return (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0) || b.ratingCount - a.ratingCount;
}
