import 'dotenv/config';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'elogy-shopify-sync-health',
    dryRun: DRY_RUN,
  });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    message: 'Service is running. Use the Railway cron job to execute sync.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Health service listening on http://0.0.0.0:${PORT}`);
});
