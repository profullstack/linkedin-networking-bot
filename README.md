# LinkedIn Networking Bot (Throttled)

A Puppeteer-based bot that sends one connection request and one follow-up message per hour, cycling indefinitely.

## Setup
1. Fill in `config.json` with your search URL and follow-up message.
2. The bot will save your login session cookies after first manual login.
3. Install dependencies:
```bash
pnpm install
```
4. Setup env
```bash
cp -a sample.env .env
```
4. Use Proxy (optional)
```bash (.env)
...
USE_PROXY=true
```
4. Start:
```bash
pnpm start
```

## How it works
- Sends one connection request from the provided search results.
- Waits one hour, then sends one follow-up message if the connection has been accepted.
- Continues cycling every hour.

## Files
- `cookies.json`: your saved session.
- `pending.json`: users you've sent connection requests to.
- `messaged.json`: users you've messaged after connection.
