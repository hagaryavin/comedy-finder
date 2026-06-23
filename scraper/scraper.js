// ❗ חובה: לכבות כל טעינה של dotenv/dotenvx
process.env.DOTENVX_DISABLE = "1";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");
const { Client } = require("pg");

puppeteer.use(StealthPlugin());

// ניקוי סיומות כמו 1st, 2nd, 3rd, 14th
function cleanDateString(dateStr) {
  return dateStr.replace(/(\d+)(st|nd|rd|th)/, "$1");
}

// ⭐ פונקציית retry לניווט
async function safeGoto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 90000, // ⬅ הגדלתי timeout
      });
      return;
    } catch (err) {
      console.log(`❗ ניסיון ${i + 1} לטעינת ${url} נכשל`);
      if (i === retries - 1) throw err;
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

async function scrape() {
  console.log("DB_URL:", process.env.DB_URL);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
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
  await safeGoto(page, "https://www.comedy.co.uk/live/tours/");

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

  // ⭐ חיבור ל-Supabase
  const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
    keepAlive: true,
  });

  await client.connect();

  // ⭐ מוחק רק הופעות מהעבר — לא מוחק הכול!
  console.log("מוחק הופעות מהעבר בלבד...");
  await client.query(`DELETE FROM shows WHERE date < CURRENT_DATE`);

  for (const t of tours) {
    console.log(`מגרד את ${t.title}...`);

    // ⭐ עטיפה ב-try/catch כדי שלא יפיל את כל הריצה
    let tourId;
    try {
      // ⭐ UPSERT לטבלת tours
      const result = await client.query(
        `INSERT INTO tours (title, url)
         VALUES ($1, $2)
         ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title
         RETURNING id`,
        [t.title, t.link]
      );

      tourId = result.rows[0].id;
    } catch (err) {
      console.log("❗ שגיאה בהכנסת טור:", t.title, err);
      continue; // לא מנסים להכניס הופעות בלי טור
    }

    // ⭐ טעינת דף הטור עם retry
    try {
      await safeGoto(page, t.link);
    } catch (err) {
      console.log("❗ לא ניתן לטעון את דף הטור:", t.link);
      continue;
    }

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

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (isNaN(parsedDate.getTime())) {
        console.log("תאריך לא תקין, מדלג:", { dateText, venue, location });
        continue;
      }

      if (parsedDate < today) {
        console.log("מדלג על הופעה מהעבר:", { dateText, venue, location });
        continue;
      }

      const isoDate = parsedDate.toISOString().split("T")[0];

      // ⭐ UPSERT לטבלת shows + geocoded=false להופעות חדשות
      try {
        await client.query(
          `INSERT INTO shows (tour_id, date, venue, location, tickets_url, geocoded)
           VALUES ($1, $2, $3, $4, $5, false)
           ON CONFLICT (tour_id, date, venue, location)
           DO UPDATE SET tickets_url = EXCLUDED.tickets_url`,
          [tourId, isoDate, venue, location, ticketLink]
        );
      } catch (err) {
        console.log("❗ שגיאה בהכנסת הופעה:", { tourId, isoDate, venue, location }, err);
      }
    }
  }

  await client.end();
  await browser.close();

  console.log("סקרייפינג הסתיים בהצלחה!");
}

scrape();
