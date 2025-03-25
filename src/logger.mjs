import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.join(__dirname, '../logs');

// Ensure logs directory exists
function ensureLogsDir() {
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
}

// Log levels
const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
};

class Logger {
  constructor() {
    this.logFile = path.join(logsDir, `linkedin-bot-${dayjs().format('YYYY-MM-DD')}.log`);
    ensureLogsDir();
  }

  async log(level, message, error = null) {
    const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');
    let logMessage = `[${timestamp}] ${level}: ${message}`;
    
    if (error) {
      // Only log error message and stack, not the full error object
      logMessage += `\nError: ${error.message}`;
      if (error.stack) {
        logMessage += `\nStack: ${error.stack}`;
      }
    }
    
    logMessage += '\n';
    
    try {
      await fs.appendFile(this.logFile, logMessage);
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
    
    // Only show non-error messages in console if not in production
    if (process.env.NODE_ENV !== 'production' || level === LogLevel.ERROR) {
      console.log(logMessage);
    }
  }

  debug(message) {
    return this.log(LogLevel.DEBUG, message);
  }

  info(message) {
    return this.log(LogLevel.INFO, message);
  }

  warn(message, error = null) {
    return this.log(LogLevel.WARN, message, error);
  }

  error(message, error = null) {
    return this.log(LogLevel.ERROR, message, error);
  }

  // Special method for browser console messages
  async handleBrowserConsole(type, message) {
    // Filter out common non-critical messages
    const ignoredMessages = [
      'net::ERR_FAILED',
      'status of 400',
      'Failed to load resource',
      'the server responded with a status'
    ];

    if (ignoredMessages.some(msg => message.includes(msg))) {
      // Log these to debug level only
      return this.debug(`Browser ${type}: ${message}`);
    }

    // Log other console messages based on their type
    switch(type) {
      case 'error':
        return this.error(`Browser: ${message}`);
      case 'warning':
        return this.warn(`Browser: ${message}`);
      default:
        return this.debug(`Browser ${type}: ${message}`);
    }
  }
}

// Export singleton instance
export const logger = new Logger();