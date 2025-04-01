import { logger } from './logger.mjs';

class RateLimiter {
  constructor() {
    this.dailyConnectionLimit = 100; // LinkedIn's recommended limit
    this.dailyMessageLimit = 100;
    this.minActionDelay = 30000; // 30 seconds minimum between actions
    this.maxActionDelay = 120000; // 2 minutes maximum between actions
    this.connectionCount = 0;
    this.messageCount = 0;
    this.lastActionTime = 0;
    this.lastResetDate = new Date().toDateString();
  }

  async resetDailyCounters() {
    const currentDate = new Date().toDateString();
    if (currentDate !== this.lastResetDate) {
      this.connectionCount = 0;
      this.messageCount = 0;
      this.lastResetDate = currentDate;
      logger.info('Daily rate limits reset');
    }
  }

  getRandomDelay() {
    return Math.floor(Math.random() * (this.maxActionDelay - this.minActionDelay + 1)) + this.minActionDelay;
  }

  async waitForNextAction() {
    await this.resetDailyCounters();
    
    const now = Date.now();
    const timeSinceLastAction = now - this.lastActionTime;
    const delay = this.getRandomDelay();
    
    if (timeSinceLastAction < delay) {
      const waitTime = delay - timeSinceLastAction;
      logger.info(`Waiting ${waitTime/1000} seconds before next action...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastActionTime = Date.now();
  }

  async checkConnectionLimit() {
    await this.resetDailyCounters();
    if (this.connectionCount >= this.dailyConnectionLimit) {
      logger.warn('Daily connection limit reached');
      return false;
    }
    return true;
  }

  async checkMessageLimit() {
    await this.resetDailyCounters();
    if (this.messageCount >= this.dailyMessageLimit) {
      logger.warn('Daily message limit reached');
      return false;
    }
    return true;
  }

  async incrementConnectionCount() {
    await this.resetDailyCounters();
    this.connectionCount++;
    logger.info(`Connection count: ${this.connectionCount}/${this.dailyConnectionLimit}`);
  }

  async incrementMessageCount() {
    await this.resetDailyCounters();
    this.messageCount++;
    logger.info(`Message count: ${this.messageCount}/${this.dailyMessageLimit}`);
  }

  async handleRateLimit(page) {
    const rateLimitSelectors = [
      '.artdeco-modal__content:contains("rate limit")',
      '.artdeco-modal__content:contains("too many requests")',
      '.artdeco-modal__content:contains("try again later")'
    ];

    for (const selector of rateLimitSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          logger.warn('Rate limit detected, waiting for 1 hour...');
          await new Promise(resolve => setTimeout(resolve, 3600000)); // Wait 1 hour
          return true;
        }
      } catch (error) {
        logger.error('Error checking rate limit', error);
      }
    }
    return false;
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiter();