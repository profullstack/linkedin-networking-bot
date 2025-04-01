import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import { setTimeout as wait } from 'timers/promises';
import readline from 'readline';
import dotenv from 'dotenv';
import { existsSync, mkdirSync } from 'fs';
import { logger } from './logger.mjs';
import { rateLimiter } from './rate-limiter.mjs';
import { analyzeCaptchaBox, analyzePuzzleCaptcha, initOpenAI } from './openai-vision.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = JSON.parse(await fs.readFile(path.join(__dirname, '../config.json')));

const pendingFile = path.join(__dirname, '../pending.json');
const messagedFile = path.join(__dirname, '../messaged.json');
const cookiesFile = path.join(__dirname, '../cookies.json');
const logsDir = path.join(__dirname, '../logs');

// Load environment variables from .env file
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

// Ensure logs directory exists
function ensureLogsDir() {
  if (!existsSync(logsDir)) {
    logger.info('Creating logs directory...');
    mkdirSync(logsDir, { recursive: true });
  }
}

/**
 * Save a screenshot to the logs directory with a standardized naming convention
 * @param {Page} page - Puppeteer page object
 * @param {string} prefix - Prefix for the screenshot filename
 * @param {string} [description] - Optional description for the console log
 * @returns {Promise<string>} - Path to the saved screenshot
 */
async function saveScreenshot(page, prefix, description = '') {
  ensureLogsDir();
  const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss');
  const filename = `${prefix}_${timestamp}.png`;
  const filepath = path.join(logsDir, filename);

  try {
    await page.screenshot({ path: filepath });
    const logDesc = description || prefix.replace(/-/g, ' ');
    logger.info(`Saved ${logDesc} screenshot to logs/${filename}`);
    return filepath;
  } catch (error) {
    logger.error('Error saving screenshot', error);
    return null;
  }
}

async function loadJson(file) {
  try {
    const data = await fs.readFile(file, 'utf8');
    if (!data.trim()) {
      logger.info(`File ${file} is empty`);
      return [];
    }
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.info(`File ${file} not found`);
    } else {
      logger.error(`Error loading file ${file}`, error);
    }
    return [];
  }
}

async function saveJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

/**
 * Deduplicate a list of profiles by profileUrl
 * @param {string} filePath - Path to the JSON file containing profiles
 * @returns {Promise<void>}
 */
async function deduplicateProfiles(filePath) {
  try {
    logger.info(`Deduplicating profiles in ${filePath}...`);
    const profiles = await loadJson(filePath);

    if (profiles.length === 0) {
      logger.info(`No profiles found in ${filePath}`);
      return;
    }

    logger.info(`Found ${profiles.length} profiles in ${filePath}`);

    // Create a map to store unique profiles by URL
    const uniqueProfiles = new Map();

    // Process each profile
    for (const profile of profiles) {
      if (!profile.profileUrl) {
        logger.warn(`Skipping profile without URL: ${JSON.stringify(profile)}`);
        continue;
      }

      // Fix unknown names if possible
      if (profile.name === 'Unknown' && profile.profileUrl) {
        try {
          const urlPath = new URL(profile.profileUrl).pathname;
          const inPath = urlPath.split('/in/')[1];
          if (inPath) {
            const nameFromUrl = inPath.split('/')[0].split('?')[0].replace(/-/g, ' ');
            if (nameFromUrl) {
              // Capitalize each word
              profile.name = nameFromUrl.split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
              logger.info(`Updated name from URL: ${profile.name}`);
            }
          }
        } catch (error) {
          logger.error('Error extracting name from URL', error);
        }
      }

      // Only keep the most recent entry for each profileUrl
      if (!uniqueProfiles.has(profile.profileUrl) ||
        new Date(profile.date) > new Date(uniqueProfiles.get(profile.profileUrl).date)) {
        uniqueProfiles.set(profile.profileUrl, profile);
      }
    }

    // Convert map back to array
    const deduplicated = Array.from(uniqueProfiles.values());

    logger.info(`Reduced to ${deduplicated.length} unique profiles`);

    // Save the deduplicated list back to the file
    if (deduplicated.length !== profiles.length) {
      await saveJson(filePath, deduplicated);
      logger.info(`Saved deduplicated profiles to ${filePath}`);
    } else {
      logger.info(`No duplicates found in ${filePath}`);
    }
  } catch (error) {
    logger.error('Error deduplicating profiles', error);
  }
}

async function promptForInput(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise(resolve => {
    rl.question(query, resolve);
  });

  rl.close();
  return answer;
}

async function promptForCredentials() {
  // Try to get credentials from .env file first
  let username = process.env.LINKEDIN_USER;
  let password = process.env.LINKEDIN_PASSWORD;

  // If either credential is missing, prompt for it
  if (!username) {
    username = await promptForInput('Enter your LinkedIn username/email: ');
  } else {
    logger.info('Using LinkedIn username from .env file');
  }

  if (!password) {
    password = await promptForInput('Enter your LinkedIn password: ');
  } else {
    logger.info('Using LinkedIn password from .env file');
  }

  return { username, password };
}

async function launchBrowser() {
  console.log('Launching browser');

  const execPath = process.env.EXEC_PATH || null;

  // Configure proxy if enabled
  let proxyArg = '';
  let username;
  let password;

  const useProxy = process.env.USE_PROXY === 'true';
  if (useProxy) {
    try {
      const proxyList = process.env.PROXY_LIST_PATH;
      if (!proxyList) {
        throw new Error('PROXY_LIST_PATH environment variable is not set');
      }

      const readProxyList = await fs.readFile(proxyList, 'utf8');
      const proxies = readProxyList.split('\n').filter(Boolean);

      if (proxies.length === 0) {
        throw new Error('Proxy list is empty');
      }

      const proxy = proxies[Math.floor(Math.random() * proxies.length)];
      const [ip, port, username, password] = proxy.split(':');

      if (!ip || !port || !username || !password) {
        throw new Error('Invalid proxy format. Expected format: ip:port:username:password');
      }

      proxyArg = `--proxy-server=${ip}:${port}`;
      logger.info(`Using proxy: ${ip}:${port}`);

    } catch (error) {
      logger.error('Failed to configure proxy:', error);
      proxyArg = null;
    }
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: execPath,
    args: [
      proxyArg,
      '--window-size=1280,800',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,FedCM,BlockInsecurePrivateNetworkRequests',
      '--disable-site-isolation-trials',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-notifications',
      '--hide-scrollbars',
      '--mute-audio',
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isLandscape: true
    }
  });

  const page = await browser.newPage();

  if (useProxy) {
    // Set up proxy authentication in Puppeteer
    await page.authenticate({
      username,
      password
    });
  }

  // Define a list of common user agents with recent browser versions
  const userAgents = [
    // Chrome on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Firefox on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    // Edge on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    // Chrome on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Safari on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
  ];

  // Select a random user agent
  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setUserAgent(randomUserAgent);

  // Set extra HTTP headers to mimic a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
  });

  // Modify the navigator object to avoid detection
  await page.evaluateOnNewDocument(() => {
    // Overwrite the 'webdriver' property to make it undefined
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  // Only log errors and warnings to reduce noise
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      console.log(`Browser ${type}:`, msg.text());
    }
  });

  // Set default navigation timeout to be longer
  page.setDefaultNavigationTimeout(90000);

  // Set default timeout for waitForSelector, etc.
  page.setDefaultTimeout(80000);

  return { browser, page };
}

async function saveCookies(page) {
  try {
    // Get all cookies from the page
    const cookies = await page.cookies();

    // Filter out any invalid or expired cookies
    const validCookies = cookies.filter(cookie => {
      // Check if cookie has expired
      if (cookie.expires && cookie.expires < Date.now() / 1000) {
        logger.info(`Skipping expired cookie: ${cookie.name}`);
        return false;
      }

      // Ensure essential properties exist
      if (!cookie.name || !cookie.value) {
        logger.info(`Skipping invalid cookie: ${JSON.stringify(cookie)}`);
        return false;
      }

      // Keep only linkedin.com related cookies
      if (!cookie.domain.includes('linkedin.com')) {
        logger.info(`Skipping non-LinkedIn cookie: ${cookie.name}`);
        return false;
      }

      // Check for essential LinkedIn cookies
      const essentialCookies = ['li_at', 'JSESSIONID'];
      const hasEssentialCookies = essentialCookies.some(name => cookie.name === name);

      return true;
    });

    // Verify we have essential cookies
    const essentialCookies = ['li_at', 'JSESSIONID'];
    const missingEssentials = essentialCookies.filter(name =>
      !validCookies.some(cookie => cookie.name === name)
    );

    if (missingEssentials.length > 0) {
      throw new Error(`Missing essential cookies: ${missingEssentials.join(', ')}`);
    }

    if (validCookies.length === 0) {
      throw new Error('No valid cookies found');
    }

    // Save filtered cookies
    await saveJson(cookiesFile, validCookies);
    logger.info(`Saved ${validCookies.length} valid cookies`);
    return true;
  } catch (error) {
    logger.error(`Error saving cookies: ${error.message}`);
    return false;
  }
}

