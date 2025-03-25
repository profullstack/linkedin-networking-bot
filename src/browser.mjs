import puppeteer from 'puppeteer';
import { logger } from './logger.mjs';
import { BROWSER_CONFIG, NAVIGATION_CONFIG, STEALTH_CONFIG } from './browser-config.mjs';
import { setupRequestInterception, initializePage } from './request-interceptor.mjs';

/**
 * Initialize and configure browser instance with error handling
 * @returns {Promise<{browser: import('puppeteer').Browser, page: import('puppeteer').Page}>}
 */
// Helper function for human-like mouse movement
async function moveMouseInHumanPattern(page, x, y, options = {}) {
  const { moveSpeed, moveSteps, positionVariance } = NAVIGATION_CONFIG.mouse;
  const startPos = await page.evaluate(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2
  }));

  // Add slight randomization to target position
  const targetX = x + Math.floor(Math.random() * (positionVariance.max - positionVariance.min) + positionVariance.min);
  const targetY = y + Math.floor(Math.random() * (positionVariance.max - positionVariance.min) + positionVariance.min);

  // Calculate control points for bezier curve
  const cp1x = startPos.x + (targetX - startPos.x) * (0.2 + Math.random() * 0.2);
  const cp1y = startPos.y + (targetY - startPos.y) * (0.2 + Math.random() * 0.2);
  const cp2x = startPos.x + (targetX - startPos.x) * (0.8 + Math.random() * 0.2);
  const cp2y = startPos.y + (targetY - startPos.y) * (0.8 + Math.random() * 0.2);

  // Generate points along bezier curve
  const points = [];
  const steps = Math.floor(Math.random() * (moveSteps.max - moveSteps.min) + moveSteps.min);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = {
      x: Math.pow(1-t, 3) * startPos.x + 
         3 * Math.pow(1-t, 2) * t * cp1x + 
         3 * (1-t) * Math.pow(t, 2) * cp2x + 
         Math.pow(t, 3) * targetX,
      y: Math.pow(1-t, 3) * startPos.y + 
         3 * Math.pow(1-t, 2) * t * cp1y + 
         3 * (1-t) * Math.pow(t, 2) * cp2y + 
         Math.pow(t, 3) * targetY
    };
    points.push(point);
  }

  // Move mouse along points with variable speed
  for (const point of points) {
    const delay = Math.random() * (moveSpeed.max - moveSpeed.min) + moveSpeed.min;
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(delay / points.length);
  }

  if (options.click) {
    await page.waitForTimeout(NAVIGATION_CONFIG.delays.beforeClick.min + 
      Math.random() * (NAVIGATION_CONFIG.delays.beforeClick.max - NAVIGATION_CONFIG.delays.beforeClick.min));
    await page.mouse.click(targetX, targetY);
    await page.waitForTimeout(NAVIGATION_CONFIG.delays.afterClick.min + 
      Math.random() * (NAVIGATION_CONFIG.delays.afterClick.max - NAVIGATION_CONFIG.delays.afterClick.min));
  }
}

export async function initializeBrowser() {
  let browser;
  try {
    // Launch browser with enhanced configurations
    browser = await puppeteer.launch({
      ...BROWSER_CONFIG,
      // Additional error handling configurations
      handleSIGINT: true,
      handleSIGTERM: true,
      handleSIGHUP: true
    });

    // Set up error handling for browser process
    browser.on('disconnected', () => {
      logger.error('Browser disconnected unexpectedly');
    });

    browser.on('targetdestroyed', (target) => {
      logger.debug(`Target destroyed: ${target.url()}`);
    });

    // Initialize page with error handling
    const page = await initializePage(browser);

    // Apply stealth configurations
    await applyStealthConfigurations(page);

    return { browser, page };
  } catch (error) {
    logger.error('Failed to initialize browser', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

/**
 * Apply stealth configurations to avoid detection
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 */
async function applyStealthConfigurations(page) {
  try {
    // Set random user agent
    const userAgent = STEALTH_CONFIG.userAgents[
      Math.floor(Math.random() * STEALTH_CONFIG.userAgents.length)
    ];
    await page.setUserAgent(userAgent);

    // Set custom headers
    await page.setExtraHTTPHeaders(STEALTH_CONFIG.headers);

    // Apply evasions
    await page.evaluateOnNewDocument((evasions) => {
      evasions.forEach(({ name, value }) => {
        const nameParts = name.split('.');
        let target = window;
        
        for (let i = 0; i < nameParts.length - 1; i++) {
          if (!target[nameParts[i]]) {
            target[nameParts[i]] = {};
          }
          target = target[nameParts[i]];
        }
        
        Object.defineProperty(target, nameParts[nameParts.length - 1], {
          get: () => value,
          configurable: true
        });
      });
    }, STEALTH_CONFIG.evasions);

    // Set navigation timeout
    page.setDefaultNavigationTimeout(NAVIGATION_CONFIG.timeout);
  } catch (error) {
    logger.error('Failed to apply stealth configurations', error);
    throw error;
  }
}

/**
 * Navigate to URL with error handling and retry mechanism
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {string} url - URL to navigate to
 */
export async function navigateWithRetry(page, url) {
  try {
    // Initial page load
    await page.goto(url, NAVIGATION_CONFIG);
    
    // Random initial wait after page load
    await page.waitForTimeout(NAVIGATION_CONFIG.delays.pageLoad.min + 
      Math.random() * (NAVIGATION_CONFIG.delays.pageLoad.max - NAVIGATION_CONFIG.delays.pageLoad.min));

    // Simulate human-like scrolling behavior
    await simulateHumanScrolling(page);
    
    // Random viewport interactions
    await simulateViewportBehavior(page);
  } catch (error) {
    logger.error(`Navigation failed to ${url}`, error);
    throw error;
  }
}

/**
 * Simulate human-like scrolling behavior
 * @param {import('puppeteer').Page} page
 */
async function simulateHumanScrolling(page) {
  const viewportHeight = (await page.viewport()).height;
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  let currentScroll = 0;

  while (currentScroll < pageHeight) {
    // Random scroll amount between 100-400 pixels
    const scrollAmount = Math.floor(Math.random() * 300) + 100;
    currentScroll += scrollAmount;

    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), currentScroll);

    // Random pause between scrolls (500-2000ms)
    await page.waitForTimeout(Math.random() * 1500 + 500);

    // 20% chance to scroll back up slightly
    if (Math.random() < 0.2) {
      currentScroll -= Math.floor(Math.random() * 100);
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), currentScroll);
      await page.waitForTimeout(Math.random() * 1000 + 500);
    }
  }
}

/**
 * Simulate viewport behavior like resizing and mouse movements
 * @param {import('puppeteer').Page} page
 */
async function simulateViewportBehavior(page) {
  // Random viewport resize (10% chance)
  if (Math.random() < 0.1) {
    const width = 1280 + Math.floor(Math.random() * 200) - 100;
    const height = 800 + Math.floor(Math.random() * 100) - 50;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.waitForTimeout(Math.random() * 1000 + 500);
  }

  // Random mouse movements
  for (let i = 0; i < Math.floor(Math.random() * 3) + 1; i++) {
    const x = Math.floor(Math.random() * (await page.evaluate(() => window.innerWidth)));
    const y = Math.floor(Math.random() * (await page.evaluate(() => window.innerHeight)));
    await moveMouseInHumanPattern(page, x, y);
    await page.waitForTimeout(Math.random() * 1000 + 500);
  }
}
