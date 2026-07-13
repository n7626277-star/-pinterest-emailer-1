"""
Pinterest board RSS -> Email attachment bot.

Checks a public Pinterest board's RSS feed for new pins, downloads each
new pin's image straight into memory, and emails it as an attachment.
State (which pins were already sent) is kept in seen_pins.json so the
same pin is never emailed twice.
"""

import json
import os
import smtplib
import ssl
import re
from email.message import EmailMessage
from pathlib import Path

import feedparser
import requests

def _clean(value):
    return value.strip().strip('"').strip("'").strip()


RSS_URL = _clean(os.environ["RSS_URL"])
FROM_EMAIL = _clean(os.environ["FROM_EMAIL"])
APP_PASSWORD = _clean(os.environ["APP_PASSWORD"])
TO_EMAIL = _clean(os.environ["TO_EMAIL"])

print(f"RSS_URL length: {len(RSS_URL)}, starts with https: {RSS_URL.startswith('https://')}")
print(f"FROM_EMAIL length: {len(FROM_EMAIL)}")
print(f"APP_PASSWORD length: {len(APP_PASSWORD)}")
print(f"TO_EMAIL length: {len(TO_EMAIL)}")

STATE_FILE = Path("seen_pins.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}


def load_seen():
    if STATE_FILE.exists():
        return set(json.loads(STATE_FILE.read_text()))
    return set()


def save_seen(seen):
    STATE_FILE.write_text(json.dumps(sorted(seen)))


def extract_image_url(entry):
    # Pinterest RSS puts the image inside the HTML of the description,
    # e.g. <img src="https://i.pinimg.com/....jpg" />
    html = entry.get("summary", "") or entry.get("description", "")
    match = re.search(r'src="([^"]+\.(?:jpg|jpeg|png))"', html)
    if match:
        return match.group(1)
    # fallback: some feeds expose media_content
    if "media_content" in entry and entry.media_content:
        return entry.media_content[0].get("url")
    return None


def send_email_with_image(subject, body, image_bytes, filename):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = FROM_EMAIL
    msg["To"] = TO_EMAIL
    msg.set_content(body)
    msg.add_attachment(
        image_bytes, maintype="image", subtype="jpeg", filename=filename
    )

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(FROM_EMAIL, APP_PASSWORD)
        server.send_message(msg)


def main():
    try:
        resp = requests.get(RSS_URL, headers=HEADERS, timeout=20)
        print(f"RSS fetch status code: {resp.status_code}")
        print(f"RSS response length: {len(resp.text)} chars")
        print(f"First 300 chars of response:\n{resp.text[:300]}")
        feed = feedparser.parse(resp.content)
    except requests.RequestException as e:
        print(f"Failed to fetch RSS feed: {e}")
        return

    print(f"Entries found in feed: {len(feed.entries)}")

    seen = load_seen()
    new_seen = set(seen)
    sent_count = 0

    for entry in feed.entries:
        pin_id = entry.get("id") or entry.get("link")
        if not pin_id or pin_id in seen:
            continue

        image_url = extract_image_url(entry)
        if not image_url:
            print(f"Skipping (no image found): {pin_id}")
            new_seen.add(pin_id)
            continue

        try:
            img_resp = requests.get(image_url, headers=HEADERS, timeout=20)
            img_resp.raise_for_status()
            image_bytes = img_resp.content
        except requests.RequestException as e:
            print(f"Failed to download image for {pin_id}: {e}")
            continue

        title = entry.get("title", "New Pin")
        filename = image_url.split("/")[-1].split("?")[0] or "pin.jpg"

        try:
            send_email_with_image(
                subject=f"פין חדש: {title}",
                body=f"{title}\n\n{entry.get('link', '')}",
                image_bytes=image_bytes,
                filename=filename,
            )
            print(f"Emailed: {title}")
            sent_count += 1
        except Exception as e:
            print(f"Failed to send email for {pin_id}: {e}")
            continue

        new_seen.add(pin_id)

    save_seen(new_seen)
    print(f"Done. Sent {sent_count} new pin(s).")


if __name__ == "__main__":
    main()
