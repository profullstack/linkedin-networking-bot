import { logger } from './logger.mjs';
import { isSilentError, withRetry } from './error-handler.mjs';

/**
 * Configure request interception for better error handling and retry logic
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 */
// Configure request throttling and delays
const REQUEST_CONFIG = {
  minDelay: 8000,  // Minimum delay between requests
  maxDelay: 15000,  // Maximum delay between requests
  backoffFactor: 2.5,  // Exponential backoff multiplier
  maxBackoffDelay: 120000,  // Maximum backoff delay
  retryCount: 7,  // Number of retries for failed requests
  errorDelay: 30000,  // Additional delay after encountering errors
  // Randomization factors to appear more human-like
  randomization: {
    delayVariance: 0.3, // Add ±30% random variance to delays
    requestChance: 0.9  // 90% chance to proceed with request
  }
};

// Get random delay with exponential backoff
const getRandomDelay = (attempt = 1) => {
  const baseDelay = Math.random() * (REQUEST_CONFIG.maxDelay - REQUEST_CONFIG.minDelay) + REQUEST_CONFIG.minDelay;
  const backoffDelay = baseDelay * Math.pow(REQUEST_CONFIG.backoffFactor, attempt - 1);
  const finalDelay = Math.min(backoffDelay, REQUEST_CONFIG.maxBackoffDelay);
  
  // Add random variance to make delays appear more natural
  const variance = REQUEST_CONFIG.randomization.delayVariance;
  const randomFactor = 1 + (Math.random() * 2 - 1) * variance;
  return Math.floor(finalDelay * randomFactor);
};

export async function setupRequestInterception(page) {
  await page.setRequestInterception(true);
  let lastRequestTime = Date.now();

  page.on('request', async (request) => {
    try {
      // Implement request throttling with exponential backoff
      const timeSinceLastRequest = Date.now() - lastRequestTime;
      if (timeSinceLastRequest < REQUEST_CONFIG.minDelay) {
        const delay = getRandomDelay();
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      lastRequestTime = Date.now();

      // Add additional delay if previous request had errors
      if (request.headers()['x-had-error']) {
        await new Promise(resolve => setTimeout(resolve, REQUEST_CONFIG.errorDelay));
      }

      // Handle retries for failed requests
      let attempt = 1;
      while (attempt <= REQUEST_CONFIG.retryCount) {
        try {

      // Filter out unnecessary resource types with smart resource management
      const resourceType = request.resourceType();
      const url = request.url();
      
      // Essential resources that should always be loaded
      if (url.includes('api') || url.includes('graphql') || resourceType === 'xhr' || resourceType === 'fetch') {
        const headers = request.headers();
        await request.continue({ headers });
        return;
      }
      
      // Non-essential resources with selective loading
      if (['image', 'media', 'font', 'other'].includes(resourceType)) {
        // Higher chance to load resources from the main domain
        const isMainDomain = url.includes('linkedin.com');
        const loadChance = isMainDomain ? 0.3 : 0.1;
        
        if (Math.random() < loadChance) {
          const headers = request.headers();
          await request.continue({ headers });
          return;
        }
        await request.abort();
        return;
      }

      // Add custom headers with slight randomization
      const headers = request.headers();
      headers['Cache-Control'] = Math.random() < 0.5 ? 'no-cache' : 'max-age=0';
      headers['Pragma'] = 'no-cache';
      headers['Accept-Encoding'] = 'gzip, deflate, br';
      headers['Connection'] = 'keep-alive';

      // Continue with modified request
          await request.continue({ headers });
          break;
        } catch (error) {
          // Handle various error types with specific strategies
          if (error.message.includes('400') || error.message.includes('Bad Request')) {
            logger.debug(`Silent 400 error on attempt ${attempt}, retrying...`);
            const retryDelay = getRandomDelay(attempt) + REQUEST_CONFIG.errorDelay;
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            
            // Mark the request as having had an error
            const headers = request.headers();
            headers['x-had-error'] = 'true';
            headers['x-retry-attempt'] = attempt.toString();
            
            attempt++;
            if (attempt > REQUEST_CONFIG.retryCount) {
              logger.debug('Max retries reached for 400 error, aborting request');
              await request.abort();
            }
            continue;
          }
          
          // Handle rate limiting errors
          if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
            const retryDelay = getRandomDelay(attempt) * 2; // Double the delay for rate limits
            logger.debug(`Rate limit hit, waiting ${retryDelay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            attempt++;
            continue;
          }
          
          // Handle network errors with exponential backoff
          if (error.message.includes('net::')) {
            const backoffDelay = getRandomDelay(attempt) * REQUEST_CONFIG.backoffFactor;
            logger.debug(`Network error, applying backoff delay of ${backoffDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            attempt++;
            if (attempt <= REQUEST_CONFIG.retryCount) continue;
          }
          
          logger.debug(`Request interception error: ${error.message}`);
          await request.abort();
          break;
        }
      }
    } catch (error) {
      logger.error(`Request interception error: ${error.message}`);
      await request.abort();
    }
  });

  // Handle failed requests
  page.on('requestfailed', async (request) => {
    const failure = request.failure();
    const errorText = failure ? failure.errorText : 'Unknown error';
    
    if (isSilentError(errorText)) {
      logger.debug(`Silent error occurred: ${errorText} for URL: ${request.url()}`);
      return;
    }

    logger.error(`Request failed: ${errorText} for URL: ${request.url()}`);
  });

  // Monitor network idle state
  page.on('networkidle0', () => {
    logger.debug('Network is idle (0 connections for 500ms)');
  });

  // Handle response errors
  page.on('response', async (response) => {
    const status = response.status();
    if (status >= 400) {
      logger.error(`HTTP ${status} error for URL: ${response.url()}`);
    }
  });
}

/**
 * Initialize browser page with error handling and retry mechanisms
 * @param {import('puppeteer').Browser} browser - Puppeteer browser instance
 * @returns {Promise<import('puppeteer').Page>} - Configured page instance
 */
export async function initializePage(browser) {
  const page = await withRetry(
    async () => await browser.newPage(),
    'Creating new page'
  );

  await setupRequestInterception(page);

  // Set default timeout
  page.setDefaultTimeout(45000);

  // Handle page errors
  page.on('error', error => {
    logger.error(`Page crashed: ${error.message}`, error);
  });

  page.on('pageerror', error => {
    logger.error(`Page error: ${error.message}`, error);
  });

  return page;
}