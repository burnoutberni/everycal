import { type APIRequestContext, expect } from "@playwright/test";
import { nanoid } from "nanoid";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

export interface TestEventData {
  id: string;
  title: string;
  slug?: string;
  description?: string;
  startDate: string;
  endDate?: string;
  allDay?: boolean;
  location?: {
    name: string;
    address?: string;
    latitude?: number;
    longitude?: number;
  };
  image?: {
    url: string;
    alt?: string;
    attribution?: {
      source: string;
      creator?: string;
      sourceUrl?: string;
    };
  };
  tags?: string[];
  visibility?: "public" | "unlisted" | "followers_only" | "private";
}

export interface TestEvent extends TestEventData {
  slug: string;
  accountId: string;
  username: string;
}

export class EventHelper {
  private createdEvents: TestEvent[] = [];
  
  async create(
    request: APIRequestContext,
    options: Partial<TestEventData> = {}
  ): Promise<TestEvent> {
    const id = nanoid(8);
    const startDate = options.startDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const eventData = {
      title: options.title || `Test Event ${id}`,
      description: options.description || `Test event description for ${id}`,
      startDate,
      endDate: options.endDate,
      allDay: options.allDay ?? false,
      location: options.location,
      image: options.image,
      tags: options.tags || ["test"],
      visibility: options.visibility || "public",
    };
    
    const res = await request.post(`${BASE_URL}/api/v1/events`, {
      data: eventData,
    });
    
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create event: ${res.status} ${body}`);
    }
    
    const event = await res.json();
    const testEvent: TestEvent = {
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description,
      startDate: event.startDate,
      endDate: event.endDate,
      allDay: event.allDay,
      location: event.location,
      image: event.image,
      tags: event.tags,
      visibility: event.visibility,
      accountId: event.accountId,
      username: event.account?.username || "",
    };
    
    this.createdEvents.push(testEvent);
    return testEvent;
  }
  
  async get(request: APIRequestContext, id: string): Promise<any> {
    const res = await request.get(`${BASE_URL}/api/v1/events/${id}`);
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  
  async getBySlug(request: APIRequestContext, username: string, slug: string): Promise<any> {
    const res = await request.get(`${BASE_URL}/api/v1/events/by-slug/${username}/${slug}`);
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  
  async update(
    request: APIRequestContext,
    id: string,
    updates: Partial<TestEventData>
  ): Promise<any> {
    const res = await request.put(`${BASE_URL}/api/v1/events/${id}`, {
      data: updates,
    });
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  
  async delete(request: APIRequestContext, id: string): Promise<void> {
    const res = await request.delete(`${BASE_URL}/api/v1/events/${id}`);
    expect(res.ok()).toBeTruthy();
  }
  
  async rsvp(request: APIRequestContext, eventUri: string, status: "going" | "maybe"): Promise<void> {
    const res = await request.post(`${BASE_URL}/api/v1/events/rsvp`, {
      data: { eventUri, status },
    });
    expect(res.ok()).toBeTruthy();
  }
  
  async repost(request: APIRequestContext, eventId: string): Promise<void> {
    const res = await request.post(`${BASE_URL}/api/v1/events/${eventId}/repost`);
    expect(res.ok()).toBeTruthy();
  }
  
  async unrepost(request: APIRequestContext, eventId: string): Promise<void> {
    const res = await request.delete(`${BASE_URL}/api/v1/events/${eventId}/repost`);
    expect(res.ok()).toBeTruthy();
  }
  
  async list(request: APIRequestContext, params: Record<string, string | number> = {}): Promise<any[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      qs.set(k, String(v));
    }
    const res = await request.get(`${BASE_URL}/api/v1/events?${qs}`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    return data.events;
  }
  
  getCreatedEvents(): TestEvent[] {
    return [...this.createdEvents];
  }
}

export const eventHelper = new EventHelper();
