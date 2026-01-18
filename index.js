'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Render zawsze podstawia PORT w env — ta linia musi być:
const PORT = process.env.PORT || 3000;

const LOGIN_URL = 'https://user.callcontact.eu/';

async function safeClosePage(page) {
  try { await page.close(); } catch (_) {}
}

async function safeCloseBrowser(browser) {
  try { await browser.close(); } catch (_) {}
}

async function waitAndClick(page, selector, { timeout = 20000 } = {}) {
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
}

async function clearAndType(page, selector, value, { timeout = 20000, delay = 25 } = {}) {
  await page.waitForSelector(selector, { timeout });
  await page.focus(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay });
}

async function loginCallContact({ email, password, totp_code, since_minutes = 15 }) {
  let browser = null;
  let page = null;

  try {
    if (!email || !password || !totp_code) {
      throw new Error('Brakuje wymaganych pól: email, password, totp_code');
    }
    if (typeof totp_code !== 'string' || totp_code.length !== 6) {
      throw new Error('totp_code musi być stringiem o długości 6, np. "123456"');
    }

    console.log('[1] Launch browser');
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    page = await browser.newPage();

    // UA jak w Twoim pierwotnym kodzie
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);

    page.on('console', (msg) => console.log('[page console]', msg.text()));
    page.on('pageerror', (err) => console.log('[page error]', err?.message || err));

    console.log('[2] Open login page');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // Klik "Zaloguj się" -> czekamy aż pojawi się pole email
    console.log('[3] Click "Zaloguj się"');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      waitAndClick(page, 'button.LoginRegisterView__column__button', { timeout: 25000 }),
    ]);

    console.log('[4] Wait for email input and type email');
    await clearAndType(page, 'input[placeholder="Adres email"]', email, { timeout: 25000, delay: 25 });

    console.log('[5] Type password');
    // 1) najpierw placeholder "8 znaków", 2) fallback na type=password
    const passwordPreferred = 'input[placeholder*="8 znaków"]';
    const passwordFallback = 'input[type="password"]';

    const preferredHandle = await page.$(passwordPreferred);
    if (preferredHandle) {
      await clearAndType(page, passwordPreferred, password, { timeout: 20000, delay: 25 });
    } else {
      const fallbackHandle = await page.$(passwordFallback);
      if (!fallbackHandle) {
        throw new Error('Nie znaleziono pola hasła (brak placeholder "8 znaków" i brak input[type="password"])');
      }
      await clearAndType(page, passwordFallback, password, { timeout: 20000, delay: 25 });
    }

    console.log('[6] Submit login form (first primary button)');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      waitAndClick(page, 'button.el-button--primary', { timeout: 20000 }),
    ]);

    console.log('[7] Wait for 2FA inputs');
    await page.waitForSelector('input.digit', { timeout: 25000 });

    const digitInputs = await page.$$('input.digit');
    if (digitInputs.length !== 6) {
      throw new Error(`Oczekiwano 6 pól 2FA (input.digit), znaleziono: ${digitInputs.length}`);
    }

    console.log('[8] Fill 2FA code into 6 inputs');
    for (let i = 0; i < 6; i++) {
      await digitInputs[i].click({ clickCount: 3 }).catch(() => {});
      await digitInputs[i].type(totp_code[i], { delay: 20 });
    }

    console.log('[9] Submit 2FA (primary button again)');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      waitAndClick(page, 'button.el-button--primary', { timeout: 20000 }),
    ]);

    // krótki oddech na SPA
    await page.waitForTimeout(1000);

    const currentUrl = page.url();
    console.log('[10] Current URL:', currentUrl);

    const loggedIn = currentUrl.includes('callcontact.eu') && !currentUrl.includes('auth');
    if (!loggedIn) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: 'Nie udało się zalogować (nieoczekiwany URL po logowaniu)',
        currentUrl,
        screenshot,
      };
    }

    const cookies = await page.cookies();

    return {
      success: true,
      message: 'Zalogowano pomyślnie',
      currentUrl,
      since_minutes,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
    };
  } catch (e) {
    console.error('[ERROR]', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  } finally {
    if (page) await safeClosePage(page);
    if (browser) await safeCloseBrowser(browser);
  }
}

// ---------- ROUTES ----------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /login
 * body: { email: string, password: string, totp_code: string, since_minutes?: number }
 */
app.post('/login', async (req, res) => {
  const started = Date.now();
  const body = req.body || {};

  const result = await loginCallContact(body);

  res.status(result.success ? 200 : 500).json({
    ...result,
    took_ms: Date.now() - started,
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'CallContact Login Service',
    endpoints: {
      'GET /health': 'healthcheck',
      'POST /login': 'email + password + totp_code -> cookies',
    },
  });
});

// MUSI być PORT:
app.listen(PORT, () => {
  console.log(`Service running on port ${PORT}`);
});
