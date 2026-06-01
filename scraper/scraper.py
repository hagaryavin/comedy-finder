import requests
from bs4 import BeautifulSoup
import psycopg2
import os

DB_URL = os.getenv("DB_URL")

def scrape():
    print("מתחיל סקרייפינג...")

    # דוגמה: גרד את רשימת הסיבובים
    url = "https://www.comedy.co.uk/live/tours/"
    html = requests.get(url).text
    soup = BeautifulSoup(html, "html.parser")

    tours = soup.select(".tour_item")

    print(f"נמצאו {len(tours)} סיבובים")

    # חיבור ל-DB
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    for t in tours:
        title = t.get_text(strip=True)
        link = "https://www.comedy.co.uk" + t.find("a")["href"]

        cur.execute("""
            INSERT INTO tours (title, url)
            VALUES (%s, %s)
            ON CONFLICT (url) DO NOTHING
        """, (title, link))

    conn.commit()
    cur.close()
    conn.close()

    print("סקרייפינג הסתיים בהצלחה!")

if __name__ == "__main__":
    scrape()
