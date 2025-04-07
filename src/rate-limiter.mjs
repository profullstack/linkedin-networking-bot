import { logger } from './logger.mjs';

class RateLimiter {
  constructor() {
    // LinkedIn's recommended weekly limit is ~100, so we'll stay well below that
    this.dailyConnectionLimit = 15; // More conservative daily limit
    this.weeklyConnectionLimit = 80;
    this.dailyMessageLimit = 50;
    
    // More human-like delays with wider variance
    this.minActionDelay = 45000; // 45 seconds minimum
    this.maxActionDelay = 180000; // 3 minutes maximum
    this.typeDelayBase = 150; // Base typing delay in ms
    
    // Counters
    this.connectionCount = 0;
    this.weeklyConnectionCount = 0;
    this.messageCount = 0;
    this.lastActionTime = 0;
    this.lastResetDate = new Date().toDateString();
    this.lastWeeklyReset = new Date().toDateString();
    
    // Progressive delays for failed attempts
    this.consecutiveFailures = 0;
    this.backoffMultiplier = 1;
  }

  async resetCounters() {
    const currentDate = new Date().toDateString();
    const currentDay = new Date().getDay();
    
    // Reset daily counters
    if (currentDate !== this.lastResetDate) {
      this.connectionCount = 0;
      this.messageCount = 0;
      this.lastResetDate = currentDate;
      logger.info('Daily rate limits reset');
    }
    
    // Reset weekly counters on Monday
    if (currentDay === 1 && currentDate !== this.lastWeeklyReset) {
      this.weeklyConnectionCount = 0;
      this.lastWeeklyReset = currentDate;
      logger.info('Weekly rate limits reset');
      // Reset backoff on weekly reset
      this.consecutiveFailures = 0;
      this.backoffMultiplier = 1;
    }
  }

  getRandomDelay() {
    // Use a more natural distribution (gaussian-like)
    const baseDelay = (this.maxActionDelay + this.minActionDelay) / 2;
    const variance = (this.maxActionDelay - this.minActionDelay) / 4;
    
    // Sum of multiple random numbers approaches normal distribution
    let delay = 0;
    for (let i = 0; i < 3; i++) {
      delay += Math.random() * variance;
    }
    delay = baseDelay + (delay - (variance * 1.5));
    
    // Apply backoff multiplier for consecutive failures
    delay *= this.backoffMultiplier;
    
    // Ensure delay stays within bounds
    return Math.max(this.minActionDelay, Math.min(this.maxActionDelay * 3, delay));
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
    await this.resetCounters();
    
    // Check both daily and weekly limits
    if (this.connectionCount >= this.dailyConnectionLimit) {
      logger.warn('Daily connection limit reached');
      return false;
    }
    
    if (this.weeklyConnectionCount >= this.weeklyConnectionLimit) {
      logger.warn('Weekly connection limit reached');
      return false;
    }
    
    // Add time-of-day restrictions
    const hour = new Date().getHours();
    if (hour < 8 || hour > 22) { // Only operate during business hours
      logger.info('Outside of operating hours (8 AM - 10 PM)');
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
    await this.resetCounters();
    this.connectionCount++;
    this.weeklyConnectionCount++;
    logger.info(`Connection count: ${this.connectionCount}/${this.dailyConnectionLimit} daily, ${this.weeklyConnectionCount}/${this.weeklyConnectionLimit} weekly`);
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
      '.artdeco-modal__content:contains("try again later")',
      '.artdeco-modal__content:contains("unusual activity")',
      '.artdeco-modal__content:contains("security check")',
      'form#challenge'
    ];

    for (const selector of rateLimitSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          this.consecutiveFailures++;
          
          // Exponential backoff with max cap
          const baseDelay = 3600000; // 1 hour base delay
          this.backoffMultiplier = Math.min(Math.pow(2, this.consecutiveFailures - 1), 8);
          const waitTime = baseDelay * this.backoffMultiplier;
          
          logger.warn(`Rate limit detected (attempt ${this.consecutiveFailures}), waiting for ${waitTime/3600000} hours...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return true;
        }
      } catch (error) {
        logger.error('Error checking rate limit', error);
      }
    }
    
    // If we get here, no rate limit was detected
    if (this.consecutiveFailures > 0) {
      this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1); // Gradually reduce failures
      this.backoffMultiplier = Math.max(1, this.backoffMultiplier * 0.75); // Gradually reduce backoff
    }
    return false;
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiter();