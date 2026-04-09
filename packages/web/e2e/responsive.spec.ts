import { test, expect } from "./fixtures/auth";
import { waitForPageLoad } from "./test-utils";

test.describe("Responsive Design", () => {
  test.describe("Mobile Layout", () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
    });
    
    test("should show mobile header", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should have hamburger menu
      await expect(page.locator('.header-hamburger-btn')).toBeVisible();
    });
    
    test("should open mobile drawer", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await page.click('.header-hamburger-btn');
      
      // Drawer should be visible
      await expect(page.locator('.header-drawer-open')).toBeVisible();
    });
    
    test("should close mobile drawer with X button", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await page.click('.header-hamburger-btn');
      await expect(page.locator('.header-drawer-open')).toBeVisible();
      
      await page.click('.header-drawer-close');
      
      await expect(page.locator('.header-drawer-open')).not.toBeVisible();
    });
    
    test("should close mobile drawer with Escape", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await page.click('.header-hamburger-btn');
      await expect(page.locator('.header-drawer-open')).toBeVisible();
      
      await page.keyboard.press("Escape");
      
      await expect(page.locator('.header-drawer-open')).not.toBeVisible();
    });
    
    test("should close mobile drawer when clicking overlay", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await page.click('.header-hamburger-btn');
      await expect(page.locator('.header-drawer-open')).toBeVisible();
      
      // Click overlay
      await page.click('.header-drawer-overlay');
      
      await expect(page.locator('.header-drawer-open')).not.toBeVisible();
    });
    
    test("should navigate from mobile drawer", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await page.click('.header-hamburger-btn');
      await page.click('.header-drawer-item:has-text("Discover")');
      
      await expect(page).toHaveURL(/\/discover/);
      await expect(page.locator('.header-drawer-open')).not.toBeVisible();
    });
  });
  
  test.describe("Tablet Layout", () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
    });
    
    test("should show tablet-optimized layout", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should show navigation elements
      await expect(page.locator('nav')).toBeVisible();
    });
  });
  
  test.describe("Desktop Layout", () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
    });
    
    test("should show desktop navigation", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Desktop nav should be visible
      await expect(page.locator('.header-nav-desktop')).toBeVisible();
      
      // Mobile hamburger should be hidden
      await expect(page.locator('.header-hamburger-btn')).not.toBeVisible();
    });
    
    test("should show user dropdown on desktop", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Click user button
      await page.click('.header-user-btn');
      
      // Dropdown should appear
      await expect(page.locator('.header-dropdown')).toBeVisible();
    });
    
    test("should show desktop calendar view", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/calendar");
      await waitForPageLoad(page);
      
      // FullCalendar should be visible
      await expect(page.locator('.fc')).toBeVisible();
    });
  });
  
  test.describe("Responsive Components", () => {
    test("should adapt event cards to screen size", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Desktop
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/");
      await waitForPageLoad(page);
      
      const desktopCard = page.locator('.event-card').first();
      let desktopWidth = 0;
      if (await desktopCard.isVisible()) {
        desktopWidth = (await desktopCard.boundingBox())?.width || 0;
      }
      
      // Mobile
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(500);
      
      const mobileCard = page.locator('.event-card').first();
      let mobileWidth = 0;
      if (await mobileCard.isVisible()) {
        mobileWidth = (await mobileCard.boundingBox())?.width || 0;
      }
      
      // Mobile card should be narrower (if both are visible)
      if (desktopWidth > 0 && mobileWidth > 0) {
        expect(mobileWidth).toBeLessThan(desktopWidth);
      }
    });
  });
});
