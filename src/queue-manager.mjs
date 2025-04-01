import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import dayjs from 'dayjs';
import { logger } from './logger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const queueFile = path.join(__dirname, '../queue.json');
const processedFile = path.join(__dirname, '../processed.json');

/**
 * Load JSON data from a file, creating it if it doesn't exist
 */
async function loadJson(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    await fs.writeFile(filePath, '[]');
    return [];
  }
}

/**
 * Save JSON data to a file
 */
async function saveJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Queue Manager class to handle LinkedIn profile processing
 */
export class QueueManager {
  constructor() {
    this.queueFile = queueFile;
    this.processedFile = processedFile;
  }

  /**
   * Add a profile to the connection queue
   */
  async addToQueue(profile) {
    try {
      const queue = await loadJson(this.queueFile);
      const processed = await loadJson(this.processedFile);

      // Check if profile is already in queue or processed
      const isQueued = queue.some(p => p.profileUrl === profile.profileUrl);
      const isProcessed = processed.some(p => p.profileUrl === profile.profileUrl);

      if (isQueued || isProcessed) {
        logger.info(`Profile ${profile.name} already in queue or processed`);
        return false;
      }

      // Add to queue with timestamp
      queue.push({
        ...profile,
        queuedAt: new Date().toISOString()
      });

      await saveJson(this.queueFile, queue);
      logger.info(`Added ${profile.name} to connection queue`);
      return true;
    } catch (error) {
      logger.error('Error adding profile to queue:', error);
      return false;
    }
  }

  /**
   * Add multiple profiles to the queue
   */
  async addBatchToQueue(profiles) {
    try {
      const queue = await loadJson(this.queueFile);
      const processed = await loadJson(this.processedFile);
      let addedCount = 0;

      for (const profile of profiles) {
        // Skip if already in queue or processed
        const isQueued = queue.some(p => p.profileUrl === profile.profileUrl);
        const isProcessed = processed.some(p => p.profileUrl === profile.profileUrl);

        if (!isQueued && !isProcessed) {
          queue.push({
            ...profile,
            queuedAt: new Date().toISOString()
          });
          addedCount++;
        }
      }

      if (addedCount > 0) {
        await saveJson(this.queueFile, queue);
        logger.info(`Added ${addedCount} profiles to connection queue`);
      }

      return addedCount;
    } catch (error) {
      logger.error('Error adding batch to queue:', error);
      return 0;
    }
  }

  /**
   * Mark a profile as processed
   */
  async markProcessed(profile, status = 'completed') {
    try {
      const processed = await loadJson(this.processedFile);
      processed.push({
        ...profile,
        status,
        processedAt: new Date().toISOString()
      });

      await saveJson(this.processedFile, processed);
      logger.info(`Marked ${profile.name} as processed with status: ${status}`);
      return true;
    } catch (error) {
      logger.error('Error marking profile as processed:', error);
      return false;
    }
  }

  /**
   * Get the current queue status
   */
  async getQueueStatus() {
    try {
      const queue = await loadJson(this.queueFile);
      const processed = await loadJson(this.processedFile);

      return {
        queueLength: queue.length,
        processedCount: processed.length,
        nextInQueue: queue[0] || null
      };
    } catch (error) {
      logger.error('Error getting queue status:', error);
      return null;
    }
  }

  /**
   * Clean old entries from the queue
   */
  async cleanQueue(maxAge = 7) {
    try {
      const queue = await loadJson(this.queueFile);
      const cutoffDate = dayjs().subtract(maxAge, 'days');

      const updatedQueue = queue.filter(profile => {
        return dayjs(profile.queuedAt).isAfter(cutoffDate);
      });

      if (updatedQueue.length < queue.length) {
        await saveJson(this.queueFile, updatedQueue);
        logger.info(`Cleaned ${queue.length - updatedQueue.length} old entries from queue`);
      }

      return true;
    } catch (error) {
      logger.error('Error cleaning queue:', error);
      return false;
    }
  }
}