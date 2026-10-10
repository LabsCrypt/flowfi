import { Router } from 'express';
import { notificationService } from '../../services/notification.service.js';

export const notificationsRouter = Router();

notificationsRouter.post('/subscribe', async (req, res) => {
  try {
    const result = await notificationService.subscribeWebPush(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/unsubscribe', async (req, res) => {
  try {
    await notificationService.unsubscribeWebPush(req.body.address, req.body.endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/link-code', async (req, res) => {
  try {
    const result = await notificationService.generateLinkCode(req.body.address);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/telegram/link', async (req, res) => {
  try {
    const result = await notificationService.linkTelegram(req.body.code, req.body.chatId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/discord', async (req, res) => {
  try {
    const result = await notificationService.setDiscordWebhook(
      req.body.address,
      req.body.webhookUrl,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});
