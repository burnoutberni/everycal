import { test, expect } from "./fixtures/auth";
import { waitForPageLoad } from "./test-utils";

test.describe("Calendar", () => {
  test.describe("Calendar View", () => {
    test("should display calendar page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // Calendar should be visible
      await expect(page.locator('.fc, [data-testid="calendar"]')).toBeVisible();
    });
    
    test("should show month view by default", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // Month view should be active
      await expect(page.locator('.fc-dayGridMonth-view, .fc-view-month')).toBeVisible();
    });
    
    test("should switch to week view", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // Click week button
      const weekBtn = page.locator('button:has-text("Week"), .fc-timeGridWeek-button').first();
      if (await weekBtn.isVisible()) {
        await weekBtn.click();
        
        await expect(page.locator('.fc-timeGridWeek-view, .fc-view-week')).toBeVisible();
      }
    });
    
    test("should switch to day view", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      const dayBtn = page.locator('button:has-text("Day"), .fc-timeGridDay-button').first();
      if (await dayBtn.isVisible()) {
        await dayBtn.click();
        
        await expect(page.locator('.fc-timeGridDay-view, .fc-view-day')).toBeVisible();
      }
    });
    
    test("should navigate to previous month", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // Get current month title
      const titleElement = page.locator('.fc-toolbar-title').first();
      const currentTitle = await titleElement.textContent();
      
      // Click previous
      await page.click('.fc-prev-button, button[aria-label="prev"]');
      
      // Title should change
      const newTitle = await titleElement.textContent();
      expect(newTitle).not.toBe(currentTitle);
    });
    
    test("should navigate to next month", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      const titleElement = page.locator('.fc-toolbar-title').first();
      const currentTitle = await titleElement.textContent();
      
      await page.click('.fc-next-button, button[aria-label="next"]');
      
      const newTitle = await titleElement.textContent();
      expect(newTitle).not.toBe(currentTitle);
    });
    
    test("should navigate to today", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // Navigate away first
      await page.click('.fc-next-button');
      
      // Click today button
      const todayBtn = page.locator('button:has-text("Today"), .fc-today-button').first();
      if (await todayBtn.isVisible()) {
        await todayBtn.click();
        
        // Should show current month
        const today = new Date();
        const currentMonth = today.toLocaleDateString("en-US", { month: "long", year: "numeric" });
        await expect(page.locator(`text="${currentMonth}"`)).toBeVisible();
      }
    });
  });
  
  test.describe("MiniCalendar on Home", () => {
    test("should display mini calendar on home page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await expect(page.locator('.mini-calendar, [data-testid="mini-calendar"]')).toBeVisible();
    });
    
    test("should highlight current day", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      const today = new Date().getDate();
      await expect(page.locator(`.mini-calendar-day.current, .mini-calendar-day[data-date*="${today}"]`)).toBeVisible();
    });
    
    test("should navigate months in mini calendar", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Click next month
      const nextBtn = page.locator('.mini-calendar-nav-next, [aria-label="Next month"]').first();
      if (await nextBtn.isVisible()) {
        await nextBtn.click();
        
        // Calendar should show next month
        const currentMonth = new Date();
        currentMonth.setMonth(currentMonth.getMonth() + 1);
        const nextMonth = currentMonth.toLocaleDateString("en-US", { month: "long" });
        
        await expect(page.locator(`text="${nextMonth}"`)).toBeVisible();
      }
    });
  });
  
  test.describe("Mobile Calendar", () => {
    test("should show mobile calendar on small screens", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // Mobile calendar should be visible
      await expect(page.locator('.mobile-calendar, [data-testid="mobile-calendar"], .fc')).toBeVisible();
    });
  });
});
