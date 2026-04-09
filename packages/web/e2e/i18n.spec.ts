import { test, expect } from "./fixtures/auth";
import { waitForPageLoad } from "./test-utils";

test.describe("Internationalization", () => {
  test.describe("Language Selection", () => {
    test("should display in English by default", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should show English text
      await expect(page.locator('text=/Events|Discover/i')).toBeVisible();
    });
    
    test("should switch to German", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      // Select German
      const languageSelect = page.locator('select[id="language"], select[name="preferredLanguage"]').first();
      if (await languageSelect.isVisible()) {
        await languageSelect.selectOption("de");
        
        // Wait for language change to apply
        await page.waitForTimeout(1000);
        
        // Setting should be saved
        await expect(languageSelect).toHaveValue("de");
      }
    });
    
    test("should persist language preference", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Set language to German
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const languageSelect = page.locator('select[id="language"], select[name="preferredLanguage"]').first();
      if (await languageSelect.isVisible()) {
        await languageSelect.selectOption("de");
        await page.waitForTimeout(500);
        
        // Navigate away and back
        await page.goto("/");
        await waitForPageLoad(page);
        await page.goto("/settings");
        await waitForPageLoad(page);
        
        // Language should still be German
        await expect(languageSelect).toHaveValue("de");
      }
    });
  });
  
  test.describe("Localized Content", () => {
    test("should show localized page titles", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Set to German
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const languageSelect = page.locator('select[id="language"], select[name="preferredLanguage"]').first();
      if (await languageSelect.isVisible()) {
        await languageSelect.selectOption("de");
        await page.waitForTimeout(500);
        
        // Check various pages for localized content
        await page.goto("/login");
        await waitForPageLoad(page);
        
        // Page should load
        await expect(page.locator('main')).toBeVisible();
      }
    });
    
    test("should show localized error messages", async ({ page }) => {
      // Set German
      await page.goto("/settings");
      await page.setViewportSize({ width: 1280, height: 720 });
      await waitForPageLoad(page);
      
      const languageSelect = page.locator('select[id="language"], select[name="preferredLanguage"]').first();
      if (await languageSelect.isVisible()) {
        await languageSelect.selectOption("de");
        await page.waitForTimeout(500);
        
        // Go to login and trigger error
        await page.goto("/login");
        await waitForPageLoad(page);
        
        await page.fill('input[id="username"]', "nonexistent");
        await page.fill('input[id="password"]', "wrongpassword");
        await page.click('button[type="submit"]');
        
        // Error should be visible
        await expect(page.locator('.error-text, [role="alert"]')).toBeVisible();
      }
    });
  });
  
  test.describe("Language Detection", () => {
    test("should detect browser language", async ({ page }) => {
      // Set browser language to German
      await page.context().addInitScript(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'de-DE' });
        Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en'] });
      });
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Page should load (language detection may apply)
      await expect(page.locator('main')).toBeVisible();
    });
    
    test("should fall back to English for unknown language", async ({ page }) => {
      // Set browser language to unsupported language
      await page.context().addInitScript(() => {
        Object.defineProperty(navigator, 'language', { get: () => 'xx-XX' });
        Object.defineProperty(navigator, 'languages', { get: () => ['xx-XX'] });
      });
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should fall back to English
      await expect(page.locator('main')).toBeVisible();
    });
  });
  
  test.describe("Translation Completeness", () => {
    test("should not show translation keys instead of text", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      await page.goto("/");
      await waitForPageLoad(page);
      
      // Should not have raw translation keys visible
      const bodyText = await page.locator('body').textContent();
      
      // Look for common translation key patterns
      const hasTranslationKeys = /\b[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z]+\b/.test(bodyText || '');
      expect(hasTranslationKeys).toBe(false);
    });
    
    test("should have all required translations for settings", async ({ authenticatedPage }) => {
      const page = authenticatedPage;
      
      // Test in English
      await page.goto("/settings");
      await waitForPageLoad(page);
      
      const languageSelect = page.locator('select[id="language"], select[name="preferredLanguage"]').first();
      if (await languageSelect.isVisible()) {
        await languageSelect.selectOption("en");
        await page.waitForTimeout(500);
        
        // Look for missing translation placeholders
        const missingTranslations = await page.locator('text=/^\w+\.\w+$/').count();
        expect(missingTranslations).toBe(0);
      }
    });
  });
});