async function sendOneConnectionRequest(page) {
  // Check daily connection limit before proceeding
  if (!(await rateLimiter.checkConnectionLimit())) {
    logger.info('Daily connection limit reached. Try again tomorrow.');
    return false;
  }

  // Wait for appropriate delay before next action
  await rateLimiter.waitForNextAction();

  logger.info('Processing search results to find connection opportunities...');

  // First, ensure we're logged in
  const isLoggedIn = await checkIfLoggedIn(page);
  if (!isLoggedIn) {
    console.log('Not logged in. Cannot process search results.');
    return false;
  }

  // Save cookies after successful navigation
  await saveCookies(page);

  // Take a screenshot of the current search results page
  await saveScreenshot(page, 'search-results', 'search results page');

  // Log current URL for debugging
  const currentUrl = page.url();
  console.log(`Current URL when processing search results: ${currentUrl}`);

  // Wait for page to load completely
  console.log('Waiting for page to load completely...');
  await page.waitForTimeout(5000); // Give the page some time to load

  // Try multiple possible selectors for search results
  const possibleSelectors = [
    '.reusable-search__result-container', // Original selector
    '.search-results-container',
    '.search-results__list',
    '.artdeco-list__item',
    '.entity-result',
    '.search-entity',
    '.scaffold-layout__list-container li',
    '.artdeco-card',
    '.pv-top-card',
    '.pv-entity__position-group',
    '.profile-card',
    // Add more generic selectors as fallbacks
    'li.artdeco-list__item',
    'li.reusable-search__result-container',
    'li.search-result',
    'div[data-chameleon-result-urn]',
    'div[data-member-id]',
    'div[data-member-urn]'
  ];

  let resultsSelector = null;
  let foundResults = false;

  // Try each selector until we find one that works
  for (const selector of possibleSelectors) {
    try {
      console.log(`Trying selector: ${selector}`);
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        console.log(`Found ${elements.length} results with selector: ${selector}`);
        resultsSelector = selector;
        foundResults = true;
        break;
      }
    } catch (error) {
      console.log(`Error with selector ${selector}: ${error.message}`);
    }
  }

  if (!foundResults) {
    console.log('Could not find any search results with known selectors.');
    console.log('Taking another screenshot for debugging...');
    ensureLogsDir();
    const timestamp = dayjs().format('YYYY-MM-DD_HH-mm-ss');
    await page.screenshot({ path: path.join(logsDir, `search-page-no-results_${timestamp}.png`) });
    console.log(`Saved screenshot to logs/search-page-no-results_${timestamp}.png`);

    // Try to extract any links that might be profile links
    console.log('Attempting to find profile links directly...');
    const profileLinks = await page.$$eval('a[href*="/in/"]', links => {
      return links.map(link => ({
        href: link.href,
        text: link.innerText.trim()
      }));
    });

    console.log(`Found ${profileLinks.length} profile links:`);
    for (const link of profileLinks.slice(0, 5)) { // Show first 5 links
      console.log(`- ${link.text}: ${link.href}`);
    }

    if (profileLinks.length > 0) {
      console.log('Clicking on the first profile link...');
      await page.click(`a[href*="${profileLinks[0].href.split('/in/')[1].split('?')[0]}"]`);
      await page.waitForTimeout(5000);

      // Now we're on a profile page, look for a connect button
      const connectButtonSelectors = [
        'button.pv-s-profile-actions--connect',
        'button[aria-label*="Connect"]',
        'button.artdeco-button--secondary',
        '.pv-top-card-v2-ctas button'
      ];

      let connectButtonFound = false;

      for (const buttonSelector of connectButtonSelectors) {
        try {
          const connectButton = await page.$(buttonSelector);
          if (connectButton) {
            console.log(`Found connect button with selector: ${buttonSelector}`);
            await connectButton.click();
            await page.waitForTimeout(2000);
            connectButtonFound = true;
            break;
          }
        } catch (error) {
          console.log(`Error with button selector ${buttonSelector}: ${error.message}`);
        }
      }

      if (connectButtonFound) {
        // Look for the send button in the modal
        const sendButtonSelectors = [
          'button.artdeco-button--primary',
          'button[aria-label="Send now"]',
          'button[aria-label="Send invitation"]'
        ];

        for (const sendSelector of sendButtonSelectors) {
          try {
            const sendButton = await page.$(sendSelector);
            if (sendButton) {
              console.log(`Found send button with selector: ${sendSelector}`);
              await sendButton.click();
              await page.waitForTimeout(2000);
              console.log('Connection request sent!');
              return true;
            }
          } catch (error) {
            console.log(`Error with send button selector ${sendSelector}: ${error.message}`);
          }
        }
      }
    }

    return false;
  }

  // Find all results
  const results = await page.$$(resultsSelector);
  console.log(`Found ${results.length} results`);

  // Iterate through results to find one that has a Connect button
  for (let i = 0; i < Math.min(results.length, 10); i++) {
    console.log(`Checking result ${i + 1}...`);

    // Try to find the connect button
    const connectButtonSelectors = [
      'button.artdeco-button--secondary',
      'button.artdeco-button--2',
      'button[aria-label*="Connect"]',
      'button[data-control-name="connect"]'
    ];

    let connectButton = null;
    let connectButtonSelector = null;

    for (const selector of connectButtonSelectors) {
      try {
        connectButton = await results[i].$(selector);
        if (connectButton) {
          connectButtonSelector = selector;
          break;
        }
      } catch (error) {
        console.log(`Error finding connect button with selector ${selector}: ${error.message}`);
      }
    }

    if (!connectButton) {
      console.log(`No connect button found for result ${i + 1}, trying next result...`);
      continue;
    }

    console.log(`Found connect button for result ${i + 1} with selector: ${connectButtonSelector}`);

    // Get profile info
    let profileName = 'Unknown';
    let profileUrl = '';

    // Try multiple selectors for profile name
    const nameSelectors = [
      'span.entity-result__title-text', // Standard search results
      'a.app-aware-link', // Alternative in search results
      'span.artdeco-entity-lockup__title', // Another possible location
      'h1.text-heading-xlarge', // Profile page
      'h1.pv-top-card-section__name', // Old profile page
      'span.name', // Another possible location
      'span.profile-name', // Another possible location
      'a[href*="/in/"]' // Last resort - get name from link text
    ];

    for (const selector of nameSelectors) {
      try {
        const nameElement = await results[i].$(selector);
        if (nameElement) {
          const extractedName = await results[i].$eval(selector, el => el.innerText.trim());
          if (extractedName && extractedName.length > 0 && extractedName !== 'Unknown') {
            // Clean up the name (remove degree symbols, etc.)
            profileName = extractedName.split('\n')[0].trim().replace(/[•·⋅∙]/g, '').trim();
            console.log(`Found name using selector ${selector}: ${profileName}`);
            break;
          }
        }
      } catch (error) {
        console.log(`Error getting profile name with selector ${selector}: ${error.message}`);
      }
    }

    // Try multiple selectors for profile URL
    const urlSelectors = [
      'a[href*="/in/"]', // Standard profile links
      'a.app-aware-link[href*="/in/"]', // App-aware links
      'a.artdeco-entity-lockup__link[href*="/in/"]' // Entity lockup links
    ];

    for (const selector of urlSelectors) {
      try {
        const urlElement = await results[i].$(selector);
        if (urlElement) {
          profileUrl = await results[i].$eval(selector, el => el.href);
          if (profileUrl) {
            console.log(`Found URL using selector ${selector}: ${profileUrl}`);
            break;
          }
        }
      } catch (error) {
        console.log(`Error getting profile URL with selector ${selector}: ${error.message}`);
      }
    }

    // If we still don't have a name but have a URL, try to extract name from URL
    if (profileName === 'Unknown' && profileUrl) {
      try {
        const urlPath = new URL(profileUrl).pathname;
        const inPath = urlPath.split('/in/')[1];
        if (inPath) {
          const nameFromUrl = inPath.split('/')[0].split('?')[0].replace(/-/g, ' ');
          if (nameFromUrl) {
            // Capitalize each word
            profileName = nameFromUrl.split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');
            console.log(`Extracted name from URL: ${profileName}`);
          }
        }
      } catch (error) {
        logger.error('Error extracting name from URL', error);
      }
    }

    console.log(`Sending connection request to: ${profileName} (${profileUrl})`);

    // Click the connect button
    try {
      await connectButton.click();
      await page.waitForTimeout(2000);
      
      // Check if we hit a rate limit
      if (await rateLimiter.handleRateLimit(page)) {
        return false;
      }
      
      // Increment connection count on successful click
      await rateLimiter.incrementConnectionCount();

      // Check if there's a follow-up dialog (e.g., add note, send anyway)
      const sendButtonSelectors = [
        'button.artdeco-button--primary',
        'button.artdeco-button--3',
        'button[aria-label="Send now"]',
        'button[aria-label="Send invitation"]'
      ];

      let sendButton = null;

      for (const sendSelector of sendButtonSelectors) {
        try {
          sendButton = await page.$(sendSelector);
          if (sendButton) {
            console.log(`Found send button with selector: ${sendSelector}`);
            await sendButton.click();
            await page.waitForTimeout(2000);
            break;
          }
        } catch (error) {
          console.log(`Error with send button selector ${sendSelector}: ${error.message}`);
        }
      }

      // Load existing pending connections
      const pending = await loadJson(pendingFile);

      // Check if this profile URL already exists in pending
      const isDuplicate = pending.some(p => p.profileUrl === profileUrl);

      if (isDuplicate) {
        console.log(`⚠️ Profile ${profileName} (${profileUrl}) is already in pending list. Skipping.`);
      } else {
        // Save the new pending connection
        pending.push({
          name: profileName,
          profileUrl,
          date: dayjs().format('YYYY-MM-DD')
        });
        await saveJson(pendingFile, pending);
        console.log(`✅ Connection request sent to ${profileName} and added to pending list`);
      }

      console.log(`✅ Connection request sent to ${profileName}`);
      return true;
    } catch (error) {
      console.error(`Error sending connection request: ${error.message}`);
      console.log('Taking screenshot for debugging...');
      await saveScreenshot(page, 'connection-error', 'connection error');
    }
  }

  console.log('Could not send any connection requests.');
  return false;
}

