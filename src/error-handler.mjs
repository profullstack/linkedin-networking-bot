import { logger } from './logger.mjs';

// Network error patterns to handle silently
const SILENT_ERRORS = [
  // Network errors
  'net::ERR_FAILED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_ABORTED',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_ADDRESS_UNREACHABLE',
  // HTTP status errors
  'the server responded with a status of 400',
  'the server responded with a status of 429',
  'the server responded with a status of 403',
  'the server responded with a status of 404',
  'the server responded with a status of 500',
  'the server responded with a status of 502',
  'the server responded with a status of 503',
  'the server responded with a status of 504',
  'Error 400',
  'Bad Request',
  'status of 400',
  'status: 400',
  // Rate limiting errors
  'ERR_TOO_MANY_REQUESTS',
  'ERR_RATE_LIMITED',
  'Too Many Requests',
  'Rate limit exceeded',
  // Content errors
  'malformed JSON response',
  'Failed to load resource',
  'Navigation timeout',
  'TimeoutError',
  'Requesting main frame too early',
  'Protocol error',
  'Target closed',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_NETWORK_ACCESS_DENIED'
];

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 10,
  initialDelay: 8000,
  maxDelay: 120000,
  backoffFactor: 2.5,
  errorDelay: 30000,
  // Randomization to appear more human-like
  randomization: {
    delayVariance: 0.3, // Add ±30% random variance to delays
    retryChance: 0.95   // 95% chance to retry on error
  }
};

/**
 * Check if an error should be handled silently
 * @param {string} errorMessage - The error message to check
 * @returns {boolean} - Whether the error should be handled silently
 */
export function isSilentError(errorMessage) {
  return SILENT_ERRORS.some(pattern => errorMessage.includes(pattern));
}

/**
 * Calculate delay for retry attempt
 * @param {number} attempt - The current retry attempt number
 * @returns {number} - The delay in milliseconds
 */
function calculateDelay(attempt) {
  const delay = RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt - 1);
  return Math.min(delay, RETRY_CONFIG.maxDelay);
}

/**
 * Handle network errors with retry logic
 * @param {Function} operation - The async operation to retry
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise<any>} - The result of the operation
 */
export async function withRetry(operation, operationName) {
  let lastError;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (isSilentError(error.message)) {
        logger.debug(`Silent error in ${operationName} (attempt ${attempt}/${RETRY_CONFIG.maxRetries}): ${error.message}`);
      } else {
        logger.warn(`Error in ${operationName} (attempt ${attempt}/${RETRY_CONFIG.maxRetries})`, error);
      }
      
      if (attempt === RETRY_CONFIG.maxRetries) break;
      
      const delay = calculateDelay(attempt);
      logger.debug(`Retrying ${operationName} in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Add error handlers to a Puppeteer page
 * @param {Page} page - Puppeteer page object
 */
export function setupPageErrorHandlers(page) {
  // Handle page errors
  page.on('error', error => {
    if (!isSilentError(error.message)) {
      logger.error('Page crashed', error);
    }
  });
  
  // Handle page console messages
  page.on('console', message => {
    const type = message.type();
    const text = message.text();
    
    if (isSilentError(text)) {
      logger.debug(`Browser ${type}: ${text}`);
    } else if (type === 'error' || type === 'warning') {
      logger.warn(`Browser ${type}: ${text}`);
    }
  });
  
  // Handle request failures
  page.on('requestfailed', request => {
    const failure = request.failure();
    const errorText = failure ? failure.errorText : 'Unknown error';
    
    if (!isSilentError(errorText)) {
      logger.warn(`Request failed: ${request.url()}`, { error: errorText });
    }
  });
}