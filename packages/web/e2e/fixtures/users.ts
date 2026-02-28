import { type APIRequestContext, expect } from "@playwright/test";
import { nanoid } from "nanoid";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

export interface TestUserData {
  id: string;
  username: string;
  password: string;
  displayName: string;
  email: string;
  city: string;
  cityLat: number;
  cityLng: number;
}

export class UserHelper {
  private createdUsers: TestUserData[] = [];
  
  async create(options: Partial<TestUserData> = {}): Promise<TestUserData> {
    const id = nanoid(8);
    const username = options.username || `user_${id}`;
    const password = options.password || `Password${id}!`;
    const displayName = options.displayName || `User ${id}`;
    const email = options.email || `${username}@test.example.com`;
    const city = options.city || "Vienna";
    const cityLat = options.cityLat ?? 48.2082;
    const cityLng = options.cityLng ?? 16.3738;
    
    const res = await fetch(`${BASE_URL}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        displayName,
        email,
        city,
        cityLat,
        cityLng,
      }),
    });
    
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create user: ${res.status} ${body}`);
    }
    
    const userData: TestUserData = {
      id,
      username,
      password,
      displayName,
      email,
      city,
      cityLat,
      cityLng,
    };
    
    this.createdUsers.push(userData);
    return userData;
  }
  
  async login(request: APIRequestContext, username: string, password: string): Promise<void> {
    const res = await request.post(`${BASE_URL}/api/v1/auth/login`, {
      data: { username, password },
    });
    expect(res.ok()).toBeTruthy();
  }
  
  async get(request: APIRequestContext, username: string): Promise<any> {
    const res = await request.get(`${BASE_URL}/api/v1/users/${username}`);
    expect(res.ok()).toBeTruthy();
    return res.json();
  }
  
  async follow(request: APIRequestContext, username: string): Promise<void> {
    const res = await request.post(`${BASE_URL}/api/v1/users/${username}/follow`);
    expect(res.ok()).toBeTruthy();
  }
  
  async unfollow(request: APIRequestContext, username: string): Promise<void> {
    const res = await request.post(`${BASE_URL}/api/v1/users/${username}/unfollow`);
    expect(res.ok()).toBeTruthy();
  }
  
  getCreatedUsers(): TestUserData[] {
    return [...this.createdUsers];
  }
}

export const userHelper = new UserHelper();