async function sendOneFollowUpMessage(page) {
  const pending = await loadJson(pendingFile);
  const messaged = await loadJson(messagedFile);

  // Filter for connections that were added more than 1 day ago
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const connectionsToMessage = pending.filter(c => c.date < yesterday && !messaged.find(m => m.profileUrl === c.profileUrl));

  if (connectionsToMessage.length === 0) {
    console.log('No pending connections to message.');
    return false;
  }

  console.log(`Found ${connectionsToMessage.length} connections to message.`);
  console.log('Navigating to connections page...');

  try {
    await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', { waitUntil: 'networkidle2' });
    await page.waitForSelector('.mn-connection-card', { timeout: 80000 });
  } catch (error) {
    console.error(`Error accessing connections page: ${error.message}`);
    console.log('Taking screenshot of current page...');
    await saveScreenshot(page, 'connections-page-error', 'connections page error');
    console.log('Current URL:', page.url());
    console.log('Attempting to continue with available elements...');
  }

  const connections = await page.$$eval('.mn-connection-card', cards =>
    cards.map(card => ({
      name: card.querySelector('.mn-connection-card__name')?.innerText.trim(),
      profileUrl: card.querySelector('a.mn-connection-card__link')?.href
    }))
  );

  for (const user of pending) {
    if (connections.find(c => c.profileUrl === user.profileUrl) && !messaged.find(m => m.profileUrl === user.profileUrl)) {
      console.log(`Sending follow-up message to ${user.name}`);
      await page.goto(user.profileUrl, { waitUntil: 'networkidle2' });
      await page.click('a.message-anywhere-button');
      await page.waitForSelector('div.msg-form__contenteditable');
      await page.type('div.msg-form__contenteditable', config.follow_up_message);
      await page.click('button.msg-form__send-button');
      messaged.push(user);
      await saveJson(messagedFile, messaged);
      console.log(`✅ Follow-up message sent to ${user.name}`);
      break;
    }
  }
}

