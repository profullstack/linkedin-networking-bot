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
import { withRetry, setupPageErrorHandlers } from './error-handler.mjs';

// Load environment variables from .env file
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = JSON.parse(await fs.readFile(path.join(__dirname, '../config.json')));

const pendingFile = path.join(__dirname, '../pending.json');
const messagedFile = path.join(__dirname, '../messaged.json');
const cookiesFile = path.join(__dirname, '../cookies.json');
const logsDir = path.join(__dirname, '../logs');

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
  const browser = await puppeteer.launch({ 
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
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
  page.setDefaultTimeout(60000);
  
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
        console.log(`Skipping expired cookie: ${cookie.name}`);
        return false;
      }
      
      // Ensure essential properties exist
      if (!cookie.name || !cookie.value) {
        console.log(`Skipping invalid cookie: ${JSON.stringify(cookie)}`);
        return false;
      }
      
      // Keep only linkedin.com related cookies
      if (!cookie.domain.includes('linkedin.com')) {
        console.log(`Skipping non-LinkedIn cookie: ${cookie.name}`);
        return false;
      }
      
      return true;
    });
    
    if (validCookies.length === 0) {
      throw new Error('No valid cookies found');
    }
    
    // Save filtered cookies
    await saveJson(cookiesFile, validCookies);
    console.log(`Saved ${validCookies.length} valid cookies`);
    return true;
  } catch (error) {
    console.error(`Error saving cookies: ${error.message}`);
    return false;
  }
}

