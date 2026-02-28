import { test, expect } from "./fixtures/auth";
import { uniqueUsername, uniqueEmail, waitForPageLoad, completeOnboarding } from "./test-utils";

test.describe("Authentication", () => {
  test.describe("Registration", () => {
    test("should register a new user successfully", async ({ page }) => {
      const username = uniqueUsername();
      const email = uniqueEmail();
      const password = "TestPassword123!";
      
      await page.goto("/register");
      await waitForPageLoad(page);
      
      // Fill registration form
      await page.fill('input[id="username"]', username);
      await page.fill('input[id="displayName"]', "Test User");
      await page.fill('input[id="email"]', email);
      await page.fill('input[id="password"]', password);
      
      // Fill city search
      await page.fill('input[id="city"]', "Vienna");
      await page.waitForSelector('[role="listbox"], [data-testid="city-results"]', { timeout: 5000 });
      await page.click('[role="option"]:first-child');
      
      // Submit form
      await page.click('button[type="submit"]');
      
      // Should redirect to check-email or home
      await page.waitForURL(/\/(check-email|\?)/, { timeout: 10000 });
      
      // Verify we're on the right page
      expect(page.url()).toMatch(/\/(check-email|\/)/);
    });
    
    test("should show validation errors for invalid input", async ({ page }) => {
      await page.goto("/register");
      await waitForPageLoad(page);
      
      // Try to submit empty form
      await page.click('button[type="submit"]');
      
      // Should show validation errors
      await expect(page.locator('input:invalid, .error-text')).toBeVisible();
    });
    
    test("should reject username with invalid characters", async ({ page }) => {
      await page.goto("/register");
      await waitForPageLoad(page);
      
      // Fill with invalid username (uppercase letters)
      await page.fill('input[id="username"]', "InvalidUsername");
      await page.fill('input[id="email"]', uniqueEmail());
      await page.fill('input[id="password"]', "TestPassword123!");
      
      // Try to submit
      await page.click('button[type="submit"]');
      
      // Form should not submit due to pattern validation
      await expect(page).toHaveURL(/\/register/);
    });
    
    test("should reject password shorter than 8 characters", async ({ page }) => {
      await page.goto("/register");
      await waitForPageLoad(page);
      
      await page.fill('input[id="username"]', uniqueUsername());
      await page.fill('input[id="email"]', uniqueEmail());
      await page.fill('input[id="password"]', "short");
      
      await page.click('button[type="submit"]');
      
      // Should stay on register page
      await expect(page).toHaveURL(/\/register/);
    });
    
    test("should navigate to login page from register", async ({ page }) => {
      await page.goto("/register");
      await waitForPageLoad(page);
      
      await page.click('a[href="/login"]');
      
      await expect(page).toHaveURL(/\/login/);
    });
  });
  
  test.describe("Login", () => {
    test("should login successfully with valid credentials", async ({ authenticatedPage }) => {
      // Should be logged in and on home page
      await expect(authenticatedPage).toHaveURL(/\//);
      await expect(authenticatedPage.locator('.header-user-btn')).toBeVisible();
    });
    
    test("should show error for invalid credentials", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      await page.fill('input[id="username"]', "nonexistent");
      await page.fill('input[id="password"]', "wrongpassword");
      await page.click('button[type="submit"]');
      
      // Should show error message
      await expect(page.locator('.error-text')).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    });
    
    test("should navigate to forgot password from login", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      await page.click('a[href="/forgot-password"]');
      
      await expect(page).toHaveURL(/\/forgot-password/);
    });
    
    test("should navigate to register from login", async ({ page }) => {
      await page.goto("/login");
      await waitForPageLoad(page);
      
      await page.click('a[href="/register"]');
      
      await expect(page).toHaveURL(/\/register/);
    });
  });
  
  test.describe("Logout", () => {
    test("should logout successfully", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Open user menu
      await page.click('.header-user-btn');
      await page.waitForSelector('.header-dropdown');
      
      // Click logout
      await page.click('.header-dropdown-item:has-text("Log out")');
      
      // Should redirect and show login/signup buttons
      await expect(page.locator('a[href="/login"]')).toBeVisible();
    });
  });
  
  test.describe("Password Reset", () => {
    test("should show forgot password form", async ({ page }) => {
      await page.goto("/forgot-password");
      await waitForPageLoad(page);
      
      await expect(page.locator('h1')).toContainText(/reset|forgot/i);
      await expect(page.locator('input[type="email"]')).toBeVisible();
    });
    
    test("should submit forgot password form", async ({ page }) => {
      await page.goto("/forgot-password");
      await waitForPageLoad(page);
      
      await page.fill('input[type="email"]', uniqueEmail());
      await page.click('button[type="submit"]');
      
      // Should show success message or redirect
      await expect(page.locator('text=/check your email|sent|success/i')).toBeVisible();
    });
    
    test("should show reset password form with valid token", async ({ page }) => {
      // Note: In real tests, we'd need a valid token from the email
      await page.goto("/reset-password?token=test-token");
      await waitForPageLoad(page);
      
      await expect(page.locator('input[type="password"]')).toBeVisible();
    });
  });
  
  test.describe("Protected Routes", () => {
    test("should redirect unauthenticated users to login from settings", async ({ page }) => {
      await page.goto("/settings");
      
      // Should redirect to login
      await expect(page).toHaveURL(/\/login/);
    });
    
    test("should redirect unauthenticated users to login from create event", async ({ page }) => {
      await page.goto("/create");
      
      // Should redirect to login
      await expect(page).toHaveURL(/\/login/);
    });
    
    test("should allow authenticated users to access settings", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      await expect(page).toHaveURL(/\/settings/);
    });
    
    test("should allow authenticated users to access create event", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/create");
      await waitForPageLoad(page);
      
      await expect(page).toHaveURL(/\/create/);
    });
  });
  
  test.describe("Email Verification", () => {
    test("should show check email page after registration", async ({ page }) => {
      await page.goto("/check-email?email=test@example.com");
      await waitForPageLoad(page);
      
      await expect(page.locator('text=/check your email|verify/i')).toBeVisible();
    });
    
    test("should handle verify email page", async ({ page }) => {
      // Note: In real tests, we'd need a valid verification token
      await page.goto("/verify-email?token=test-token");
      await waitForPageLoad(page);
      
      // Page should load (might show error or success)
      await expect(page.locator('main')).toBeVisible();
    });
  });
});