async function checkForSmsVerification(page) {
  try {
    console.log('Starting SMS verification process...');

    // click on #try-another-way
    const tryAnotherWay = await page.waitForSelector('#try-another-way', { timeout: 15000 })

    await tryAnotherWay.click()

    await page.waitForTimeout(5000)

    // Wait for the SMS code input field
    const smsInput = await page.waitForSelector('input#input__phone_verification_pin', { timeout: 15000 });
    if (!smsInput) {
      console.log('SMS verification input not found.');
      return false;
    }
    // Prompt for SMS code from the user
    const smsCode = await promptForInput('Enter the SMS verification code: ');
    await smsInput.click();
    await page.waitForTimeout(500);
    await smsInput.type(smsCode, { delay: 100 });
    console.log('SMS code entered.');

    // Locate and click the submit button
    const submitButton = await page.waitForSelector('button#two-step-submit-button', { timeout: 15000 });
    if (!submitButton) {
      console.log('Submit button not found.');
      return false;
    }
    await submitButton.click();
    console.log('Submitted SMS code, waiting for navigation...');

    const currentUrl = page.url();
    const success = !currentUrl.includes('/checkpoint/challenge/');
    console.log(`SMS verification ${success ? 'succeeded' : 'failed'}. Current URL: ${currentUrl}`);
    return success;
  } catch (error) {
    console.error(`Error during SMS verification: ${error.message}`);
    return false;
  }
}