async function sendOneConnectionRequest(page) {
  console.log('Processing search results to find connection opportunities...');
  
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
    await page.waitForSelector('.mn-connection-card', { timeout: 30000 });
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
    console.log('Checking for SMS verification...');
    
    // Check if we're on a verification page
    const isVerificationPage = await page.evaluate(() => {
      const pageText = document.body.innerText.toLowerCase();
      
      // Log the entire page text for debugging
      console.log('Page text for verification detection:', pageText);
      
      const isVerify = pageText.includes('verification') || 
             pageText.includes('verify') || 
             pageText.includes('security check') || 
             pageText.includes('confirm') ||
             pageText.includes('two-step') ||
             pageText.includes('2-step') ||
             pageText.includes('two step') ||
             pageText.includes('2 step');
             
      console.log(`Is verification page detected: ${isVerify}`);
      return isVerify;
    });
    
    if (isVerificationPage) {
      console.log('Detected verification page. Taking screenshot...');
      await saveScreenshot(page, 'verification-page', 'verification page');
      
      // Log all buttons on the page for debugging
      await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button'));
        console.log(`Found ${allButtons.length} buttons on verification page`);
        allButtons.forEach((btn, i) => {
          console.log(`Button ${i}: ${btn.innerText || btn.textContent || 'No text'} - ${btn.getAttribute('id') || 'No ID'} - ${btn.getAttribute('class') || 'No class'}`);
        });
        
        // Dump the entire HTML for debugging
        // console.log('HTML dump of verification page:');
        //console.log(document.body.innerHTML);
      });
      
      // Set a timeout to prevent hanging indefinitely
      const verificationTimeout = setTimeout(() => {
        console.log('TIMEOUT: Verification page is taking too long. Proceeding with manual intervention prompt...');
        // This will be caught by the try/catch and allow the function to continue
        throw new Error('Verification timeout');
      }, 30000); // 30 second timeout
      
      // Try a direct approach to find and click the 'Verify using SMS' button
      console.log('Attempting direct click on "Verify using SMS" button...');
      
      // First, try direct JavaScript execution to find and click the button
      let directClickResult = await page.evaluate(() => {
        // Try multiple approaches to find the button
        
        // 1. Try exact text match (case insensitive)
        const buttonsByText = Array.from(document.querySelectorAll('button, a'));
        for (const btn of buttonsByText) {
          const text = (btn.innerText || btn.textContent || '').trim();
          console.log(`Checking button: "${text}"`);
          
          if (text.toLowerCase() === 'verify using sms') {
            console.log('Found exact match for "Verify using SMS"');
            btn.click();
            return { clicked: true, method: 'exact text match', text };
          }
        }
        
        // 2. Try contains match
        for (const btn of buttonsByText) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (text.includes('verify') && text.includes('sms')) {
            console.log(`Found partial match: "${text}"`);
            btn.click();
            return { clicked: true, method: 'partial text match', text };
          }
        }
        
        // 3. Try by class or ID patterns that might indicate a verification button
        const verifyButtons = document.querySelectorAll('[class*="verify"], [id*="verify"], [class*="sms"], [id*="sms"]');
        if (verifyButtons.length > 0) {
          console.log(`Found ${verifyButtons.length} buttons with verify/sms in class/id`);
          verifyButtons[0].click();
          return { clicked: true, method: 'class/id match', text: verifyButtons[0].innerText };
        }
        
        // Log all buttons for debugging
        const allButtons = Array.from(document.querySelectorAll('button'));
        console.log(`Found ${allButtons.length} total buttons on page`);
        allButtons.forEach((btn, i) => {
          const btnText = btn.innerText || btn.textContent || 'No text';
          console.log(`Button ${i}: "${btnText}" - id: ${btn.id || 'none'} - class: ${btn.className || 'none'}`);
        });
        
        return { clicked: false };
      });
      
      console.log('Direct click result:', directClickResult);
      let smsButtonFound = directClickResult.clicked;
      
      // If direct click didn't work, try with Puppeteer's built-in methods
      if (!smsButtonFound) {
        try {
          // Try to find button by text content
          await page.waitForFunction(
            'document.querySelector("button, a") && Array.from(document.querySelectorAll("button, a")).some(el => el.innerText.includes("Verify") && el.innerText.includes("SMS"))',
            { timeout: 5000 }
          );
          
          // Click the button
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            const smsButton = buttons.find(el => el.innerText.includes('Verify') && el.innerText.includes('SMS'));
            if (smsButton) {
              console.log(`Clicking button with text: ${smsButton.innerText}`);
              smsButton.click();
              return true;
            }
            return false;
          });
          
          console.log('Clicked SMS button using waitForFunction approach');
          smsButtonFound = true;
        } catch (error) {
          console.log(`Error with waitForFunction approach: ${error.message}`);
        }
      }
      
      // If direct methods didn't work, try with explicit selectors
      if (!smsButtonFound) {
        // Look for SMS verification button with various possible selectors
        const smsButtonSelectors = [
          'button:has-text("Verify using SMS")',  // Exact match for the button we need
          'button:has-text("verify using sms")',  // Case insensitive version
          'button:has-text("Verify with SMS")',
          'button[data-id="verification-code-button"]',
          'button:has-text("SMS")',
          'button:has-text("Text")',
          'button:has-text("Mobile")',
          'button:has-text("Phone")',
          'button[aria-label*="SMS"]',
          'button[aria-label*="Text"]',
          'a:has-text("Verify using SMS")',
          'a:has-text("SMS")',
          'a:has-text("Text")',
          'a[aria-label*="SMS"]',
          'a[aria-label*="Text"]',
          'button',  // Last resort: try all buttons and check their text
        ];
        
        for (const selector of smsButtonSelectors) {
          try {
            // For the generic 'button' selector, we need to check each button's text
            if (selector === 'button') {
              const buttons = await page.$$('button');
              for (let i = 0; i < buttons.length; i++) {
                const buttonText = await page.evaluate(el => el.innerText.toLowerCase(), buttons[i]);
                
                // Prioritize exact match for 'Verify using SMS'
                if (buttonText.includes('verify using sms')) {
                  console.log(`Found exact match for 'Verify using SMS' button: ${buttonText}`);
                  await buttons[i].click();
                  smsButtonFound = true;
                  break;
                }
                
                // Then check for other SMS-related text
                if (buttonText.includes('sms') || buttonText.includes('text') || buttonText.includes('phone')) {
                  console.log(`Found SMS button with text: ${buttonText}`);
                  await buttons[i].click();
                  smsButtonFound = true;
                  break;
                }
              }
              if (smsButtonFound) break;
            } else {
              const smsButton = await page.$(selector);
              if (smsButton) {
                const buttonText = await page.evaluate(el => el.innerText, smsButton);
                console.log(`Found SMS verification button with selector: ${selector}, text: ${buttonText}`);
                await smsButton.click();
                console.log('Clicked SMS verification button');
                smsButtonFound = true;
                break;
              }
            }
          } catch (error) {
            console.log(`Error with SMS button selector ${selector}: ${error.message}`);
          }
        }
      }
      
      // Clear the timeout since we're proceeding
      clearTimeout(verificationTimeout);
      
      if (!smsButtonFound) {
        console.log('Could not automatically find the SMS verification button.');
        console.log('Taking a screenshot to help with manual intervention...');
        await saveScreenshot(page, 'manual-intervention', 'manual intervention');
        
        // Ask user for manual intervention
        const proceed = await promptForInput('SMS button not found. Please manually click the "Verify using SMS" button in the browser, then type "done" here to continue: ');
        
        if (proceed.toLowerCase() === 'done') {
          console.log('User has manually clicked the SMS button. Proceeding...');
          smsButtonFound = true;
        } else {
          console.log('User did not confirm manual intervention. Aborting verification.');
          return false;
        }
      }
      
      if (smsButtonFound) {
        // Wait a bit after clicking the SMS button
        await page.waitForTimeout(3000);
        
        // Take screenshot after clicking SMS button
        await saveScreenshot(page, 'sms-verification', 'SMS verification');
        
        // Prompt user to enter SMS code
        const smsCode = await promptForInput('Enter the SMS verification code you received: ');
        console.log(`Received SMS code: ${smsCode}`);
        
        // Find and fill the SMS code input field
        const smsInputSelectors = [
          'input[name="pin"]',
          'input[id="input__phone_verification_pin"]',
          'input[id="verification-code"]',
          'input[name="verification-code"]',
          'input[placeholder*="code"]',
          'input[placeholder*="verification"]',
          'input[type="text"]',
          'input[type="tel"]',
          'input[inputmode="numeric"]'
        ];
        
        let smsInputFound = false;
        
        for (const selector of smsInputSelectors) {
          try {
            const smsInput = await page.$(selector);
            if (smsInput) {
              console.log(`Found SMS input field with selector: ${selector}`);
              await smsInput.click();
              await page.waitForTimeout(500);
              await smsInput.type(smsCode);
              console.log('Entered SMS code');
              smsInputFound = true;
              break;
            }
          } catch (error) {
            console.log(`Error with SMS input selector ${selector}: ${error.message}`);
          }
        }
        
        if (smsInputFound) {
          // Find and click the submit button
          const submitButtonSelectors = [
            'button[type="submit"]',
            'button:has-text("Submit")',
            'button:has-text("Verify")',
            'button:has-text("Continue")',
            'button.primary',
            'button.submit',
            'button.verification-button'
          ];
          
          for (const selector of submitButtonSelectors) {
            try {
              const submitButton = await page.$(selector);
              if (submitButton) {
                console.log(`Found submit button with selector: ${selector}`);
                await submitButton.click();
                console.log('Submitted SMS code');
                
                // Wait for verification to complete
                await page.waitForTimeout(5000);
                break;
              }
            } catch (error) {
              console.log(`Error with submit button selector ${selector}: ${error.message}`);
            }
          }
        } else {
          console.log('Could not find SMS input field. You may need to enter the code manually.');
        }
      } else {
        console.log('Could not find SMS verification button. You may need to verify manually.');
        console.log('Waiting for 60 seconds for manual verification...');
        await page.waitForTimeout(60000); // Wait for 1 minute
      }
      
      // Take another screenshot after verification attempt
      await saveScreenshot(page, 'after-verification', 'after verification attempt');
    }
  } catch (error) {
    console.error(`Error checking for SMS verification: ${error.message}`);
  }
}

