const { google } = require('googleapis');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const DOWNLOAD_SERVER = process.env.DOWNLOAD_SERVER_URL; // לדוגמה: https://repository-name-0tf0.onrender.com

const PROCESSED_LABEL_NAME = 'טופל-קישור-דרייב';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DOWNLOAD_SERVER) {
  console.error('חסרים משתני סביבה נדרשים (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN / DOWNLOAD_SERVER_URL)');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// מחלץ File ID מתוך קישור Google Drive
function extractFileId(text) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

// מוצא, או יוצר אם לא קיימת, תווית (label) לסימון מיילים שכבר טופלו
async function getOrCreateLabel(name) {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const existing = (res.data.labels || []).find((l) => l.name === name);
  if (existing) return existing.id;

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  return created.data.id;
}

function getHeader(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// שולף טקסט (plain/html) מגוף המייל, כולל חלקים מקוננים
function decodeBody(payload) {
  let text = '';
  function walk(part) {
    if (!part) return;
    if (part.body && part.body.data && (part.mimeType === 'text/plain' || part.mimeType === 'text/html')) {
      text += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n';
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return text;
}

// בונה מייל תשובה גולמי (RFC 2822) מקודד ב-base64url, כפי שדורש Gmail API
function buildReplyRaw({ to, subject, inReplyTo, bodyText }) {
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(replySubject, 'utf-8').toString('base64')}?=`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    inReplyTo ? `References: ${inReplyTo}` : '',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    bodyText
  ].filter(Boolean);

  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function main() {
  const labelId = await getOrCreateLabel(PROCESSED_LABEL_NAME);

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `in:inbox drive.google.com -label:"${PROCESSED_LABEL_NAME}"`,
    maxResults: 20
  });

  const messages = list.data.messages || [];
  console.log(`נמצאו ${messages.length} מיילים לבדיקה`);

  for (const m of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const headers = full.data.payload.headers;
    const from = getHeader(headers, 'From');
    const subject = getHeader(headers, 'Subject') || '(ללא נושא)';
    const messageIdHeader = getHeader(headers, 'Message-ID');
    const bodyText = decodeBody(full.data.payload) + ' ' + (full.data.snippet || '');

    const urlMatch = bodyText.match(/https?:\/\/drive\.google\.com\/[^\s"'<>]+/);
    const fileId = urlMatch ? extractFileId(urlMatch[0]) : extractFileId(bodyText);

    if (!fileId) {
      console.log(`מייל ${m.id}: לא נמצא קישור דרייב תקין, מסמן ומדלג`);
      await gmail.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [labelId] } });
      continue;
    }

    const previewLink = `${DOWNLOAD_SERVER}/preview/${fileId}`;
    const downloadLink = `${DOWNLOAD_SERVER}/download/${fileId}`;

    const replyBody = [
      'שלום,',
      '',
      'הקישורים מוכנים:',
      '',
      `צפייה: ${previewLink}`,
      `הורדה ישירה: ${downloadLink}`,
      '',
      '(מייל אוטומטי)'
    ].join('\n');

    const raw = buildReplyRaw({ to: from, subject, inReplyTo: messageIdHeader, bodyText: replyBody });

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: m.threadId }
    });

    await gmail.users.messages.modify({ userId: 'me', id: m.id, requestBody: { addLabelIds: [labelId] } });

    console.log(`מייל ${m.id}: נשלחה תשובה עם קישורים עבור fileId=${fileId}`);
  }
}

main().catch((err) => {
  console.error('שגיאה בהרצת הסקריפט:', err.message || err);
  process.exit(1);
});
