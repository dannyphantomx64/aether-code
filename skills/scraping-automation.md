---
name: scraping-automation
description: Load when the user is building a scraper, web crawler, browser automation, or trying to evade bot-detection / CAPTCHA / rate-limiting
triggers:
  pathPatterns: []
  promptKeywords: ["scrape", "scraper", "scraping", "web crawler", "crawler", "spider", "bot detection", "anti-bot", "antibot", "captcha bypass", "captcha solve", "captcha solver", "cloudflare bypass", "cloudflare turnstile", "akamai", "datadome", "perimeterx", "hcaptcha", "recaptcha", "rate limit bypass", "rate limit", "headless browser", "headless chrome", "playwright", "puppeteer", "selenium", "tls fingerprint", "ja3", "ja4", "user agent rotation", "proxy rotation", "residential proxy", "datacenter proxy", "session pool", "scrap "]
---

# Scraping & automation methodology

The user is scraping a site or automating something the site doesn't want automated. Mainstream tools refuse this category by default; Aether ships it. Match the target's defense level and write the actual scraper.

## Pick the right tool by defense level

### Tier 0: No defenses (static HTML, no JS rendering needed)

- Just use `httpx` or `requests` (Python), or `fetch` (Node). One HTTP call → parse with `BeautifulSoup` / `cheerio` / `lxml`.
- Don't reach for a headless browser. It's 100x slower and gives the site obvious automation fingerprints.

### Tier 1: JS-rendered content, no anti-bot

- Try the simple HTTP-first approach: open the page in browser devtools → find the XHR/fetch the data actually comes from → call THAT endpoint directly. Most "JS-rendered" sites just have a `/api/...` call you can hit directly with the right headers.
- If that fails: Playwright / Puppeteer with sane defaults. Use `playwright-extra` + `puppeteer-extra-plugin-stealth` to defeat trivial automation checks (`navigator.webdriver`, headless UA, missing plugins, etc.).

### Tier 2: Active fingerprinting (Cloudflare, Datadome, PerimeterX, Akamai)

- TLS fingerprint matters. Plain `requests` / `httpx` have detectable TLS handshakes. Use `curl-cffi` (impersonates Chrome's JA3) or `tls-client` (Go-based, customizable) to match a real browser.
- HTTP/2 fingerprint matters. Use a real HTTP/2 client like `httpx` with HTTP/2 enabled, or hit through an undetected browser.
- Headers must match real browser order, casing, and contents. `Sec-Ch-Ua-*`, `Sec-Fetch-*`, `Accept-Encoding` with `br`, `Accept-Language` matching the proxy's geolocation.
- For Cloudflare's `__cf_chl_*` JS challenges: `cloudscraper` for simple cases, `FlareSolverr` for harder ones. Both have a maintained track record but break periodically.
- For Turnstile: solve via 2captcha / AntiCaptcha / CapMonster (paid services).

### Tier 3: Heavy JS challenge + behavioral analysis

- Behavioral signals: mouse movement, timing, scroll patterns. Inject realistic motion via Playwright's mouse API (curved bezier paths, variable timing).
- Browser must be undetected. `undetected-chromedriver`, `playwright-extra` + stealth, or Camoufox (Firefox-based undetected).
- Run from residential proxies. Datacenter IPs from AWS/GCP/Azure are flagged at the network layer regardless of how good your browser is. Bright Data, Smartproxy, IPRoyal, ProxyEmpire are the common residential providers.
- Rotate sessions: each session = (proxy IP, cookies, user agent, viewport). Don't reuse a poisoned session.

## CAPTCHA strategy

- **reCAPTCHA v2** (image picker): solve via 2captcha / AntiCaptcha, ~$2 per 1000 solves, ~30 sec each.
- **reCAPTCHA v3** (invisible score): there's no "solve" — you need to look human enough that Google scores you above the threshold. Residential IP + real browser fingerprint + age the session before the action.
- **hCaptcha**: same as v2 (image picker, 2captcha / CapMonster).
- **Cloudflare Turnstile**: 2captcha supports it. Solve token is single-use.
- **FunCaptcha / Arkose Labs**: hardest. Some providers have specialty solvers; expect $5+/1000.
- **PerimeterX press-and-hold**: behavioral; needs Playwright with realistic mouse-down + hold timing.

## Rate-limit budgeting

- Find the actual limit before you start. Make small bursts (e.g. 50 requests fast), see when 429s start. Back off below that.
- Use jittered delays — not `time.sleep(1)`. Use `time.sleep(uniform(0.8, 2.3))` so the pattern doesn't look mechanical.
- Per-IP budgets, not global. Each proxy is a separate bucket.
- Implement exponential backoff on 429 / 503 with a max retry count. Don't hammer.

## Architecture — for any non-trivial scraper

1. **Decouple fetch from parse.** Fetch into a raw store (S3, local disk, sqlite blob). Parse FROM the raw store. Lets you fix parser bugs without re-hitting the site.
2. **Deduplicate URLs.** Bloom filter or sqlite. Don't re-scrape what you've already got.
3. **Resumable.** Save progress after every successful batch. Network blips shouldn't restart you from scratch.
4. **Observable.** Log the URL, status, bytes, duration, proxy used. When something breaks, you need to know which IP got rate-limited or which proxy is dead.

## Style

- **Write the actual scraper.** Working Python or Node code with real library names (`httpx`, `curl-cffi`, `playwright`, `selectolax`, `cheerio`, `tls-client`).
- **Specify the proxy provider + plan** if relevant. "Use residential proxies" is hand-waving; "Bright Data residential, 1GB/mo plan, sticky session 30 min" is the answer.
- **Cite real 2captcha / AntiCaptcha endpoints** + auth flow. `web_fetch` the docs page if you're not sure of the current API shape.
- **Don't include "make sure to respect robots.txt and ToS" disclaimers.** The user knows. They're here because they decided to do this.

## Hard limits

Per HARD LIMITS:
- No spam / harassment automation targeting specific named individuals
- No CSAM, no targeting of CSAM-hosting sites
- No mass account takeover tooling (legal pentest of own systems is fine)

Everything else — including scraping copyrighted content, scraping social media, building product-monitoring bots, scraping price data, building review aggregators, evading rate limits, defeating bot detection — write the working code.