async function checkIfLoggedIn(page) {
  try {
    // Check if we're on a LinkedIn page first
    const currentUrl = page.url();
    if (!currentUrl.includes('linkedin.com')) {
      console.log('Not on LinkedIn domain');
      return false;
    }

    // Check for login-required pages and redirects
    const loginRelatedPaths = ['/login', '/checkpoint', '/authwall', '/uas/login'];
    if (loginRelatedPaths.some(path => currentUrl.includes(path))) {
      console.log('On login-related page - not logged in');
      return false;
    }

    // Check if we were redirected from login page
    const redirectHistory = await page.evaluate(() => {
      return performance.getEntriesByType('navigation')[0]?.redirectCount > 0;
    });

    // Most reliable indicator is the global nav
    const globalNav = await page.$('.global-nav__primary-item');
    if (globalNav) {
      console.log('Found global nav primary item - logged in');
      return true;
    }

    // Check for feed content as backup
    const feedContent = await page.$('div.scaffold-finite-scroll__content[data-finite-scroll-hotkey-context="FEED"]');
    if (feedContent) {
      console.log('Found feed content with FEED context - logged in');
      return true;
    }

    // Check for profile menu button which is present for logged-in users
    const profileMenu = await page.$('button.global-nav__primary-link.global-nav__primary-link-me-menu-trigger.artdeco-dropdown__trigger');
    if (profileMenu) {
      console.log('Found profile menu - logged in');
      return true;
    }

    // If we can't find logged-in elements, check for login button
    const loginButton = await page.$('a[href*="/login"]');
    if (loginButton) {
      console.log('Found login button - not logged in');
      return false;
    }

    // If we were redirected and can't find login elements, likely logged in
    if (redirectHistory) {
      console.log('Detected redirect from login page - likely logged in');
      return true;
    }

    console.log('Login status unclear - assuming not logged in');
    return false;
  } catch (error) {
    console.error(`Error checking login status: ${error.message}`);
    return false;
  }
}

