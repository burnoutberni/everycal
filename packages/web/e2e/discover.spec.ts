import { test, expect } from "./fixtures/auth";
import { waitForPageLoad } from "./test-utils";

test.describe("Discover", () => {
  test.describe("Discover Page", () => {
    test("should display discover page", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/discover");
      await waitForPageLoad(page);
      
      await expect(page.locator('h1, [data-testid="discover-title"]')).toBeVisible();
    });
    
    test("should show local users", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/discover");
      await waitForPageLoad(page);
      
      // Should show local users section
      await expect(page.locator('text=/local users|discover/i')).toBeVisible();
    });
    
    test("should search local users", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/discover");
      await waitForPageLoad(page);
      
      // Type in search box
      const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
      if (await searchInput.isVisible()) {
        await searchInput.fill("test");
        await page.waitForTimeout(500);
        
        // Should show results or no results message
        await expect(page.locator('main')).toBeVisible();
      }
    });
  });
  
  test.describe("Federation Search", () => {
    test("should show search form for remote actors", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/discover");
      await waitForPageLoad(page);
      
      // Look for federation search input
      const federationSearch = page.locator('input[placeholder*="@"], input[placeholder*="handle" i]').first();
      expect(await federationSearch.isVisible()).toBeTruthy();
    });
  });
  
  test.describe("Discover Navigation", () => {
    test("should navigate to discover from header", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      await page.click('a[href="/discover"], a:has-text("Discover")');
      
      await expect(page).toHaveURL(/\/discover/);
    });
    
    test("should redirect from /explore to /discover", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/explore");
      await waitForPageLoad(page);
      
      await expect(page).toHaveURL(/\/discover/);
    });
    
    test("should redirect from /federation to /discover", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/federation");
      await waitForPageLoad(page);
      
      await expect(page).toHaveURL(/\/discover/);
    });
  });
});
