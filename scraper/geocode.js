// geocode.js
process.env.DOTENVX_DISABLE = "1";

const { Client } = require("pg");

const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY;

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocode() {
  console.log("מתחבר למסד הנתונים...");

  const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  console.log("טוען הופעות שעדיין לא עברו geocoding...");
  const { rows: shows } = await client.query(`
    SELECT id, venue, location
    FROM shows
    WHERE geocoded = false;
  `);

  console.log(`נמצאו ${shows.length} הופעות שדורשות geocoding`);

  for (const show of shows) {
    const query = `${show.venue} ${show.location}`;
    console.log(`🔍 מחפש מיקום עבור: ${query}`);

    let results = null;

    try {
      const url = `https://us1.locationiq.com/v1/search?key=${LOCATIONIQ_KEY}&q=${encodeURIComponent(
        query
      )}&format=json&addressdetails=1&limit=5`;

      const res = await fetch(url);

      // ⭐ זיהוי RATE LIMIT (429)
      if (res.status === 429) {
        console.log("⏳ RATE LIMIT — נחסמתי זמנית. מדלג להופעה הבאה.");
        await sleep(2000);
        continue;
      }

      // ⭐ זיהוי DAILY LIMIT (403)
      if (res.status === 403) {
        console.log("🛑 נגמרו הבקשות להיום (Daily limit reached). מפסיק את הריצה.");
        await client.end();
        return;
      }

      results = await res.json();
    } catch (err) {
      console.log("❗ שגיאה בקריאת API:", err);
      await sleep(2000);
      continue;
    }

    // ⭐ אין תוצאות אמיתית
    if (!Array.isArray(results) || results.length === 0) {
      console.log("⚠ אין תוצאות — מנסה שוב מחר");
      await sleep(2000);
      continue;
    }

    let best;

    // ⭐ אם יש רק תוצאה אחת
    if (results.length === 1) {
      best = results[0];
    } else {
      // ⭐ קודם UK
      let candidates = results.filter(
        r => r.address && r.address.country_code === "gb"
      );

      // ⭐ אם אין UK → כל התוצאות
      if (candidates.length === 0) {
        candidates = results;
      }

      // ⭐ מיון לפי importance
      candidates.sort((a, b) => (b.importance || 0) - (a.importance || 0));
      best = candidates[0];
    }

    const lat = parseFloat(best.lat);
    const lng = parseFloat(best.lon);

    console.log(`📍 נמצא: lat=${lat}, lng=${lng}`);

    await client.query(
      `UPDATE shows
       SET lat = $1, lng = $2, geocoded = true
       WHERE id = $3`,
      [lat, lng, show.id]
    );

    // ⭐ הפסקה בין בקשות — 2 שניות
    await sleep(2000);
  }

  await client.end();
  console.log("🎉 geocoding הסתיים!");
}

geocode();
