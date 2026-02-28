import { test, expect } from "./fixtures/auth";
import { waitForPageLoad } from "./test-utils";

test.describe("Error Handling", () => {
  test.describe("404 Pages", () => {
    test("should show 404 for non-existent route", async ({ page }) => {
      await page.goto("/nonexistent-route-12345");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/404|not found/i')).toBeVisible();
    });
    
    test("should show 404 for non-existent user profile", async ({ page }) => {
      await page.goto("/@nonexistentuser123456789");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/404|not found|doesn\'t exist/i')).toBeVisible();
    });
    
    test("should show 404 for non-existent event", async ({ page }) => {
      await page.goto("/@someuser/nonexistent-event-12345");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/404|not found/i')).toBeVisible();
    });
    
    test("should have link to home from 404", async ({ page }) => {
      await page.goto("/nonexistent-route");
      await waitForPageLoad(page);
      
      // Look for link to home
      const homeLink = page.locator('a[href="/"], a:has-text("Home"), a:has-text("Go back")').first();
      await expect(homeLink).toBeVisible();
    });
  });
  
  test.describe("Network Errors", () => {
    test("should handle offline gracefully", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Go offline
      await page.context().setOffline(true);
      
      // Try to navigate
      await page.click('a[href="/discover"]');
      
      // Should show error or offline message
      await page.waitForTimeout(2000);
      
      // Page should still render something
      await expect(page.locator("main")).toBeVisible();
      
      // Restore online
      await page.context().setOffline(false);
    });
    
    test("should show error toast on API failure", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      // Simulate API failure by blocking requests
      await page.route("**/api/**", (route) => {
        route.fulfill({ status: 500, body: JSON.stringify({ error: "Server error" }) });
      });
      
      // Try to save something
      const displayNameInput = page.locator('input[id="displayName"]').first();
      if (await displayNameInput.isVisible()) {
        await displayNameInput.fill("New Name");
        
        const saveBtn = page.locator('button:has-text("Save"):near(input[id="displayName"])').first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
          
          // Should show error message
          await expect(page.locator('text=/error|failed/i')).toBeVisible();
        }
      }
      
      // Cleanup
      await page.unroute("**/api/**");
    });
  });
  
  test.describe("Form Validation Errors", () => {
    test("should show validation errors on login", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      // Submit empty form
      await page.click('button[type="submit"]');
      
      // Should show validation
      await expect(page.locator('input:invalid, .error-text')).toBeVisible();
    });
    
    test("should show validation errors on register", async ({ page }) => {
      await page.goto("/register");
      await waitForPageLoad(page);
      
      // Submit with short password
      await page.fill('input[id="username"]', "testuser");
      await page.fill('input[id="email"]', "test@example.com");
      await page.fill('input[id="password"]', "short");
      await page.click('button[type="submit"]');
      
      // Should show password length error
      await expect(page.locator('text=/8 character/i, input[id="password"]:invalid')).toBeVisible();
    });
    
    test("should show validation errors on event creation", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      // Submit without title
      await page.click('button[type="submit"]');
      
      // Should show validation error
      await expect(page.locator('input[id="title"]:invalid, .error-text')).toBeVisible();
    });
    
    test("should validate email format", async ({ page }) => {
      await page.goto("/register");
      await waitForPageLoad(page);
      
      await page.fill('input[id="email"]', "not-an-email");
      await page.click('button[type="submit"]');
      
      // Should show email validation error
      await expect(page.locator('input[id="email"]:invalid')).toBeVisible();
    });
  });
  
  test.describe("Authentication Errors", () => {
    test("should show error for wrong password", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      await page.fill('input[id="username"]', "testuser");
      await page.fill('input[id="password"]', "wrongpassword");
      await page.click('button[type="submit"]');
      
      // Should show error
      await expect(page.locator('.error-text, [role="alert"]')).toBeVisible();
    });
    
    test("should show error for non-existent user", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      await page.fill('input[id="username"]', "nonexistentuser12345");
      await page.fill('input[id="password"]', "anypassword");
      await page.click('button[type="submit"]');
      
      await expect(page.locator('.error-text, [role="alert"]')).toBeVisible();
    });
    
    test("should handle session expiry", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Clear session cookie to simulate expiry
      await page.context().clearCookies();
      
      // Try to access protected resource
      await page.goto("/settings");
      
      // Should redirect to login
      await expect(page).toHaveURL(/\/login/);
    });
  });
  
  test.describe("Error Recovery", () => {
    test("should preserve form data after error", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const testValue = "Test Display Name";
      
      // Block API
      await page.route("**/api/**", (route) => {
        route.fulfill({ status: 500, body: JSON.stringify({ error: "Error" }) });
      });
      
      const displayNameInput = page.locator('input[id="displayName"]').first();
      if (await displayNameInput.isVisible()) {
        await displayNameInput.fill(testValue);
        
        const saveBtn = page.locator('button:has-text("Save"):near(input[id="displayName"])').first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
          
          // Form should still have the value
          await expect(displayNameInput).toHaveValue(testValue);
        }
      }
      
      await page.unroute("**/api/**");
    });
  });
  
  test.describe("Loading States", () => {
    test("should show loading state during login", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      // Slow down the request
      await page.route("**/api/v1/auth/login", async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        route.continue();
      });
      
      await page.fill('input[id="username"]', "testuser");
      await page.fill('input[id="password"]', "password");
      await page.click('button[type="submit"]');
      
      // Button should show loading state
      const submitBtn = page.locator('button[type="submit"]');
      await expect(submitBtn).toBeDisabled();
      
      await page.unroute("**/api/v1/auth/login");
    });
    
    test("should disable button during operation", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      await page.route("**/api/v1/auth/login", async (route) => {
        await new Promise((r) => setTimeout(r, 1000));
        route.fulfill({ status: 401 });
      });
      
      await page.fill('input[id="username"]', "test");
      await page.fill('input[id="password"]', "test");
      await page.click('button[type="submit"]');
      
      // Button should be disabled during request
      await expect(page.locator('button[type="submit"]')).toBeDisabled();
      
      await page.unroute("**/api/v1/auth/login");
    });
  });
});
