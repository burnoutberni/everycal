/**
 * Infer a generic image search term from an event title.
 * Used to avoid sending personal/private title text to external image APIs.
 *
 * Maps common event types (personal, work, community, etc.) to neutral search terms.
 */

/** Keyword phrases/words → generic search term + optional tag. Order: more specific first. */
const TITLE_TO_SEARCH: { keywords: string[]; searchTerm: string; tag?: string }[] = [
  // Personal / celebrations
  { keywords: ["baby shower"], searchTerm: "baby shower" },
  { keywords: ["birthday", "bday"], searchTerm: "birthday" },
  { keywords: ["anniversary"], searchTerm: "anniversary" },
  { keywords: ["wedding"], searchTerm: "wedding" },
  { keywords: ["graduation"], searchTerm: "graduation" },
  { keywords: ["dinner party", "dinner"], searchTerm: "dinner" },
  { keywords: ["brunch"], searchTerm: "brunch" },
  { keywords: ["barbecue", "bbq", "grill"], searchTerm: "barbecue" },
  { keywords: ["picnic"], searchTerm: "picnic" },
  { keywords: ["party", "get-together", "get together"], searchTerm: "party" },
  { keywords: ["reunion", "gathering"], searchTerm: "gathering", tag: "gathering" },
  { keywords: ["vacation", "trip", "holiday"], searchTerm: "vacation" },
  { keywords: ["camping"], searchTerm: "camping" },

  // Work
  { keywords: ["team building", "team event"], searchTerm: "team building" },
  { keywords: ["conference", "summit"], searchTerm: "conference" },
  { keywords: ["workshop"], searchTerm: "workshop" },
  { keywords: ["presentation", "talk"], searchTerm: "presentation" },
  { keywords: ["interview"], searchTerm: "interview" },
  { keywords: ["networking"], searchTerm: "networking" },
  { keywords: ["meeting", "office", "work"], searchTerm: "business meeting", tag: "work" },
  { keywords: ["webinar", "online event"], searchTerm: "webinar" },

  // Community / culture
  { keywords: ["concert", "gig", "live music"], searchTerm: "concert" },
  { keywords: ["festival"], searchTerm: "festival" },
  { keywords: ["theater", "theatre", "play"], searchTerm: "theater" },
  { keywords: ["exhibition", "museum"], searchTerm: "art exhibition" },
  { keywords: ["movie", "film", "cinema"], searchTerm: "cinema" },
  { keywords: ["comedy", "stand-up"], searchTerm: "comedy show" },
  { keywords: ["opera"], searchTerm: "opera" },
  { keywords: ["ballet"], searchTerm: "ballet" },
  { keywords: ["art", "gallery"], searchTerm: "art gallery" },

  // Sports / fitness
  { keywords: ["marathon", "run", "5k", "10k"], searchTerm: "marathon" },
  { keywords: ["yoga"], searchTerm: "yoga" },
  { keywords: ["workout", "gym", "fitness"], searchTerm: "fitness" },
  { keywords: ["cycling", "bike"], searchTerm: "cycling" },
  { keywords: ["soccer", "football"], searchTerm: "soccer" },
  { keywords: ["tennis"], searchTerm: "tennis" },
  { keywords: ["swimming"], searchTerm: "swimming" },
  { keywords: ["sports", "game"], searchTerm: "sports" },

  // Learning / hobbies
  { keywords: ["cooking class", "cooking"], searchTerm: "cooking" },
  { keywords: ["book club"], searchTerm: "book club" },
  { keywords: ["language"], searchTerm: "language learning" },
  { keywords: ["class", "course"], searchTerm: "workshop" },

  // Political / activism
  { keywords: ["demonstration", "demo", "demonstrations"], searchTerm: "demonstration" },
  { keywords: ["protest", "protests"], searchTerm: "protest" },
  { keywords: ["march", "marches"], searchTerm: "march" },
  { keywords: ["rally", "rallies"], searchTerm: "rally" },
  { keywords: ["sit-in", "sit in"], searchTerm: "disobedience" },
  { keywords: ["vigil", "vigils"], searchTerm: "vigil" },
  { keywords: ["strike", "strikes"], searchTerm: "strike" },
  { keywords: ["town hall", "townhall"], searchTerm: "townhall" },
  { keywords: ["debate", "debates"], searchTerm: "debate" },
  { keywords: ["campaign", "campaign event"], searchTerm: "campaign" },
  { keywords: ["voting", "polling", "election day"], searchTerm: "voting" },
  { keywords: ["activism", "activist"], searchTerm: "activism" },
  { keywords: ["human rights"], searchTerm: "rights" },
  { keywords: ["charity", "volunteer"], searchTerm: "charity" },
];

const FALLBACK_SEARCH = "gathering";

/**
 * Infer a generic image search term from an event title.
 * Never returns the original title — only predefined neutral terms.
 */
export function inferImageSearchTerm(title: string): string {
  const t = title.trim().toLowerCase();
  if (!t) return FALLBACK_SEARCH;

  for (const { keywords, searchTerm } of TITLE_TO_SEARCH) {
    if (keywords.some((kw) => t.includes(kw))) {
      return searchTerm;
    }
  }

  return FALLBACK_SEARCH;
}

/** Normalize a tag to a single word (spaces → dashes). */
export function toSingleWordTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Infer suggested tags from an event title using the same heuristics as image search.
 * Returns an array of tag strings (empty if no match). All tags are single words (spaces → dashes).
 */
export function inferTagsFromTitle(title: string): string[] {
  const t = title.trim().toLowerCase();
  if (!t) return [];

  for (const { keywords, searchTerm, tag } of TITLE_TO_SEARCH) {
    if (keywords.some((kw) => t.includes(kw))) {
      return [toSingleWordTag(tag ?? searchTerm)];
    }
  }

  return [];
}
