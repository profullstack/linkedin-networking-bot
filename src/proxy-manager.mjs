import { logger } from './logger.mjs';
import fs from 'fs/promises';
import path from 'path';

import dotenv from 'dotenv'
import { fileURLToPath } from 'url';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

class ProxyManager {
  constructor() {
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

  async getRandomProxy() {
    try {
      const proxies = await this.fetchProxies();
      
      if (proxies.length === 0) {
        logger.warn('No proxies available');
        return null;
      }

      // Select a random proxy from the list
      const proxy = proxies[Math.floor(Math.random() * proxies.length)];
      
      this.currentProxy = {
        host: proxy.proxy_address,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
      };

      logger.info(`Selected proxy: ${this.currentProxy.host}:${this.currentProxy.port}`);
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