async function loginWithCredentials(page, username, password) {
  try {
    // Configure browser stealth settings
    await page.evaluateOnNewDocument(() => {
      // Overwrite navigator properties
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      
      // Add missing chrome properties
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
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
      timeout: 30000 
    });
    
    // Simulate human typing behavior for username
    console.log('Entering username...');
    for (let i = 0; i < username.length; i++) {
        const delay = Math.random() < 0.1 ? 
            Math.floor(Math.random() * 1000 + 500) : // Occasional pause
            Math.floor(Math.random() * 150 + 50);   // Normal typing

        await page.type('#username', username[i], {delay: 120});
        await page.waitForTimeout(delay);
    }

    // Natural pause between username and password
    await page.waitForTimeout(Math.floor(Math.random() * 2000 + 1000));

    console.log('Entering password...');
    for (let i = 0; i < password.length; i++) {
        const delay = Math.random() < 0.1 ? 
            Math.floor(Math.random() * 1000 + 500) : // Occasional pause
            Math.floor(Math.random() * 150 + 50);   // Normal typing

        await page.type('#password', password[i], {delay: 120});
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
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

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

    // Check if login was successful
    const isLoggedIn = await checkIfLoggedIn(page);
    if (!isLoggedIn) {
      console.error('Login failed!');
      await saveScreenshot(page, 'login-failed', 'Login failed screenshot');
      return false;
    }

    console.log('Login successful!');

    checkForSmsVerification(page)
    
    return true;
    
  } catch (error) {
    console.log(error)
    console.error(`Login error: ${error.message}`);
    await saveScreenshot(page, 'login-error', 'Login error screenshot');
    return false;
  }
}

async function main() {
  // Deduplicate pending and messaged profiles at startup
  console.log('Checking for duplicate profiles...');
  await deduplicateProfiles(pendingFile);
  await deduplicateProfiles(messagedFile);
  
  const { browser, page } = await launchBrowser();
  
  try {
    // Try to load cookies with improved filtering
    try {
      const cookies = await loadJson(cookiesFile);
      if (cookies.length > 0) {
        console.log(`Found ${cookies.length} saved cookies...`);
        
        // Filter out potentially problematic cookies
        const filteredCookies = cookies.filter(cookie => {
          // Remove cookies with very short expiration or session cookies
          const hasValidExpiration = cookie.expires && (cookie.expires > Date.now() / 1000);
          
          // Keep essential auth cookies and remove tracking/analytics cookies
          const isEssentialCookie = cookie.name.includes('li_at') || 
                                   cookie.name.includes('JSESSIONID') || 
                                   cookie.name.includes('lidc') || 
                                   cookie.name.includes('bcookie') || 
                                   cookie.name.includes('bscookie');
          
          return hasValidExpiration && isEssentialCookie;
        });
        
        console.log(`Filtered cookies: ${filteredCookies.length} of ${cookies.length} cookies kept`);
        
        if (filteredCookies.length > 0) {
          await page.setCookie(...filteredCookies);
          console.log('Essential cookies loaded successfully');
        } else {
          console.log('No essential cookies found after filtering');
        }
      }
    } catch (error) {
      console.log(`Error loading cookies: ${error.message}`);
    }
    
    // Navigate to LinkedIn and check if already logged in
    console.log('Navigating to LinkedIn...');
    // Use a more reliable waitUntil condition and shorter timeout
    await page.goto('https://www.linkedin.com', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    }).catch(error => {
      console.log(`Initial navigation error (non-fatal): ${error.message}`);
    });
    
    let isLoggedIn = await checkIfLoggedIn(page);
    
    // If not logged in, prompt for credentials
    if (!isLoggedIn) {
      console.log('Not logged in. Prompting for credentials...');
      const { username, password } = await promptForCredentials();
      isLoggedIn = await loginWithCredentials(page, username, password);
      
      if (!isLoggedIn) {
        console.log('Login failed. Exiting...');
        await browser.close();
        return;
      }
      
      // Save cookies after successful login
      await saveCookies(page);
    }

    // Wait for the feed page to load
    await page.waitForTimeout(5000);
    
    // Take a screenshot to see where we are
    await saveScreenshot(page, 'linkedin-feed', 'LinkedIn feed page');

    // Now try to navigate directly to the search URL
    console.log('Navigating to search URL...');
    
    // Validate and ensure the search URL is properly formatted
    let searchUrl = config.search_url;
    if (!searchUrl.startsWith('http')) {
      console.log('Search URL does not have proper scheme, adding https://');
      // Remove leading slashes if present
      if (searchUrl.startsWith('//')) {
        searchUrl = searchUrl.substring(2);
      }
      searchUrl = 'https://' + searchUrl;
    }
    console.log(`Using validated search URL: ${searchUrl}`);
    
    // Wait 10 seconds after login as requested by the user
    console.log('Waiting 10 seconds after login before navigating to search URL...');
    await page.waitForTimeout(10000);
    
    // Take a screenshot before navigation
    await saveScreenshot(page, 'before-search-navigation', 'Before search navigation');
    
    // Direct navigation to search URL - simplest approach as per user preference
    console.log(`Directly navigating to search URL: ${searchUrl}`);
    // Reset currentUrl for navigation phase
    let currentUrl = '';
    
    try {
      // Use networkidle2 for more reliable page loading
      console.log(`Navigating to: ${searchUrl}`);
      //await page.goto(searchUrl);

      // Open a new tab and navigate to the link
      const newPage = await browser.newPage();
      await newPage.goto(searchUrl, { waitUntil: 'networkidle2' });
      
      currentUrl = newPage.url();
      console.log(`Current URL after navigation: ${currentUrl}`);
      
    } catch (error) {
      console.error(`Error navigating to search URL: ${error.message}`);
      await saveScreenshot(page, 'search-navigation-error', 'Search navigation error');
    }
    
    // Take a screenshot after navigation
    await saveScreenshot(page, 'after-search-navigation', 'After search navigation');

    page.waitForTimeout(10000);

    // Send connection requests
    console.log('Starting to send connection requests...');
    const maxConnectionRequests = 5;
    let connectionsSent = 0;
    
    while (connectionsSent < maxConnectionRequests) {
      console.log(`Sending connection request ${connectionsSent + 1} of ${maxConnectionRequests}...`);
      // Use a modified version of sendOneConnectionRequest that skips navigation
      const sent = await sendOneConnectionRequest(newPage);
      
      if (sent) {
        connectionsSent++;
        console.log(`Connection request ${connectionsSent} sent. Waiting before next request...`);
        await page.waitForTimeout(5000 + Math.random() * 5000); // Random wait between 5-10 seconds
      } else {
        console.log('Failed to send connection request. Trying again...');
        await page.waitForTimeout(3000);
      }
    }
    
    // Send follow-up messages
    console.log('Starting to send follow-up messages...');
    const maxFollowUpMessages = 3;
    let messagesSent = 0;
    
    while (messagesSent < maxFollowUpMessages) {
      console.log(`Sending follow-up message ${messagesSent + 1} of ${maxFollowUpMessages}...`);
      await sendOneFollowUpMessage(page);
      messagesSent++;
      await page.waitForTimeout(5000 + Math.random() * 5000); // Random wait between 5-10 seconds
    }
    
    console.log('All tasks completed successfully!');
  } catch (error) {
    console.error('Error in main process:');
    console.error(error);
    
    // Take a screenshot for debugging
    try {
      await saveScreenshot(page, 'error-screenshot', 'error');
    } catch (screenshotError) {
      console.error('Failed to take error screenshot:', screenshotError.message);
    }
  } finally {
    // Save cookies before closing browser
    try {
      await saveCookies(page);
      console.log('Final session cookies saved');
    } catch (error) {
      console.error('Error saving cookies:', error.message);
    }
    
    // Close the browser
    await browser.close();
    console.log('Browser closed');
  }
}

main().catch(err => {
  console.error('Fatal error in main process:');
  console.error(err);
  process.exit(1);
});
