import { list, del } from '@vercel/blob';
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  let cursor, removed = 0;
  do {
    const page = await list({ prefix: 'proximity/v1/', limit: 1000, cursor });
    const expired = page.blobs.filter((blob) => Date.now() - new Date(blob.uploadedAt).getTime() > 600000);
    if (expired.length) { await del(expired.map((blob) => blob.url)); removed += expired.length; }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  res.json({ removed });
}
