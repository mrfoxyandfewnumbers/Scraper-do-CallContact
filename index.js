'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const LOGIN_URL = 'https://user.callcontact.eu/';

// ========== TOTP Generator ==========
function base32Decode(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of encoded.toUpperCase().replace(/=+$/, '')) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

function hmacSha1(key, message) {
  const hmac = crypto.createHmac('sha1', Buffer.from(key));
  hmac.update(Buffer.from(message));
  return new Uint8Array(hmac.digest());
}

function generateTOTP(secret) {
  const time = Math.floor(Date.now() / 1000 / 30);
  const timeBytes = new Uint8Array(8);
  const view = new DataView(timeBytes.buffer);
  view.setBigUint64(0, BigInt(time), false);
  
  const key = base32Decode(secret);
  const hmac = hmacSha1(key, timeBytes);
  
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 |
                (hmac[offset + 1] & 0xff) << 16 |
                (hmac[offset + 2] & 0xff) << 8 |
                (hmac[offset + 3] & 0xff)) % 1000000;
  
  return code.toString().padStart(6, '0');
}
// ========== End TOTP Generator ==========

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

async function loginCallContact({ email, password, totp_secret, since_minutes = 15 }) {
  let browser = null;
  let page = null;

  const blocked_403 = [];
  const net_errors = [];

  try {
    if (!email || !password || !totp_secret) {
      throw new Error('Brakuje wymaganych pól: email, password, totp_secret');
    }

    console.log('[1] Launch browser');
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      protocolTimeout: 120000,
    });

    page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    page.on('console', (msg) => console.log('[page console]', msg.text()));
    page.on('pageerror', (err) => console.log('[page error]', err?.message || err));

    page.on('response', (res) => {
      try {
        const status = res.status();
        if (status === 403) {
          const req = res.request();
          blocked_403.push({
            status,
            url: res.url(),
            method: req.method(),
            resourceType: req.resourceType(),
          });
        }
      } catch (_) {}
    });

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

    console.log('[2] Open page');
    const resp = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = resp ? resp.status() : null;
    console.log('[2.1] Document status:', status);

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

    await new Promise((resolve) => setTimeout(resolve, 1200));

    console.log('[3] Click "Zaloguj się"');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      waitAndClick(page, 'button.LoginRegisterView__column__button', 30000),
    ]);

    console.log('[4] Wait for email input');
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="mail" i]',
      'input[placeholder*="email" i]',
      'input[placeholder="Adres email"]',
    ];

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

    console.log('[7] Submit login form');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      waitAndClick(page, 'button.el-button--primary', 25000),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1000));

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

    // Generuj świeży kod TOTP tuż przed użyciem
    const totp_code = generateTOTP(totp_secret);
    console.log('[8.5] Generated fresh TOTP code');

    console.log('[9] Fill 2FA code');
    for (let i = 0; i < 6; i++) {
      await digitInputs[i].click({ clickCount: 3 }).catch(() => {});
      await digitInputs[i].type(totp_code[i], { delay: 20 });
    }

    console.log('[10] Submit 2FA');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      waitAndClick(page, 'button.el-button--primary', 25000),
    ]);

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
    console.log('[12] Zalogowano, pobieram listę połączeń...');

    // Oblicz daty (od since_minutes temu do teraz)
    const now = new Date();
    const since = new Date(now.getTime() - (since_minutes * 60 * 1000));
    const dateFrom = since.toISOString().split('T')[0];
    const dateTo = now.toISOString().split('T')[0];

    // Pobierz listę połączeń przez API
    const connectionsUrl = `https://user.callcontact.eu/api/connections/getList?filtering_criteria[date_from]=${dateFrom}&filtering_criteria[date_to]=${dateTo}&page=1&page_size=100&sorting_direction=2`;
    
    console.log('[13] Pobieram połączenia:', connectionsUrl);
    
    const connectionsResponse = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    }, connectionsUrl);

    console.log('[14] Odpowiedź API connections:', JSON.stringify(connectionsResponse).substring(0, 200));

    if (connectionsResponse.error || !connectionsResponse.data) {
      return {
        success: true,
        message: 'Zalogowano, ale błąd przy pobieraniu listy połączeń',
        currentUrl,
        cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
        connectionsError: connectionsResponse.error || 'Brak danych',
        blocked_403,
        net_errors,
      };
    }

    const allConnections = connectionsResponse.data.records || [];
    const withRecording = allConnections.filter(conn => conn._recorded === true);
    
    console.log(`[15] Znaleziono ${allConnections.length} połączeń, ${withRecording.length} z nagraniem`);

    // Pobierz nagrania dla każdego połączenia z nagraniem
    const recordings = [];
    for (const conn of withRecording) {
      console.log(`[16] Pobieram nagranie dla connectionId: ${conn._id}`);
      
      const recordingUrl = `https://user.callcontact.eu/api/record/download?connection=${conn._id}`;
      
      const recordingData = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url, {
            method: 'GET',
            credentials: 'include'
          });
          const text = await res.text();
          return { success: true, data: text, contentType: res.headers.get('content-type') };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, recordingUrl);

      recordings.push({
        connectionId: conn._id,
        filename: conn._filename,
        agentName: conn._agent_name,
        numberClient: conn._number_a,
        numberAgent: conn._number_b,
        callStart: conn._call_start,
        callEnd: conn._call_end,
        talkingTime: conn._talking_time,
        effect: conn._effect,
        effectName: conn._effect_name,
        recording: recordingData
      });
    }

    console.log(`[17] Pobrano ${recordings.length} nagrań`);

    return {
      success: true,
      message: `Zalogowano i pobrano ${recordings.length} nagrań`,
      currentUrl,
      since_minutes,
      dateRange: { from: dateFrom, to: dateTo },
      totalConnections: allConnections.length,
      connectionsWithRecording: withRecording.length,
      recordings,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
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
    version: '3.0.0',
    endpoints: {
      'GET /health': 'healthcheck',
      'POST /login': 'email + password + totp_secret + since_minutes -> cookies + recordings',
    },
  });
});

app.listen(PORT, () => {
  console.log(`CallContact Scraper v3.0 running on port ${PORT}`);
});
