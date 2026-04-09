import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import { nanoid } from "nanoid";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

export interface TestUser {
  id: string;
  username: string;
  password: string;
  displayName: string;
  email: string;
  city: string;
  cityLat: number;
  cityLng: number;
}

export interface TestFixtures {
  testUser: TestUser;
  authenticatedPage: Page;
  apiRequest: (method: string, path: string, data?: unknown) => Promise<Response>;
}

/**
 * Create a test user via direct API call
 */
async function createTestUserViaApi(options: Partial<TestUser> = {}): Promise<TestUser> {
  const id = nanoid(8);
  const username = options.username || `test_${id}`;
  const password = options.password || `Password${id}!`;
  const displayName = options.displayName || `Test ${id}`;
  const email = options.email || `${username}@test.example.com`;
  const city = options.city || "Vienna";
  const cityLat = options.cityLat ?? 48.2082;
  const cityLng = options.cityLng ?? 16.3738;
  
  // Register the user
  const registerRes = await fetch(`${BASE_URL}/api/v1/auth/register`, {
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
  
  if (!registerRes.ok) {
    const body = await registerRes.text();
    throw new Error(`Failed to register test user: ${registerRes.status} ${body}`);
  }
  
  const registerData = await registerRes.json();
  
  // For human users, we need to verify the email
  // Try the test verification endpoint if available
  if (registerData.requiresVerification) {
    // Try to verify via test endpoint or get the token from a test database
    // For now, we'll login directly which should work after the user is created
  }
  
  return {
    id,
    username,
    password,
    displayName,
    email,
    city,
    cityLat,
    cityLng,
  };
}

/**
 * Login and get session cookie
 */
async function loginUser(context: BrowserContext, user: TestUser): Promise<void> {
  const res = await context.request.post(`${BASE_URL}/api/v1/auth/login`, {
    data: { username: user.username, password: user.password },
  });
  
  if (!res.ok()) {
    throw new Error(`Failed to login: ${res.status()}`);
  }
  
  // Session cookie should be set automatically
}

/**
 * Complete onboarding for a user
 */
async function completeOnboarding(page: Page): Promise<void> {
  await page.click('button[type="submit"]:has-text("Continue"), .onboarding-continue-btn');
  await page.waitForURL("/", { timeout: 10000 });
}

export const test = base.extend<TestFixtures>({
  testUser: async ({}, use) => {
    const user = await createTestUserViaApi();
    await use(user);
  },
  
  authenticatedPage: async ({ browser, testUser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Login the user
    await loginUser(context, testUser);
    
    // Navigate to the app
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    
    // Handle onboarding if shown
    try {
      await page.waitForURL(/\/onboarding/, { timeout: 3000 });
      await completeOnboarding(page);
    } catch {
      // Not on onboarding, that's fine
    }
    
    await use(page);
    
    await context.close();
  },
  
  apiRequest: async ({ request }, use) => {
    const apiCall = async (method: string, path: string, data?: unknown): Promise<Response> => {
      const url = `${BASE_URL}/api/v1${path}`;
      const options: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };
      if (data) {
        options.body = JSON.stringify(data);
      }
      return fetch(url, options);
    };
    await use(apiCall);
  },
});

export { expect };
