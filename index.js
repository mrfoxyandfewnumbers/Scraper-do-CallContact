'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * ENV (ustaw na Render):
 * - PORT (Render ustawia sam)
 * - BAW_BASE_URL (np. https://twoj-portal.pl)
 * - BAW_LOGIN_URL (opcjonalnie; jeśli nie dasz, użyje BAW_BASE_URL)
 * - BAW_EMAIL
 * - BAW_PASSWORD
 *
 * Dla bezpieczeństwa: credentials tylko w ENV.
 */

const PORT = process.env.PORT || 3000;

const BAW_BASE_URL = process.env.BAW_BASE_URL || '';
const BAW_LOGIN_URL = process.env.BAW_LOGIN_URL || BAW_BASE_URL;

const BAW_EMAIL = process.env.BAW_EMAIL || '';
const BAW_PASSWORD = process.env.BAW_PASSWORD || '';

let browserSingleton = null;

/** Render-friendly launch */
async function getBrowser() {
  if (browserSingleton) return browserSingleton;

  browserSingleton = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });

  // Jeśli browser się wywali, wyczyść singleton, żeby kolejne requesty mogły go odtworzyć
  browserSingleton.on('disconnected', () => {
    browserSingleton = null;
  });

  return browserSingleton;
}

async function safeClosePage(page) {
  try {
    await page.close();
  } catch (_) {}
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
}

/**
 * Minimalny login flow:
 * 1) Wejście na login
 * 2) Klik "Zaloguj się" (jeśli jest)
 * 3) Wpisanie email/hasło
 * 4) Submit
 * 5) Oczekiwanie, aż UI po zalogowaniu będzie gotowy
 *
 * UWAGA: selektory są Twoje z poprzednich wersji:
 * - button.LoginRegisterView__column__button
 * - input[placeholder="Adres email"]
 * Jeśli portal ma inne selektory, podmienisz je w 2 miejscach.
 */
async function ensureLoggedIn(page) {
  requireEnv('BAW_BASE_URL', BAW_BASE_URL);
  requireEnv('BAW_EMAIL', BAW_EMAIL);
  requireEnv('BAW_PASSWORD', BAW_PASSWORD);

  // 1) open
  await page.goto(BAW_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // (opcjonalnie) jeśli jest przycisk przejścia do formularza logowania
  const loginButtonSelector = 'button.LoginRegisterView__column__button';
  const emailSelector = 'input[placeholder="Adres email"]';

  const hasLoginButton = await page.$(loginButtonSelector);
  if (hasLoginButton) {
    console.log('[login] Klikam "Zaloguj się" button...');
    // czasem to jest SPA (brak pełnej nawigacji), więc nie możemy polegać wyłącznie na waitForNavigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
      page.click(loginButtonSelector),
    ]);
  }

  // czekamy aż pokaże się input email (to jest najbardziej pewny sygnał)
  await page.waitForSelector(emailSelector, { timeout: 20000 });

  console.log('[login] Wpisuję email/hasło...');
  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, BAW_EMAIL, { delay: 10 });

  // poniżej: selektor hasła może być inny — daję 2 najczęstsze podejścia
  const passwordSelectors = [
    'input[type="password"]',
    'input[placeholder="Hasło"]',
    'input[name="password"]',
  ];

  let passwordSel = null;
  for (const sel of passwordSelectors) {
    const el = await page.$(sel);
    if (el) {
      passwordSel = sel;
      break;
    }
  }
  if (!passwordSel) throw new Error('Nie znalazłem pola hasła (sprawdź selektor).');

  await page.click(passwordSel, { clickCount: 3 });
  await page.type(passwordSel, BAW_PASSWORD, { delay: 10 });

  // submit (przycisk / enter)
  // Spróbuj button type=submit, jak nie ma – Enter w haśle
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Zaloguj")', // UWAGA: puppeteer nie wspiera :has-text natywnie; zostawiam jako komentarz
  ];

  const submitBtn = await page.$(submitSelectors[0]);
  console.log('[login] Submit...');
  if (submitBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
      page.click(submitSelectors[0]),
    ]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
  }

  // Po logowaniu: dajemy oddech i sprawdzamy, czy nie ma dalej inputa email (czyli nadal na loginie)
  await page.waitForTimeout(1200);

  const stillOnLogin = await page.$(emailSelector);
  if (stillOnLogin) {
    // Nie zawsze oznacza fail (czasem UI zostaje), ale najczęściej tak.
    // Jeżeli masz konkretny selektor po zalogowaniu – dodaj tu twardą walidację.
    console.warn('[login] UWAGA: nadal widzę pole email – możliwy brak zalogowania.');
  }

  console.log('[login] Done.');
}

/**
 * Przykładowa funkcja, która po zalogowaniu idzie na stronę dokumentów
 * i zwraca dane.
 *
 * Ponieważ nie wkleiłeś tutaj finalnych endpointów portalu,
 * zostawiam to jako “szkielet”:
 * - możesz albo scrapować tabelę
 * - albo (lepiej) wywołać request XHR z cookies (page.evaluate fetch)
 */
async function fetchDocuments(page, { keyword = '', pageSize = 20, pageNumber = 0 } = {}) {
  // TODO: podmień na realny URL po zalogowaniu, np. `${BAW_BASE_URL}/documents`
  const documentsUrl = `${BAW_BASE_URL}`;
  await page.goto(documentsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Jeśli masz konkretny API request, to tu najlepiej zrobić:
  // - albo bezpośrednio HTTP request (axios) z tokenem/cookies
  // - albo page.evaluate(() => fetch(...))
  //
  // Na teraz zwracam “diagnostycznie” URL i podstawowe info.
  return {
    ok: true,
    note: 'Podmień fetchDocuments na realny scraping lub request do API portalu.',
    keyword,
    pageSize,
    pageNumber,
    currentUrl: page.url(),
  };
}

/** Health */
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    browserActive: !!browserSingleton,
    baseUrlSet: !!BAW_BASE_URL,
  });
});

/**
 * POST /baw/documents
 * body: { keyword?: string, pageSize?: number, pageNumber?: number }
 */
app.post('/baw/documents', async (req, res) => {
  const started = Date.now();
  const { keyword = '', pageSize = 20, pageNumber = 0 } = req.body || {};

  let page = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // stabilniejsze na słabszych maszynach
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);

    // logi requestów (pomaga debugować blokady)
    page.on('console', (msg) => console.log('[page console]', msg.text()));
    page.on('pageerror', (err) => console.log('[page error]', err?.message || err));

    // (opcjonalnie) user-agent
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    );

    await ensureLoggedIn(page);

    const data = await fetchDocuments(page, { keyword, pageSize, pageNumber });

    res.json({
      ok: true,
      took_ms: Date.now() - started,
      data,
    });
  } catch (err) {
    console.error('[ERROR]', err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      took_ms: Date.now() - started,
    });
  } finally {
    if (page) await safeClosePage(page);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
