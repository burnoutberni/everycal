import { type Page, expect } from "@playwright/test";
import { nanoid } from "nanoid";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

/**
 * Generate a unique test identifier
 */
export function uniqueId(): string {
  return nanoid(8);
}

/**
 * Generate a unique username for tests
 */
export function uniqueUsername(prefix = "user"): string {
  return `${prefix}_${uniqueId()}`;
}

/**
 * Generate a unique email for tests
 */
export function uniqueEmail(prefix = "test"): string {
  return `${prefix}_${uniqueId()}@test.example.com`;
}

/**
 * Wait for page to be fully loaded (network idle)
 */
export async function waitForPageLoad(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate to a path and wait for network idle
 */
export async function navigateAndWait(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForPageLoad(page);
}

/**
 * Fill a form field and verify the value
 */
export async function fillField(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, value);
  await expect(page.locator(selector)).toHaveValue(value);
}

/**
 * Click a button and wait for response/navigation
 */
export async function clickAndWait(
  page: Page,
  selector: string,
  options: { waitForNavigation?: boolean; waitForResponse?: string } = {}
): Promise<void> {
  if (options.waitForResponse) {
    const responsePromise = page.waitForResponse(options.waitForResponse);
    await page.click(selector);
    await responsePromise;
  } else if (options.waitForNavigation) {
    await Promise.all([page.waitForURL(/.*/), page.click(selector)]);
  } else {
    await page.click(selector);
  }
}

/**
 * Login via the UI
 */
export async function loginViaUI(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  await page.goto("/login");
  await waitForPageLoad(page);
  
  await page.fill('input[id="username"]', username);
  await page.fill('input[id="password"]', password);
  await page.click('button[type="submit"]');
  
  // Wait for redirect after login
  await page.waitForURL(/^(?!.*\/login)/, { timeout: 10000 });
}

/**
 * Register a new user via the UI
 */
export async function registerViaUI(
  page: Page,
  options: {
    username: string;
    password: string;
    displayName?: string;
    email: string;
    city?: string;
  }
): Promise<void> {
  await page.goto("/register");
  await waitForPageLoad(page);
  
  await page.fill('input[id="username"]', options.username);
  
  if (options.displayName) {
    await page.fill('input[id="displayName"]', options.displayName);
  }
  
  await page.fill('input[id="email"]', options.email);
  await page.fill('input[id="password"]', options.password);
  
  // City search - wait for dropdown and select first result
  if (options.city) {
    await page.fill('input[id="city"]', options.city);
    // Wait for dropdown to appear and click first option
    await page.waitForSelector('[role="listbox"], [data-testid="city-results"]', { timeout: 5000 });
    await page.click('[role="option"]:first-child, [data-testid="city-result"]:first-child');
  }
  
  await page.click('button[type="submit"]');
}

/**
 * Logout via the UI
 */
export async function logoutViaUI(page: Page): Promise<void> {
  // Click user menu dropdown
  await page.click('.header-user-btn');
  await page.waitForSelector('.header-dropdown');
  
  // Click logout button
  await page.click('.header-dropdown-item:has-text("Log out")');
  
  // Wait for redirect to home or login
  await page.waitForURL(/^(\/|\/login)/);
}

/**
 * Complete onboarding flow
 */
export async function completeOnboarding(page: Page): Promise<void> {
  await page.waitForURL(/\/onboarding/, { timeout: 5000 });
  await page.click('button[type="submit"]');
  await page.waitForURL("/", { timeout: 10000 });
}

/**
 * Create event via the UI
 */
export async function createEventViaUI(
  page: Page,
  options: {
    title: string;
    description?: string;
    startDate?: string;
    startTime?: string;
    endDate?: string;
    endTime?: string;
    allDay?: boolean;
    location?: string;
    tags?: string[];
    visibility?: string;
  }
): Promise<void> {
  await page.goto("/create");
  await waitForPageLoad(page);
  
  // Fill title
  await page.fill('input[id="title"]', options.title);
  
  // Fill description (TipTap editor)
  if (options.description) {
    await page.click('.ProseMirror');
    await page.fill('.ProseMirror', options.description);
  }
  
  // Set dates/times
  if (options.startDate) {
    await page.fill('input[type="date"]', options.startDate);
  }
  
  if (options.allDay) {
    await page.check('input[type="checkbox"][id="allDay"]');
  } else if (options.startTime) {
    await page.fill('input[type="time"]', options.startTime);
  }
  
  // Location
  if (options.location) {
    await page.fill('input[placeholder*="location" i]', options.location);
    await page.waitForSelector('[role="listbox"]', { timeout: 3000 });
    await page.click('[role="option"]:first-child');
  }
  
  // Tags
  if (options.tags && options.tags.length > 0) {
    for (const tag of options.tags) {
      await page.fill('input[placeholder*="tag" i]', tag);
      await page.press('input[placeholder*="tag" i]', "Enter");
    }
  }
  
  // Visibility
  if (options.visibility) {
    await page.selectOption('select[id="visibility"]', options.visibility);
  }
  
  // Submit
  await page.click('button[type="submit"]:has-text("Create")');
  await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
}

/**
 * Take a screenshot with a descriptive name
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `playwright-report/screenshots/${name}.png`, fullPage: true });
}

/**
 * Check if element is visible
 */
export async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get text content of an element
 */
export async function getText(page: Page, selector: string): Promise<string> {
  return (await page.textContent(selector)) || "";
}

/**
 * Wait for toast/notification message
 */
export async function waitForToast(page: Page, expectedText?: string): Promise<void> {
  const toastSelector = ".toast, .notification, [role='alert']";
  await page.waitForSelector(toastSelector, { state: "visible", timeout: 5000 });
  
  if (expectedText) {
    await expect(page.locator(toastSelector)).toContainText(expectedText);
  }
}

/**
 * Close modal dialog
 */
export async function closeModal(page: Page): Promise<void> {
  // Try Escape key first
  await page.keyboard.press("Escape");
  
  // If modal is still visible, look for close button
  try {
    const closeButton = page.locator('[aria-label="Close"], button:has-text("×")').first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
    }
  } catch {
    // Modal might already be closed
  }
}

/**
 * Set viewport to mobile size
 */
export async function setMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 667 });
}

/**
 * Set viewport to desktop size
 */
export async function setDesktopViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 });
}

/**
 * Open mobile menu
 */
export async function openMobileMenu(page: Page): Promise<void> {
  await page.click('.header-hamburger-btn');
  await page.waitForSelector('.header-drawer-open');
}

/**
 * Close mobile menu
 */
export async function closeMobileMenu(page: Page): Promise<void> {
  await page.click('.header-drawer-close');
  await page.waitForSelector('.header-drawer-open', { state: "hidden" });
}

/**
 * Check API response status
 */
export async function checkApiResponse(
  page: Page,
  urlPattern: string | RegExp,
  expectedStatus: number = 200
): Promise<void> {
  const response = await page.waitForResponse(urlPattern);
  expect(response.status()).toBe(expectedStatus);
}
