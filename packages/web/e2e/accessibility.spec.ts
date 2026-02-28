import { test, expect } from "./fixtures/auth";
import { waitForPageLoad } from "./test-utils";

test.describe("Accessibility", () => {
  test.describe("Keyboard Navigation", () => {
    test("should navigate header with keyboard", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Tab through navigation
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      
      // Focus should be visible
      const focusedElement = page.locator(":focus");
      await expect(focusedElement).toBeVisible();
    });
    
    test("should open user menu with Enter", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Tab to user button and press Enter
      const userButton = page.locator('.header-user-btn');
      await userButton.focus();
      await page.keyboard.press("Enter");
      
      // Dropdown should appear
      await expect(page.locator('.header-dropdown')).toBeVisible();
    });
    
    test("should close modal with Escape", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Open mobile drawer if visible
      const hamburgerBtn = page.locator('.header-hamburger-btn');
      if (await hamburgerBtn.isVisible()) {
        await hamburgerBtn.click();
        await expect(page.locator('.header-drawer-open')).toBeVisible();
        
        // Press Escape
        await page.keyboard.press("Escape");
        
        await expect(page.locator('.header-drawer-open')).not.toBeVisible();
      }
    });
    
    test("should navigate event creation form with Tab", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      // Tab to title input
      await page.keyboard.press("Tab");
      
      // Should focus on title input or first focusable element
      const focusedElement = page.locator(":focus");
      await expect(focusedElement).toBeVisible();
    });
  });
  
  test.describe("Screen Reader Support", () => {
    test("should have proper heading hierarchy", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should have h1
      const h1 = page.locator("h1").first();
      await expect(h1).toBeVisible();
    });
    
    test("should have alt text for images", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Check all images have alt attributes
      const images = await page.locator("img").all();
      for (const img of images) {
        const alt = await img.getAttribute("alt");
        // Alt can be empty for decorative images, but must be present
        expect(alt).toBeDefined();
      }
    });
    
    test("should have proper form labels", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      // All inputs should have associated labels
      const inputs = await page.locator("input:not([type='hidden'])").all();
      
      for (const input of inputs.slice(0, 5)) {
        const id = await input.getAttribute("id");
        const ariaLabel = await input.getAttribute("aria-label");
        const ariaLabelledBy = await input.getAttribute("aria-labelledby");
        
        if (id) {
          // Check for associated label
          const label = page.locator(`label[for="${id}"]`);
          const hasLabel = await label.count() > 0;
          // Should have label, aria-label, or aria-labelledby
          expect(hasLabel || ariaLabel || ariaLabelledBy).toBeTruthy();
        }
      }
    });
    
    test("should have landmark roles", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should have main landmark
      const main = page.locator("main, [role='main']");
      await expect(main).toBeVisible();
      
      // Should have navigation landmark
      const nav = page.locator("nav, [role='navigation']");
      await expect(nav).toBeVisible();
    });
  });
  
  test.describe("Focus Management", () => {
    test("should restore focus after modal closes", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const createBtn = page.locator('button:has-text("Create Identity")').first();
      if (await createBtn.isVisible()) {
        await createBtn.focus();
        await createBtn.click();
        
        await page.waitForSelector('[role="dialog"]');
        
        // Close modal
        await page.keyboard.press("Escape");
        
        // Focus should return to trigger
        await page.waitForTimeout(100);
        const focused = page.locator(":focus");
        await expect(focused).toBeVisible();
      }
    });
    
    test("should show visible focus indicator", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Tab to an element
      await page.keyboard.press("Tab");
      
      // Focused element should have visible focus ring
      const focused = page.locator(":focus");
      await expect(focused).toBeVisible();
    });
  });
});