async function checkIfLoggedIn(page) {
  try {
    // Check if we're on a LinkedIn page first
    const currentUrl = page.url();
    if (!currentUrl.includes('linkedin.com')) {
      logger.info('Not on LinkedIn domain');
      return false;
    }

    // Check for login-required pages and redirects
    const loginRelatedPaths = ['/login', '/checkpoint', '/authwall', '/uas/login'];
    if (loginRelatedPaths.some(path => currentUrl.includes(path))) {
      logger.info('On login-related page - not logged in');
      return false;
    }

    // Check cookies first
    const cookies = await page.cookies();
    const essentialCookies = ['li_at', 'JSESSIONID'];
    const missingCookies = essentialCookies.filter(name =>
      !cookies.some(cookie => cookie.name === name)
    );

    if (missingCookies.length > 0) {
      logger.info(`Missing essential cookies: ${missingCookies.join(', ')}`);
      return false;
    }

    // Most reliable indicator is the global nav
    const globalNav = await page.$('.global-nav__primary-item');
    if (globalNav) {
      logger.info('Found global nav primary item - logged in');
      return true;
    }

    // Check for feed content as backup
    const feedContent = await page.$('div.scaffold-finite-scroll__content[data-finite-scroll-hotkey-context="FEED"]');
    if (feedContent) {
      logger.info('Found feed content with FEED context - logged in');
      return true;
    }

    // Check for profile menu button which is present for logged-in users
    const profileMenu = await page.$('button.global-nav__primary-link.global-nav__primary-link-me-menu-trigger.artdeco-dropdown__trigger');
    if (profileMenu) {
      logger.info('Found profile menu - logged in');
      return true;
    }

    // If we can't find logged-in elements, check for login button
    const loginButton = await page.$('a[href*="/login"]');
    if (loginButton) {
      logger.info('Found login button - not logged in');
      return false;
    }

    // Try to access a protected page
    try {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'networkidle2',
        timeout: 80000
      });
      const feedPage = await page.$('div[data-test-id="feed-container"]');
      if (feedPage) {
        logger.info('Successfully accessed feed page - logged in');
        return true;
      }
    } catch (error) {
      logger.error(`Error accessing feed page: ${error.message}`);
    }

    logger.info('Login status unclear - assuming not logged in');
    return false;
  } catch (error) {
    logger.error(`Error checking login status: ${error.message}`);
    return false;
  }
}

