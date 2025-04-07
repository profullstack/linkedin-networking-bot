import { logger } from './logger.mjs';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';


import dotenv from 'dotenv'
import { fileURLToPath } from 'url';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

class ProxyManager {
  constructor() {
    this.proxyList = [];
    this.currentProxyIndex = -1;
    this.lastRotation = null;
    this.proxyScores = new Map(); // Track reliability of each proxy
    this.validationTimeout = 5000; // 5 seconds timeout for proxy validation
    this.maxRetries = 3;
    this.blacklistedProxies = new Set();
    this.lastProxyTest = new Map(); // Track when each proxy was last tested
    this.proxyTestInterval = 1800000; // 30 minutes
    this.proxyApiUrl = 'https://proxy.webshare.io/api/v2/proxy/list/';
    this.proxyApiToken = process.env.WEBSHARE_API_TOKEN;
    this.proxyListPath = process.env.PROXY_LIST_PATH;
    this.currentProxy = null;
  }

  async fetchProxiesFromApi() {
    try {
      const url = new URL(this.proxyApiUrl);
      url.searchParams.append('mode', 'direct');
      url.searchParams.append('page', '1');
      url.searchParams.append('page_size', '25');

      const response = await fetch(url.href, {
        method: 'GET',
        headers: {
          'Authorization': `Token ${this.proxyApiToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data.results || [];
    } catch (error) {
      logger.error('Error fetching proxies:', error);
      return [];
    }
  }

  async fetchProxiesFromFile() {
    try {
      if (!this.proxyListPath) {
        logger.warn('No proxy list file path specified');
        return [];
      }

      const content = await fs.readFile(this.proxyListPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      return lines.map(line => {
        const [host, port, username, password] = line.split(':');
        return { proxy_address: host, port, username, password };
      });
    } catch (error) {
      logger.error('Error reading proxy list file:', error);
      return [];
    }
  }

  async fetchProxies() {
    // If API token is provided, try API first
    if (this.proxyApiToken) {
      const apiProxies = await this.fetchProxiesFromApi();
      if (apiProxies.length > 0) {
        return apiProxies;
      }
    }

    // Fallback to file or if no API token provided
    return this.fetchProxiesFromFile();
  }

  async loadProxies(proxies) {
    this.proxyList = proxies.filter(proxy => !this.blacklistedProxies.has(proxy.proxy_address));
    
    // Initialize scores for new proxies
    for (const proxy of this.proxyList) {
      const proxyId = proxy.proxy_address;
      if (!this.proxyScores.has(proxyId)) {
        this.proxyScores.set(proxyId, 1.0); // Initial score
      }
    }
    
    logger.info(`Loaded ${this.proxyList.length} proxies (${proxies.length - this.proxyList.length} blacklisted)`);
    
    // Validate proxies in background
    this.validateProxies().catch(err => {
      logger.error('Error validating proxies:', err);
    });
  }

  async markProxySuccess(proxy) {
    if (!proxy) return;
    
    const currentScore = this.proxyScores.get(proxy) || 1.0;
    this.proxyScores.set(proxy, Math.min(1.0, currentScore + 0.1));
    logger.debug(`Proxy success: ${proxy.proxy_address}:${proxy.port} (score: ${this.proxyScores.get(proxy.proxy_address).toFixed(2)})`);
  }

  markProxyFailure(proxy) {
    if (!proxy) return;
    
    const currentScore = this.proxyScores.get(proxy) || 1.0;
    this.proxyScores.set(proxy, Math.max(0, currentScore - 0.2));
    
    // If score is too low, remove proxy
    if (this.proxyScores.get(proxy) <= 0.2) {
      this.blacklistedProxies.add(proxy);
      this.proxyList = this.proxyList.filter(p => p !== proxy);
      logger.warn(`Removed unreliable proxy: ${proxy.proxy_address}:${proxy.port}`);
    } else {
      logger.warn(`Proxy failure: ${proxy.proxy_address}:${proxy.port} (score: ${this.proxyScores.get(proxy.proxy_address).toFixed(2)})`);
    }
  }

  async validateProxy(proxy) {
    const proxyId = proxy.proxy_address;
    if (Date.now() - (this.lastProxyTest.get(proxyId) || 0) < this.proxyTestInterval) {
      return true; // Skip validation if tested recently
    }

    // Validate proxy object structure
    if (!proxy.proxy_address || !proxy.port || !proxy.username || !proxy.password) {
      logger.error('Invalid proxy object structure:', proxy);
      return false;
    }

    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.proxy_address}:${proxy.port}`;
    
    return new Promise((resolve) => {
      const request = https.get({
        host: 'www.linkedin.com',
        path: '/robots.txt',
        timeout: this.validationTimeout,
        proxy: proxyUrl,
        agent: new https.Agent({
          keepAlive: true,
          timeout: this.validationTimeout,
          rejectUnauthorized: false
        })
      });
      
      const timer = setTimeout(() => {
        request.destroy();
        resolve(false);
      }, this.validationTimeout);
      
      request.on('response', (response) => {
        clearTimeout(timer);
        this.lastProxyTest.set(proxy.proxy_address, Date.now());
        resolve(response.statusCode === 200);
      });
      
      request.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  async validateProxies() {
    const validationResults = await Promise.all(
      this.proxyList.map(async (proxy) => {
        const isValid = await this.validateProxy(proxy);
        if (!isValid) {
          this.proxyScores.set(proxy, Math.max(0, this.proxyScores.get(proxy) - 0.2));
          logger.warn(`Proxy validation failed: ${proxy.proxy_address}:${proxy.port}`);
        } else {
          this.proxyScores.set(proxy, Math.min(1, this.proxyScores.get(proxy) + 0.1));
          logger.info(`Proxy validation successful: ${proxy.proxy_address}:${proxy.port}`);
        }
        return isValid;
      })
    );
    
    // Remove consistently failing proxies
    this.proxyList = this.proxyList.filter((proxy, index) => {
      if (this.proxyScores.get(proxy) <= 0.2) {
        this.blacklistedProxies.add(proxy);
        logger.warn(`Blacklisting unreliable proxy: ${proxy.proxy_address}:${proxy.port}`);
        return false;
      }
      return true;
    });
    
    return validationResults.filter(Boolean).length;
  }

  async getNextProxy() {
    if (this.proxyList.length === 0) {
      return null;
    }

    // Sort proxies by score
    const sortedProxies = [...this.proxyList].sort((a, b) => 
      this.proxyScores.get(b.proxy_address) - this.proxyScores.get(a.proxy_address)
    );

    // Select from top 3 proxies with some randomization
    const topProxies = sortedProxies.slice(0, Math.min(3, sortedProxies.length));
    const selectedProxy = topProxies[Math.floor(Math.random() * topProxies.length)];
    
    // Validate the selected proxy
    let retries = 0;
    while (retries < this.maxRetries) {
      if (await this.validateProxy(selectedProxy)) {
        this.lastRotation = Date.now();
        logger.info(`Rotating to proxy: ${selectedProxy.proxy_address}:${selectedProxy.port} (score: ${this.proxyScores.get(selectedProxy.proxy_address).toFixed(2)})`);
        return selectedProxy;
      }
      retries++;
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between retries
    }
    
    // If validation fails, remove proxy and try next best
    this.proxyScores.set(selectedProxy.proxy_address, 0);
    logger.warn(`Proxy validation failed after ${this.maxRetries} retries: ${selectedProxy.proxy_address}:${selectedProxy.port}`);
    return this.getNextProxy();
  }

  async getRandomProxy() {
    try {
      const proxies = await this.fetchProxies();
      
      if (proxies.length === 0) {
        logger.warn('No proxies available');
        return null;
      }

      await this.loadProxies(proxies);

      const proxy = await this.getNextProxy();
      
      if (proxy) {
        this.currentProxy = {
          host: proxy.proxy_address,
          port: parseInt(proxy.port, 10),
          username: proxy.username,
          password: proxy.password
        };
        logger.info(`Selected proxy: ${this.currentProxy.host}:${this.currentProxy.port}`);
      }
      
      return this.currentProxy;
    } catch (error) {
      logger.error('Error getting random proxy:', error);
      return null;
    }
  }

  getCurrentProxy() {
    return this.currentProxy;
  }
}

export const proxyManager = new ProxyManager();