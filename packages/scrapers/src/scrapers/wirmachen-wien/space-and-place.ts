/**
 * Scraper for Space and Place (spaceandplace.at).
 *
 * Space and Place is a Vienna initiative for public space activation.
 * Their site is a React SPA backed by WordPress + WPGraphQL.
 * We query the GraphQL API directly for event pages.
 */

import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";

const GRAPHQL_URL = "https://spaceandplace.at/cms/graphql";
const IMAGE_BASE = "https://spaceandplace.at/cms/wp-content/uploads/";

const EVENTS_QUERY = `{
  pages(first: 100, where: { categoryName: "termine" }) {
    edges {
      node {
        id
        databaseId
        title
        slug
        uri
        eventStart
        eventEnd
        headerimage
        date
      }
    }
  }
}`;

interface GqlPage {
  id: string;
  databaseId: number;
  title: string;
  slug: string;
  uri: string;
  eventStart: string | null;
  eventEnd: string | null;
  headerimage: string | null;
  date: string;
}

export class SpaceAndPlaceScraper implements Scraper {
  readonly id = "space-and-place";
  readonly name = "Space and Place";
  readonly url = "https://spaceandplace.at/termine";
  readonly website = "https://spaceandplace.at/";
  readonly bio = "Die Stadtarbeiter*innen und Stadtforscher*innen schaffen Orte der Begegnung im öffentlichen Raum.";
  readonly avatarUrl = "https://wirmachen.wien/wp-content/uploads/2023/10/space-and-place-20200918-Tag_der_Wohnstrasse-c-Alissar-Najjar-6484.jpg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: EVENTS_QUERY }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Space and Place events: ${response.status}`);
    }

    const json = (await response.json()) as {
      data: { pages: { edges: { node: GqlPage }[] } };
    };

    const now = new Date();
    const events: Partial<EveryCalEvent>[] = [];

    for (const { node } of json.data.pages.edges) {
      if (!node.title || !node.eventStart) continue;

      // Skip past events
      const endDate = node.eventEnd ? new Date(node.eventEnd) : new Date(node.eventStart);
      if (endDate < now) continue;

      const image = node.headerimage
        ? { url: `${IMAGE_BASE}${node.headerimage}` }
        : undefined;

      events.push({
        id: `space-and-place-${node.databaseId}`,
        title: node.title.replace(/\s+/g, " ").trim(),
        startDate: new Date(node.eventStart).toISOString(),
        endDate: node.eventEnd ? new Date(node.eventEnd).toISOString() : undefined,
        url: `https://spaceandplace.at${node.uri}`,
        image,
        organizer: "Space and Place",
        tags: ["vienna", "public-space", "civic-initiative", "wirmachen-wien"],
        visibility: "public",
      });
    }

    return events;
  }
}
