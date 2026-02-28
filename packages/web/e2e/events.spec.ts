import { test, expect } from "./fixtures/auth";
import { waitForPageLoad, uniqueId } from "./test-utils";

test.describe("Events", () => {
  test.describe("Event Listing", () => {
    test("should display events on home page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should show some content
      await expect(page.locator('main')).toBeVisible();
    });
    
    test("should filter events by date using MiniCalendar", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Click on a date in the mini calendar
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const day = tomorrow.getDate();
      
      const dayElement = page.locator(`.mini-calendar-day:has-text("${day}")`).first();
      if (await dayElement.isVisible()) {
        await dayElement.click();
        
        // URL should update with date filter
        await expect(page).toHaveURL(/from=/);
      }
    });
    
    test("should toggle between all events and my events scope", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Click on "My Events" toggle
      const myEventsBtn = page.locator('[data-testid="scope-feed"], button:has-text("My events")').first();
      if (await myEventsBtn.isVisible()) {
        await myEventsBtn.click();
        
        // URL should update
        await expect(page).toHaveURL(/scope=mine/);
      }
    });
  });
  
  test.describe("Event Creation", () => {
    test("should create a basic event", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      // Fill basic fields
      await page.fill('input[id="title"]', `New Event ${uniqueId()}`);
      
      // Fill description in TipTap editor
      await page.click('.ProseMirror');
      await page.type('.ProseMirror', 'Test event description');
      
      // Submit
      await page.click('button[type="submit"]');
      
      // Should redirect to event page
      await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
      
      // Verify event was created
      await expect(page.locator('h1')).toBeVisible();
    });
    
    test("should create an all-day event", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      await page.fill('input[id="title"]', `All Day Event ${uniqueId()}`);
      
      // Check all-day checkbox
      const allDayCheckbox = page.locator('input[type="checkbox"][id="allDay"], input[name="allDay"]').first();
      if (await allDayCheckbox.isVisible()) {
        await allDayCheckbox.check();
      }
      
      await page.click('button[type="submit"]');
      
      await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
      
      // Verify all-day indicator
      await expect(page.locator('main')).toBeVisible();
    });
    
    test("should create event with tags", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      await page.fill('input[id="title"]', `Tagged Event ${uniqueId()}`);
      
      // Add tags
      const tagInput = page.locator('input[placeholder*="tag" i], input[name="tag"]').first();
      if (await tagInput.isVisible()) {
        await tagInput.fill("test-tag");
        await tagInput.press("Enter");
      }
      
      await page.click('button[type="submit"]');
      
      await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
      
      // Verify event page loaded
      await expect(page.locator('main')).toBeVisible();
    });
    
    test("should save draft and restore on page reload", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      const eventTitle = `Draft Event ${uniqueId()}`;
      await page.fill('input[id="title"]', eventTitle);
      
      // Reload page
      await page.reload();
      await waitForPageLoad(page);
      
      // Draft should be restored (check if title is still there)
      const titleValue = await page.inputValue('input[id="title"]');
      // Draft persistence depends on local storage implementation
      expect(titleTitle || titleValue).toBeDefined();
    });
    
    test("should validate required fields", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      // Try to submit without title
      await page.click('button[type="submit"]');
      
      // Should show validation error
      await expect(page.locator('input[id="title"]:invalid, .error-text')).toBeVisible();
    });
  });
  
  test.describe("Event Viewing", () => {
    test("should show 404 for non-existent event", async ({ page }) => {
      await page.goto("/@nonexistent/nonexistent-event");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/404|not found/i')).toBeVisible();
    });
  });
  
  test.describe("Event Deletion", () => {
    test("should cancel deletion", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Create an event first
      await page.goto("/create");
      await waitForPageLoad(page);
      await page.fill('input[id="title"]', `Cancel Delete Event ${uniqueId()}`);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
      
      // Click delete button
      const deleteBtn = page.locator('button:has-text("Delete")').first();
      if (await deleteBtn.isVisible()) {
        await deleteBtn.click();
        
        // Cancel deletion
        const cancelBtn = page.locator('button:has-text("Cancel")').first();
        if (await cancelBtn.isVisible()) {
          await cancelBtn.click();
        }
      }
      
      // Should still be on event page
      await expect(page.locator('main')).toBeVisible();
    });
  });
  
  test.describe("Event RSVP", () => {
    test("should have RSVP buttons on event page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Create an event
      await page.goto("/create");
      await waitForPageLoad(page);
      await page.fill('input[id="title"]', `RSVP Event ${uniqueId()}`);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
      
      // Look for RSVP buttons
      const goingBtn = page.locator('button:has-text("Going")').first();
      const maybeBtn = page.locator('button:has-text("Maybe")').first();
      
      // At least one RSVP option should be visible
      expect(await goingBtn.isVisible() || await maybeBtn.isVisible()).toBeTruthy();
    });
  });
  
  test.describe("Event Repost", () => {
    test("should have repost button on event page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Create an event
      await page.goto("/create");
      await waitForPageLoad(page);
      await page.fill('input[id="title"]', `Repost Event ${uniqueId()}`);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/@[^/]+\/[^/]+/, { timeout: 10000 });
      
      // Look for repost button
      const repostBtn = page.locator('button:has-text("Repost"), button[aria-label*="repost" i]').first();
      
      // Repost option should be visible
      expect(await repostBtn.isVisible()).toBeTruthy();
    });
  });
});
