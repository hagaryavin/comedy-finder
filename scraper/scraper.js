process.env.DOTENVX_DISABLE = "1";
require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");
const { Client } = require("pg");

puppeteer.use(StealthPlugin());

// פונקציה שמנקה סיומות כמו 1st, 2nd, 3rd, 14th
function cleanDateString(dateStr) {
  return dateStr.replace(/(\d+)(st|nd|rd|th)/, "$1");
}

async function scrape() {
  console.log("DB_URL בשימוש:", process.env.DB_URL);

  // ⭐ חשוב: שימוש ב-Chrome שמותקן ב-GitHub Actions
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process"
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  console.log("טוען את דף הטורים...");
  await page.goto("https://www.comedy.co.uk/live/tours/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForSelector(".menu-item-label");

  const html = await page.content();
  const $ = cheerio.load(html);

  const tours = [];

  $(".menu-item-label").each((i, el) => {
    const title = $(el).text().trim();
    const link = $(el).attr("href");

    if (!link || !link.includes("https://www.comedy.co.uk/live/shows/")) return;

    tours.push({ title, link });
  });

  console.log(`נמצאו ${tours.length} טורים אמיתיים`);

  // חיבור ל-Supabase
  const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  // איפוס טבלאות
  console.log("מוחק נתונים ישנים...");
  await client.query("DELETE FROM shows");
  await client.query("DELETE FROM tours");

  // הכנסת טורים
  for (const t of tours) {
    const result = await client.query(
      `INSERT INTO tours (title, url)
       VALUES ($1, $2)
       RETURNING id`,
      [t.title, t.link]
    );

    const tourId = result.rows[0].id;

    // גרידת דף הטור
    console.log(`מגרד את ${t.title}...`);
    await page.goto(t.link, { waitUntil: "domcontentloaded", timeout: 60000 });

    const tourHtml = await page.content();
    const $$ = cheerio.load(tourHtml);

    const rows = $$(".dates-table tbody tr");

    for (const row of rows) {
      const dateText = $$(row).find("td").eq(0).text().trim();
      const venue = $$(row).find("td").eq(1).text().trim();
      const location = $$(row).find("td").eq(2).text().trim();
      const ticketLink =
        $$(row).find("td").eq(3).find("a").attr("href") || null;

      if (!dateText || !location) {
        console.log("מדלג על שורה חסרה:", { dateText, venue, location });
        continue;
      }

      const cleanedDate = cleanDateString(dateText);
      const parsedDate = new Date(cleanedDate);

      if (isNaN(parsedDate.getTime())) {
        console.log("תאריך לא תקין, מדלג:", dateText);
        continue;
      }

      const isoDate = parsedDate.toISOString().split("T")[0];

      await client.query(
        `INSERT INTO shows (tour_id, date, venue, location, tickets_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [tourId, isoDate, venue, location, ticketLink]
      );
    }
  }

  await client.end();
  await browser.close();

  console.log("סקרייפינג הסתיים בהצלחה!");
}

scrape();
