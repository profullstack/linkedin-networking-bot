import { logger } from './logger.mjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SESSION_EXPIRY_TIME = 7200000; // 2 hours in milliseconds
const PROXY_ROTATION_INTERVAL = 3600000; // 1 hour in milliseconds
const MAX_LOGIN_RETRIES = 3;
const RETRY_DELAY = 15000; // 15 seconds
const BOT_DETECTION_INDICATORS = [
  'unusual activity',
  'security verification',
  'prove you\'re a human',
  'confirm your identity',
  'complete these steps',
  'we need you to verify',
  'please solve this puzzle'
];

class SessionManager {
  constructor() {
    this.cookiesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../cookies.json');
    this.sessionStartTime = null;
    this.lastProxyRotation = null;
    this.loginRetries = 0;
    this.lastUserAgent = null;
    this.detectionScore = 0; // Track suspicious activity score
    this.lastCookieRotation = null;
    this.cookieRotationInterval = 4 * 3600000; // 4 hours
  }

  async loadCookies() {
    try {
      const cookiesData = await fs.readFile(this.cookiesFile, 'utf-8');
      const cookies = JSON.parse(cookiesData);
      
      // Filter out expired cookies
      const now = Date.now() / 1000;
      const validCookies = cookies.filter(cookie => {
        return !cookie.expires || cookie.expires > now;
      });
      
      if (validCookies.length < cookies.length) {
        logger.info(`Filtered out ${cookies.length - validCookies.length} expired cookies`);
      }
      
      return validCookies;
    } catch (error) {
      logger.info('No existing cookies found or error loading cookies');
      return [];
    }
  }

  async saveCookies(page) {
    try {
      const cookies = await page.cookies();
      const validCookies = this.filterValidCookies(cookies);
      
      if (validCookies.length === 0) {
        throw new Error('No valid cookies found');
      }

      await fs.writeFile(this.cookiesFile, JSON.stringify(validCookies, null, 2));
      logger.info(`Saved ${validCookies.length} valid cookies`);
      this.sessionStartTime = Date.now();
    } catch (error) {
      logger.error(`Error saving cookies: ${error.message}`);
      throw error;
    }
  }

  filterValidCookies(cookies) {
    const essentialCookies = ['li_at', 'JSESSIONID'];
    return cookies.filter(cookie => {
      // Check expiration
      if (cookie.expires && cookie.expires < Date.now() / 1000) {
        return false;
      }

      // Validate cookie properties
      if (!cookie.name || !cookie.value) {
        return false;
      }

      // Keep only LinkedIn cookies
      if (!cookie.domain.includes('linkedin.com')) {
        return false;
      }

      return true;
    });
  }

  async validateSession(page) {
    try {
      // Check for bot detection indicators
      const content = await page.content();
      for (const indicator of BOT_DETECTION_INDICATORS) {
        if (content.toLowerCase().includes(indicator)) {
          this.detectionScore += 2;
          logger.warn(`Bot detection indicator found: ${indicator}`);
          return false;
        }
      }

      const cookies = await page.cookies();
      const essentialCookies = ['li_at', 'JSESSIONID'];
      const missingCookies = essentialCookies.filter(
        name => !cookies.some(cookie => cookie.name === name)
      );

      if (missingCookies.length > 0) {
        logger.info(`Missing essential cookies: ${missingCookies.join(', ')}`);
        return false;
      }

      // Check session age
      if (this.sessionStartTime && (Date.now() - this.sessionStartTime > SESSION_EXPIRY_TIME)) {
        logger.info('Session expired');
        return false;
      }

      // Check if we need to rotate cookies
      if (this.lastCookieRotation && (Date.now() - this.lastCookieRotation > this.cookieRotationInterval)) {
        logger.info('Cookie rotation interval reached');
        return false;
      }

      // Check detection score
      if (this.detectionScore >= 5) {
        logger.warn('High detection score, forcing session reset');
        return false;
      }

      // Gradually reduce detection score over time
      if (this.detectionScore > 0) {
        this.detectionScore = Math.max(0, this.detectionScore - 0.5);
      }

      return true;
    } catch (error) {
      logger.error(`Error validating session: ${error.message}`);
      return false;
    }
  }

  shouldRotateProxy() {
    // Force proxy rotation if detection score is high
    if (this.detectionScore >= 3) {
      logger.warn('Forcing proxy rotation due to high detection score');
      return true;
    }
    
    if (!this.lastProxyRotation) {
      return true;
    }
    
    // Randomize rotation interval slightly
    const jitter = Math.random() * 600000; // Up to 10 minutes of jitter
    return Date.now() - this.lastProxyRotation >= (PROXY_ROTATION_INTERVAL + jitter);
  }

  markProxyRotated() {
    this.lastProxyRotation = Date.now();
  }

  async handleLoginRetry(page, username, password, loginFunction) {
    while (this.loginRetries < MAX_LOGIN_RETRIES) {
      try {
        const success = await loginFunction(page, username, password);
        if (success) {
          this.loginRetries = 0;
          return true;
        }
      } catch (error) {
        logger.error(`Login attempt ${this.loginRetries + 1} failed: ${error.message}`);
      }

      this.loginRetries++;
      if (this.loginRetries < MAX_LOGIN_RETRIES) {
        logger.info(`Waiting ${RETRY_DELAY/1000} seconds before next login attempt...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }

    logger.error('Max login retries exceeded');
    return false;
  }

  resetLoginRetries() {
    this.loginRetries = 0;
  }
}

export const sessionManager = new SessionManager();