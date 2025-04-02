import fetch from 'node-fetch';
import { logger } from './logger.mjs';
import { setTimeout as wait } from 'timers/promises';
import { proxyManager } from './proxy-manager.mjs';

class CaptchaSolver {
  constructor() {
    this.apiKey = process.env.ANTICAPTCHA_API_KEY;
    this.enabled = process.env.USE_ANTICAPTCHA === 'true';
    this.maxRetries = 3;
    this.retryDelay = 2000; // 2 seconds
  }

  async solveFunCaptcha(page, pageUrl) {
    if (!this.enabled || !this.apiKey) {
      logger.info('AntiCaptcha is disabled or API key not set');
      return null;
    }

    try {
      // Find FunCaptcha public key and subdomain
      const { publicKey, subdomain } = await this.findFunCaptchaDetails(page);
      if (!publicKey) {
        logger.warn('Could not find FunCaptcha public key');
        return null;
      }

      // Get current proxy configuration
      const proxy = proxyManager.getCurrentProxy();
      if (!proxy) {
        logger.warn('No proxy available');
        return null;
      }

      // Prepare the task for AntiCaptcha
      const task = {
        type: 'FunCaptchaTask',
        websiteURL: pageUrl,
        websitePublicKey: publicKey,
        proxyType: 'http',
        proxyAddress: proxy.host,
        proxyPort: parseInt(proxy.port),
        proxyLogin: proxy.username,
        proxyPassword: proxy.password,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // Add subdomain if found
      if (subdomain) {
        task.funcaptchaApiJSSubdomain = subdomain;
      }

      // Submit task and get solution
      const token = await this.submitAndGetSolution(task);
      if (!token) {
        logger.error('Failed to get captcha solution');
        return null;
      }

      // Apply the solution
      await this.applyFunCaptchaSolution(page, token);
      return token;
    } catch (error) {
      logger.error('Error solving FunCaptcha:', error);
      return null;
    }
  }

  async findFunCaptchaDetails(page) {
    try {
      const details = await page.evaluate(() => {
        // Look for the script tag with arkoselabs URL
        const scripts = Array.from(document.getElementsByTagName('script'));
        let subdomain = null;
        let publicKey = null;

        for (const script of scripts) {
          const src = script.src;
          if (src && src.includes('arkoselabs.com')) {
            // https://client-api.arkoselabs.com/fc/gt2/public_key/3117BF26-4762-4F5A-8ED9-A85E69209A46
            const match = src.match(/https:\/\/([^/]+)\.arkoselabs\.com\/fc\/gt2\/public_key\/([^/]+)\//);
            if (match) {
              subdomain = match[1];
              publicKey = match[2];
              break;
            }
          }
        }

        // Fallback to data attributes if script not found
        if (!publicKey) {
          const fcDiv = document.querySelector('div[data-pkey]');
          if (fcDiv) {
            publicKey = fcDiv.getAttribute('data-pkey');
          }
        }

        return { publicKey, subdomain };
      });

      if (details.publicKey) {
        logger.info(`Found FunCaptcha details - Key: ${details.publicKey}, Subdomain: ${details.subdomain || 'default'}`);
      }

      return details;
    } catch (error) {
      logger.error('Error finding FunCaptcha details:', error);
      return { publicKey: null, subdomain: null };
    }
  }

  async submitAndGetSolution(task) {
    try {
      // Create task
      const createTaskResponse = await fetch('https://api.anti-captcha.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: this.apiKey,
          task: task
        })
      });

      const createTaskResult = await createTaskResponse.json();
      if (!createTaskResult.taskId) {
        logger.error('Failed to create task:', createTaskResult.errorDescription || 'Unknown error');
        return null;
      }

      // Get task result
      const taskId = createTaskResult.taskId;
      let attempts = 0;
      const maxAttempts = 30; // 5 minutes total (10s * 30)

      while (attempts < maxAttempts) {
        await wait(10000); // Wait 10 seconds between checks

        const getTaskResponse = await fetch('https://api.anti-captcha.com/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: this.apiKey,
            taskId: taskId
          })
        });

        const taskResult = await getTaskResponse.json();

        if (taskResult.status === 'ready') {
          logger.info('Captcha solved successfully');
          return taskResult.solution.token;
        } else if (taskResult.status === 'processing') {
          logger.debug(`Waiting for solution, attempt ${attempts + 1}/${maxAttempts}`);
        } else {
          logger.error('Task failed:', taskResult.errorDescription || 'Unknown error');
          return null;
        }

        attempts++;
      }

      logger.error('Captcha solution timeout');
      return null;
    } catch (error) {
      logger.error('Error in submitAndGetSolution:', error);
      return null;
    }
  }

  async applyFunCaptchaSolution(page, token) {
    try {
      await page.evaluate((token) => {
        // Try to find the token input field
        const tokenInput = document.querySelector('input[name="fc-token"], input[name="arkose-token"]');
        if (tokenInput) {
          tokenInput.value = token;
          // Dispatch change event
          const event = new Event('change', { bubbles: true });
          tokenInput.dispatchEvent(event);
        }

        // Set token in window object (some implementations use this)
        window.arkoseToken = token;
      }, token);

      logger.info('Applied FunCaptcha solution');
    } catch (error) {
      logger.error('Error applying FunCaptcha solution:', error);
    }
  }
}

export const captchaSolver = new CaptchaSolver();