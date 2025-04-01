import cron from 'node-cron';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import dayjs from 'dayjs';
import { logger } from './logger.mjs';
import { rateLimiter } from './rate-limiter.mjs';
import { initOpenAI } from './openai-vision.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pendingFile = path.join(__dirname, '../pending.json');
const messagedFile = path.join(__dirname, '../messaged.json');
const queueFile = path.join(__dirname, '../queue.json');
const config = JSON.parse(await fs.readFile(path.join(__dirname, '../config.json')));

// Initialize OpenAI for personalized messages
await initOpenAI();

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
 * Generate a personalized follow-up message using GPT-4
 */
async function generatePersonalizedMessage(profileData) {
  try {
    const prompt = `Create a friendly, professional follow-up message for a LinkedIn connection. Use this context:
    - Their profile: ${profileData.name} - ${profileData.headline || 'Tech Professional'}
    - Initial message sent: ${config.follow_up_message}
    - Time since connection: ${profileData.daysSinceConnection} days
    - Keep it brief, natural, and focused on professional networking
    - Don't mention AI or automated messages`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    });

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    logger.error('Error generating follow-up message:', error);
    return config.follow_up_message;
  }
}

/**
 * Process the connection queue
 */
async function processConnectionQueue() {
  try {
    const queue = await loadJson(queueFile);
    const pending = await loadJson(pendingFile);

    if (queue.length === 0) {
      logger.info('Connection queue is empty');
      return;
    }

    // Check rate limits
    if (!(await rateLimiter.checkConnectionLimit())) {
      logger.warn('Daily connection limit reached');
      return;
    }

    // Process one connection from the queue
    const connection = queue.shift();
    pending.push({
      ...connection,
      date: new Date().toISOString()
    });

    await saveJson(queueFile, queue);
    await saveJson(pendingFile, pending);
    await rateLimiter.incrementConnectionCount();

    logger.info(`Processed connection request for ${connection.name}`);
  } catch (error) {
    logger.error('Error processing connection queue:', error);
  }
}

/**
 * Process follow-up messages
 */
async function processFollowUpMessages() {
  try {
    const pending = await loadJson(pendingFile);
    const messaged = await loadJson(messagedFile);
    const yesterday = dayjs().subtract(1, 'day').toISOString();
    const twoDaysAgo = dayjs().subtract(2, 'days').toISOString();

    // Find connections that need follow-up
    const needsFollowUp = pending.filter(conn => {
      const connDate = dayjs(conn.date);
      return connDate.isBefore(yesterday) && 
             !messaged.find(m => m.profileUrl === conn.profileUrl);
    });

    if (needsFollowUp.length === 0) {
      logger.info('No connections need follow-up messages');
      return;
    }

    // Check rate limits
    if (!(await rateLimiter.checkMessageLimit())) {
      logger.warn('Daily message limit reached');
      return;
    }

    // Process one follow-up message
    const connection = needsFollowUp[0];
    const daysSinceConnection = dayjs().diff(dayjs(connection.date), 'day');

    // Generate personalized message based on connection time
    const message = daysSinceConnection >= 2 ?
      await generatePersonalizedMessage({ ...connection, daysSinceConnection }) :
      config.follow_up_message;

    // Mark as messaged
    messaged.push({
      ...connection,
      messageDate: new Date().toISOString(),
      message
    });

    await saveJson(messagedFile, messaged);
    await rateLimiter.incrementMessageCount();

    logger.info(`Sent follow-up message to ${connection.name}`);
  } catch (error) {
    logger.error('Error processing follow-up messages:', error);
  }
}

/**
 * Clean up abandoned connections
 */
async function cleanupAbandonedConnections() {
  try {
    const pending = await loadJson(pendingFile);
    const twoDaysAgo = dayjs().subtract(2, 'days').toISOString();

    // Remove connections older than 48 hours that haven't been messaged
    const updatedPending = pending.filter(conn => {
      return dayjs(conn.date).isAfter(twoDaysAgo);
    });

    if (updatedPending.length < pending.length) {
      await saveJson(pendingFile, updatedPending);
      logger.info(`Cleaned up ${pending.length - updatedPending.length} abandoned connections`);
    }
  } catch (error) {
    logger.error('Error cleaning up abandoned connections:', error);
  }
}

// Schedule tasks
export function startScheduler() {
  // Process one connection request every hour
  cron.schedule('0 * * * *', processConnectionQueue);

  // Process follow-up messages every hour
  cron.schedule('30 * * * *', processFollowUpMessages);

  // Clean up abandoned connections daily
  cron.schedule('0 0 * * *', cleanupAbandonedConnections);

  logger.info('Task scheduler started');
}