async function loginWithCredentials(page, username, password) {
  try {
    // Navigate to LinkedIn login page
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'networkidle2',
      timeout: 80000
    });

    // Check for "Welcome back" single-field login
    const welcomeBackText = await page.$eval('h1, .header__content', el => el.textContent.toLowerCase().trim())
      .catch(() => '');
    const isSingleFieldLogin = welcomeBackText.includes('welcome back');

    if (isSingleFieldLogin) {
      console.log('Detected "Welcome back" single-field login...');
      // Only password field should be present
      await page.waitForSelector('#password', { timeout: 80000 });
      // Type password with random delays
      await page.type('#password', password, { delay: Math.floor(Math.random() * 100) + 50 });
    } else {
      // Standard login form with both username and password fields
      console.log('Standard login form detected...');

      // Wait for login form
      await page.waitForSelector('#username', { timeout: 80000 });
      await page.waitForSelector('#password', { timeout: 80000 });

      // Type credentials with random delays
      await page.type('#username', username, { delay: Math.floor(Math.random() * 100) + 50 });
      await page.type('#password', password, { delay: Math.floor(Math.random() * 100) + 50 });
    }

    // Click sign in and wait for navigation
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 80000 })
    ]);

    // Configure browser stealth settings
    await page.evaluateOnNewDocument(() => {
      // Overwrite navigator properties
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

      // Add missing chrome properties
      window.chrome = {
        runtime: {},
        loadTimes: function () { },
        csi: function () { },
        app: {}
      };

      // Modify permissions behavior
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    // Set a realistic user agent with random minor version
    const minorVersion = Math.floor(Math.random() * 99);
    const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.${minorVersion}.0 Safari/537.36`;
    await page.setUserAgent(userAgent);

    // Clear all cookies and cache before starting
    try {
      const client = await page.target().createCDPSession();
      await Promise.all([
        client.send('Network.clearBrowserCookies'),
        client.send('Network.clearBrowserCache'),
        // Set custom request headers
        client.send('Network.setExtraHTTPHeaders', {
          headers: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'Upgrade-Insecure-Requests': '1',
            'User-Agent': userAgent,
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1'
          }
        })
      ]);
    } catch (error) {
      logger.error('Error setting up browser session:', error);
      // Continue with login attempt even if session setup fails
    }

    console.log('Navigating to LinkedIn login page...');
    await page.goto('https://www.linkedin.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 80000
    });

    // Simulate human typing behavior for username
    console.log('Entering username...');
    for (let i = 0; i < username.length; i++) {
      const delay = Math.random() < 0.1 ?
        Math.floor(Math.random() * 1000 + 500) : // Occasional pause
        Math.floor(Math.random() * 150 + 50);   // Normal typing

      await page.type('#username', username[i], { delay: 120 });
      await page.waitForTimeout(delay);
    }

    // Natural pause between username and password
    await page.waitForTimeout(Math.floor(Math.random() * 2000 + 1000));

    console.log('Entering password...');
    for (let i = 0; i < password.length; i++) {
      const delay = Math.random() < 0.1 ?
        Math.floor(Math.random() * 1000 + 500) : // Occasional pause
        Math.floor(Math.random() * 150 + 50);   // Normal typing

      await page.type('#password', password[i], { delay: 120 });
      await page.waitForTimeout(delay);
    }

    // Natural pause after entering credentials
    await page.waitForTimeout(Math.floor(Math.random() * 3000 + 1500));

    // Click sign in button and handle navigation with fallbacks
    console.log('Clicking sign in button...');

    // Take screenshot before clicking sign in
    await saveScreenshot(page, 'before-signin-click', 'Before clicking sign in button');

    const signInButton = await page.$('button[type="submit"]');
    if (signInButton) {
      await signInButton.click();
    } else {
      // Fallback: Click on any button with text "Sign in"
      const signInButtons = await page.$$('button:has-text("Sign in")');
      if (signInButtons.length > 0) {
        await signInButtons[0].click();
      }
    }

    // Wait for navigation to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Take screenshot after sign in
    await saveScreenshot(page, 'after-signin', 'After sign in');

    // check if login email or password is incorrect
    const errorMessage = await page.$('div[data-test-id="alert-message"]');
    if (errorMessage) {
      const errorText = await errorMessage.evaluate(el => el.textContent);
      console.error(`Login error: ${errorText}`);
      await saveScreenshot(page, 'login-error', 'Login error screenshot');
      return false;
    }

    // Check if we've been redirected to a checkpoint/challenge page
    const currentUrl = page.url();
    if (currentUrl.includes('/checkpoint')) {
      // Check for puzzle captcha text
      const pageContent = await page.content();
      const hasPuzzleCaptcha = pageContent.includes("security check");

      // check for puzzle security challenge (captcha)
      const hasPuzzleSecurityChallenge = await page.$('.challenge-card');

      // Check for text indicating a security challenge
      const hasSecurityText = pageContent.toLowerCase().includes('security check');

      // Check for captcha iframe
      const hasCaptchaIframe = await page.$('iframe[src*="captcha"]');

      // Check for reCAPTCHA elements
      const hasReCaptcha = await page.$('div.g-recaptcha') || await page.$('iframe[src*="recaptcha"]');

      if (hasPuzzleSecurityChallenge || hasSecurityText || hasCaptchaIframe || hasReCaptcha) {
        console.log('Detected puzzle captcha challenge.');
        await saveScreenshot(page, 'security-challenge', 'Security challenge or captcha detected');

        await page.waitForTimeout(60000)

        console.log('Please solve the puzzle manually.');
        await saveScreenshot(page, 'puzzle-captcha', 'Puzzle captcha challenge screenshot');
        return false;
      }

      // Check if SMS verification is needed by looking for 'Enter the code' text
      const hasEnterCodeText = await page.evaluate(() => {
        return document.body.innerText.includes('Enter the code');
      });

      if (hasEnterCodeText) {
        console.log('Detected SMS verification challenge. Initiating SMS verification...');
        await checkForSmsVerification(page);
      } else {
        console.log('SMS verification challenge not detected.');
      }

      return false;
    } else {
      console.log('No checkpoint challenge detected. Continuing with normal flow...');
    }

    // Check if login was successful
    const isLoggedIn = await checkIfLoggedIn(page);
    if (!isLoggedIn) {
      console.error('Login failed!');
      await saveScreenshot(page, 'login-failed', 'Login failed screenshot');
      return false;
    }

    console.log('Login successful!');

    return true;

  } catch (error) {
    console.log(error)
    console.error(`Login error: ${error.message}`);
    await saveScreenshot(page, 'login-error', 'Login error screenshot');
    return false;
  }
}

async function useVision(page, screenshot, action = 'solve-puzzle', prompt = 'Identify where the verify button is at') {
  try {
    initOpenAI(process.env.OPENAI_API_KEY);

    let fn = ''

    switch(action) {
      case 'solve-puzzle':
        fn = await analyzePuzzleCaptcha(screenshot)
        break;

      case 'click-button':
        fn = await analyzeCaptchaBox(screenshot, prompt);
        break;
    }

    console.log('Analyzing screenshot with AI...');
    const solution = fn;
    console.log('AI Analysis:', solution);

    // Parse the AI solution
    const parsedSolution = JSON.parse(solution);

    // Get puzzle element dimensions and position
    const puzzleBounds = await puzzleElement.boundingBox();

    // Calculate absolute coordinates based on puzzle element position
    const clickX = puzzleBounds.x + parsedSolution.click_coordinates.x;
    const clickY = puzzleBounds.y + parsedSolution.click_coordinates.y;

    // Move mouse to coordinates with human-like motion
    await page.mouse.move(clickX, clickY, {
      steps: 25 // More steps = smoother motion
    });

    // Add small random delay before clicking
    await page.waitForTimeout(Math.random() * 500 + 200);

    // Click to rotate puzzle
    await page.mouse.click(clickX, clickY);

    // Wait for rotation animation
    await page.waitForTimeout(1000);

    // Save screenshot for verification
    await saveScreenshot(page, action, action);

    // Wait for navigation after solving
    await page.waitForNavigation({ timeout: 10000 }).catch(() => { });
    return true;
  } catch (error) {
    console.error('Error using AI for puzzle analysis:', error);
  }
}

async function main() {
  // Deduplicate pending and messaged profiles at startup
  console.log('Checking for duplicate profiles...');
  await deduplicateProfiles(pendingFile);
  await deduplicateProfiles(messagedFile);

  const { browser, page } = await launchBrowser();

  try {
    // Ensure login is completed before proceeding
    console.log('Starting login process...');
    let isLoggedIn = false;

    try {
      const cookies = await loadJson(cookiesFile);
      if (cookies.length > 0) {
        console.log(`Found ${cookies.length} saved cookies...`);
        await page.setCookie(...cookies);
        console.log('Cookies loaded successfully.');
      }
    } catch (error) {
      console.log(`Error loading cookies: ${error.message}`);
    }

    // Navigate to LinkedIn and check login status
    await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 0 });
    isLoggedIn = await checkIfLoggedIn(page);

    if (!isLoggedIn) {
      console.log('Not logged in. Prompting for credentials...');
      const { username, password } = await promptForCredentials();
      isLoggedIn = await loginWithCredentials(page, username, password);

      if (!isLoggedIn) {
        console.log('Login failed. Exiting...');
        return;
      }

      // Save cookies after successful login
      await saveCookies(page);
    }

    console.log('Login successful. Proceeding with other processes...');

    // Wait for the feed page to load
    await page.waitForTimeout(5000);

    // Take a screenshot to confirm login
    await saveScreenshot(page, 'linkedin-feed', 'LinkedIn feed page');

    // Now proceed with search and sending connection requests
    console.log('Navigating to search URL...');
    let searchUrl = config.search_url;
    if (!searchUrl.startsWith('http')) {
      searchUrl = 'https://' + searchUrl.replace(/^\/\//, '');
    }
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 80000 });

    console.log('Starting to send connection requests...');
    const maxConnectionRequests = 5;
    for (let i = 0; i < maxConnectionRequests; i++) {
      const sent = await sendOneConnectionRequest(page);
      if (sent) {
        await page.waitForTimeout(5000 + Math.random() * 5000);
      }
    }

    console.log('Starting to send follow-up messages...');
    const maxFollowUpMessages = 3;
    for (let i = 0; i < maxFollowUpMessages; i++) {
      await sendOneFollowUpMessage(page);
      await page.waitForTimeout(5000 + Math.random() * 5000);
    }

    console.log('All tasks completed successfully!');
  } catch (error) {
    console.error('Error in main process:', error);
    await saveScreenshot(page, 'error-screenshot', 'error');
  } finally {
    try {
      await saveCookies(page);
      console.log('Final session cookies saved.');
    } catch (error) {
      console.error('Error saving cookies:', error.message);
    }
    //await browser.close();
    console.log('Browser closed.');
  }
}

main().catch(err => {
  console.error('Fatal error in main process:', err);
  process.exit(1);
});
