'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const LOGIN_URL = 'https://user.callcontact.eu/';

async function safeClosePage(page) {
  try { await page.close(); } catch (_) {}
}

async function safeCloseBrowser(browser) {
  try { await browser.close(); } catch (_) {}
}

async function waitAndClick(page, selector, timeout = 25000) {
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
}

async function clearAndType(page, selector, value, timeout = 25000, delay = 20) {
  await page.waitForSelector(selector, { timeout });
  await page.focus(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay });
}

async function loginCallContact({ email, password, totp_code, since_minutes = 15 }) {
  let browser = null;
  let page = null;

  // >>> DIAGNOSTYKA 403
  const blocked_403 = [];
  const net_errors = [];

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
      protocolTimeout: 120000, // ważne przy timeoutach typu DOM.resolveNode
    });

    page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    // Nagłówki i UA (prościej: stabilniej)
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // Logi JS strony (czasem widać, co nie dojechało)
    page.on('console', (msg) => console.log('[page console]', msg.text()));
    page.on('pageerror', (err) => console.log('[page error]', err?.message || err));

    // >>> DIAGNOSTYKA 403: zbieramy tylko to co nas interesuje
    page.on('response', (res) => {
      try {
        const status = res.status();
        if (status === 403) {
          const req = res.request();
          blocked_403.push({
            status,
            url: res.url(),
            method: req.method(),
            resourceType: req.resourceType(), // document/script/xhr/fetch/stylesheet/image/font...
          });
        }
      } catch (_) {}
    });

    // >>> DIAGNOSTYKA: błędy requestów (DNS, timeout, aborted)
    page.on('requestfailed', (req) => {
      try {
        net_errors.push({
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          failure: req.failure() ? req.failure().errorText : 'unknown',
        });
      } catch (_) {}
    });

    // 1) wejście (domcontentloaded jest lepsze do debug niż networkidle2)
    console.log('[2] Open page');
    const resp = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = resp ? resp.status() : null;
    console.log('[2.1] Document status:', status);

    // Jeżeli już dokument ma 403 -> wiesz, że blokują wejście wprost
    if (status === 403) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: '403 na dokumencie (wejście na stronę zablokowane)',
        currentUrl: page.url(),
        blocked_403,
        net_errors,
        screenshot,
      };
    }

    // chwila na rozruch SPA
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // 2) klik "Zaloguj się" (czasem jest nawigacja, czasem nie)
    console.log('[3] Click "Zaloguj się"');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      waitAndClick(page, 'button.LoginRegisterView__column__button', 30000),
    ]);

    // 3) czekamy na email — ale nie tylko placeholder (stabilniej)
    console.log('[4] Wait for email input');
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="mail" i]',
      'input[placeholder*="email" i]',
      'input[placeholder="Adres email"]',
    ];

    // czekamy na pierwszy, który się pojawi
    const emailSel = await Promise.race(
      emailSelectors.map((sel) => page.waitForSelector(sel, { timeout: 30000 }).then(() => sel))
    ).catch(() => null);

    if (!emailSel) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: 'Nie pojawiło się pole email (UI nie wyrenderowało się lub zasoby/API dostały 403)',
        currentUrl: page.url(),
        blocked_403,
        net_errors,
        screenshot,
      };
    }

    console.log('[5] Type email');
    await clearAndType(page, emailSel, email, 25000, 20);

    // 4) hasło — jak u Ciebie: placeholder "8 znaków" albo password
    console.log('[6] Type password');
    const passSelectors = [
      'input[placeholder*="8 znaków" i]',
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ];

    const passSel = await Promise.race(
      passSelectors.map((sel) => page.waitForSelector(sel, { timeout: 30000 }).then(() => sel))
    ).catch(() => null);

    if (!passSel) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: 'Nie znaleziono pola hasła',
        currentUrl: page.url(),
        blocked_403,
        net_errors,
        screenshot,
      };
    }

    await clearAndType(page, passSel, password, 25000, 20);

    // 5) submit logowania — u Ciebie: button.el-button--primary
    console.log('[7] Submit login form');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      waitAndClick(page, 'button.el-button--primary', 25000),
    ]);

    // chwila na przejście do 2FA
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 6) 2FA: input.digit (6 pól)
    console.log('[8] Wait for 2FA inputs');
    const has2FA = await page.waitForSelector('input.digit', { timeout: 30000 }).then(() => true).catch(() => false);
    if (!has2FA) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: 'Nie pojawiły się pola 2FA (input.digit)',
        currentUrl: page.url(),
        blocked_403,
        net_errors,
        screenshot,
      };
    }

    const digitInputs = await page.$$('input.digit');
    if (digitInputs.length !== 6) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: `Oczekiwano 6 pól 2FA, znaleziono: ${digitInputs.length}`,
        currentUrl: page.url(),
        blocked_403,
        net_errors,
        screenshot,
      };
    }

    console.log('[9] Fill 2FA code');
    for (let i = 0; i < 6; i++) {
      await digitInputs[i].click({ clickCount: 3 }).catch(() => {});
      await digitInputs[i].type(totp_code[i], { delay: 20 });
    }

    // 7) submit 2FA (ten sam selector)
    console.log('[10] Submit 2FA');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      waitAndClick(page, 'button.el-button--primary', 25000),
    ]);

    // chwila na SPA
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const currentUrl = page.url();
    console.log('[11] Current URL:', currentUrl);

    const loggedIn = currentUrl.includes('callcontact.eu') && !currentUrl.includes('auth');
    if (!loggedIn) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: 'Nie udało się zalogować (URL wygląda jak przed logowaniem / auth)',
        currentUrl,
        blocked_403,
        net_errors,
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
      // >>> najważniejsze: zwracamy diagnostykę także przy sukcesie
      blocked_403,
      net_errors,
    };
  } catch (e) {
    console.error('[ERROR]', e?.message || e);

    const screenshot = page ? await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null) : null;

    return {
      success: false,
      error: e?.message || String(e),
      currentUrl: page ? page.url() : null,
      blocked_403,
      net_errors,
      screenshot,
    };
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

app.post('/login', async (req, res) => {
  const started = Date.now();

  const result = await loginCallContact(req.body || {});
  const statusCode = result.success ? 200 : 500;

  res.status(statusCode).json({
    ...result,
    took_ms: Date.now() - started,
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'CallContact Login Service',
    endpoints: {
      'GET /health': 'healthcheck',
      'POST /login': 'email + password + totp_code -> cookies + blocked_403',
    },
  });
});

app.listen(PORT, () => {
  console.log(`Service running on port ${PORT}`);
});
