import { logger } from './logger.mjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SESSION_EXPIRY_TIME = 3600000; // 1 hour in milliseconds
const PROXY_ROTATION_INTERVAL = 1800000; // 30 minutes in milliseconds
const MAX_LOGIN_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

class SessionManager {
  constructor() {
    this.cookiesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../cookies.json');
    this.sessionStartTime = null;
    this.lastProxyRotation = null;
    this.loginRetries = 0;
  }

  async loadCookies() {
    try {
      const cookiesData = await fs.readFile(this.cookiesFile, 'utf-8');
      return JSON.parse(cookiesData);
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

      return true;
    } catch (error) {
      logger.error(`Error validating session: ${error.message}`);
      return false;
    }
  }

  shouldRotateProxy() {
    if (!this.lastProxyRotation) {
      return true;
    }
    return Date.now() - this.lastProxyRotation >= PROXY_ROTATION_INTERVAL;
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