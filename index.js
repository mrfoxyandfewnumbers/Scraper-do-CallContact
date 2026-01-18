'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '1mb' }));

const LOGIN_URL = 'https://user.callcontact.eu/';

/**
 * Pomocnicze: bezpieczne zamykanie
 */
async function safeCloseBrowser(browser) {
  try { await browser.close(); } catch (_) {}
}

async function safeClosePage(page) {
  try { await page.close(); } catch (_) {}
}

/**
 * Pomocnicze: klik z “odczekaniem” na zmianę UI / nawigację (SPA friendly)
 */
async function clickAndWait(page, clickSelector, waitForSelectorAfter, opts = {}) {
  const {
    clickTimeout = 15000,
    waitTimeout = 30000,
    navigation = false,
  } = opts;

  await page.waitForSelector(clickSelector, { timeout: clickTimeout });

  if (navigation) {
    // czasem jest nawigacja, czasem nie — nie wywalamy się jak nie ma
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: waitTimeout }),
      page.click(clickSelector),
    ]);
  } else {
    await page.click(clickSelector);
  }

  if (waitForSelectorAfter) {
    await page.waitForSelector(waitForSelectorAfter, { timeout: waitTimeout });
  }
}

/**
 * Pomocnicze: wpisz do inputa (czyści pole)
 */
async function clearAndType(page, selector, value, delay = 40) {
  await page.waitForSelector(selector, { timeout: 20000 });
  await page.focus(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay });
}

/**
 * Główna funkcja: logowanie do CallContact
 * FLOW jest zgodny z Twoim oryginałem:
 * 1) wejście
 * 2) klik "Zaloguj się"
 * 3) email
 * 4) hasło
 * 5) submit
 * 6) 2FA (6 inputów)
 * 7) submit
 * 8) walidacja + cookies
 */
async function loginCallContact(email, password, totpCode, sinceMinutes = 15) {
  let browser = null;
  let page = null;

  try {
    console.log('Uruchamiam przeglądarkę (Render-friendly chromium)...');

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    page = await browser.newPage();

    // UA jak w Twoim kodzie
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);

    page.on('console', (msg) => console.log('[page console]', msg.text()));
    page.on('pageerror', (err) => console.log('[page error]', err?.message || err));

    // KROK 1: Otwórz stronę
    console.log('KROK 1: Otwieram', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // KROK 2: Klik "Zaloguj się" i czekaj aż pokaże się pole email
    console.log('KROK 2: Klikam "Zaloguj się" i czekam na formularz...');
    await clickAndWait(
      page,
      'button.LoginRegisterView__column__button',
      'input[placeholder="Adres email"]',
      { navigation: true, waitTimeout: 30000 }
    );

    // KROK 3: Email
    console.log('KROK 3: Wpisuję email...');
    await clearAndType(page, 'input[placeholder="Adres email"]', email, 40);

    // KROK 4: Hasło (jak u Ciebie: placeholder "8 znaków" albo password)
    console.log('KROK 4: Wpisuję hasło...');
    const passwordPreferred = 'input[placeholder*="8 znaków"]';
    const passwordFallback = 'input[type="password"]';

    const hasPreferred = await page.$(passwordPreferred);
    if (hasPreferred) {
      await clearAndType(page, passwordPreferred, password, 40);
    } else {
      const hasFallback = await page.$(passwordFallback);
      if (hasFallback) {
        await clearAndType(page, passwordFallback, password, 40);
      } else {
        throw new Error('Nie znaleziono pola hasła (brak placeholder "8 znaków" i brak input[type="password"])');
      }
    }

    // KROK 5: Submit formularza
    console.log('KROK 5: Klikam "ZALOGUJ SIĘ" (formularz)...');
    // Uwaga: w Twoim kodzie to button.el-button--primary – zostawiamy, ale po kliknięciu czekamy na 2FA
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click('button.el-button--primary'),
    ]);

    // KROK 6: 2FA – czekamy na input.digit
    console.log('KROK 6: Czekam na pola 2FA (input.digit)...');
    await page.waitForSelector('input.digit', { timeout: 20000 });

    // KROK 7: Wpisz kod 2FA w 6 polach
    console.log('KROK 7: Wpisuję kod 2FA:', totpCode);

    if (typeof totpCode !== 'string' || totpCode.length !== 6) {
      throw new Error('totp_code musi być stringiem o długości 6, np. "123456"');
    }

    const digitInputs = await page.$$('input.digit');
    if (digitInputs.length !== 6) {
      throw new Error(`Oczekiwano 6 pól na kod 2FA, znaleziono: ${digitInputs.length}`);
    }

    for (let i = 0; i < 6; i++) {
      await digitInputs[i].click({ clickCount: 3 }).catch(() => {});
      await digitInputs[i].type(totpCode[i], { delay: 25 });
    }

    // KROK 8: Submit 2FA
    console.log('KROK 8: Klikam "ZALOGUJ SIĘ" (2FA)...');
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('button.el-button--primary'),
    ]);

    // KROK 9: Walidacja
    const currentUrl = page.url();
    console.log('KROK 9: Obecny URL po logowaniu:', currentUrl);

    // U Ciebie: "callcontact.eu" i nie "auth"
    const loggedIn = currentUrl.includes('callcontact.eu') && !currentUrl.includes('auth');

    if (!loggedIn) {
      const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
      return {
        success: false,
        error: 'Nie udało się zalogować - nieoczekiwany URL po logowaniu',
        currentUrl,
        screenshot,
      };
    }

    console.log('Zalogowano pomyślnie! Pobieram cookies...');
    const cookies = await page.cookies();

    return {
      success: true,
      message: 'Zalogowano pomyślnie do CallContact',
      currentUrl,
      // trzymamy minimalistyczny zestaw jak w Twoim kodzie
      cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain })),
      since_minutes: sinceMinutes, // zostawiam, bo jest w body — może Ci się przyda w kolejnych krokach
    };
  } catch (error) {
    console.error('Błąd:', error.message);
    return { success: false, error: error.message };
  } finally {
    if (page) await safeClosePage(page);
    if (browser) await safeCloseBrowser(browser);
  }
}

/**
 * POST /login
 * body: { email, password, totp_code, since_minutes? }
 * (zgodne z Twoim oryginałem)
 */
app.post('/login', async (req, res) => {
  const { email, password, totp_code, since_minutes = 15 } = req.body || {};

  if (!email || !password || !totp_code) {
    return res.status(400).json({
      success: false,
      error: 'Brakuje wymaganych danych: email, password, totp_code',
    });
  }

  console.log(`\n=== Nowe żądanie logowania dla: ${email} ===`);
  const result = await loginCallContact(email, password, totp_code, since_minutes);
  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Serwis działa',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Login Service',
    version: '3.0.0',
    endpoints: {
      'POST /login': 'Logowanie (email + password + totp_code)',
      'GET /health': 'Sprawdzenie czy serwis działa',
    },
  });
});

app.listen(PORT, () => {
  console.log(`Login Service v3.0.0 działa na porcie ${PORT}`);
});
