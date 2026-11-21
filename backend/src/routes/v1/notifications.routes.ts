import { Router, type Response } from 'express';
import { notificationService } from '../../services/notification.service.js';
import { requireAuth } from '../../middleware/auth.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';

/**
 * Notification channel routes.
 *
 * Every route here acts on a wallet's notification settings, so every route
 * requires the wallet's own session (#1855). Before this, `/link-code` took
 * `req.body.address` from the body and returned the verification code in the
 * response, so anyone could mint a code for anyone's wallet, read the code out
 * of their own HTTP response, and attach their own Telegram chat to a stranger's
 * stream notifications. `linkTelegram`, `setDiscordWebhook` and the web-push
 * endpoints trusted the body the same way.
 *
 * The address is now the authenticated one; a body that names a different
 * address is refused rather than silently ignored, so a client that sends one
 * by mistake learns about it.
 */
export const notificationsRouter = Router();

function sessionAddress(req: AuthenticatedRequest): string | null {
  const address = req.user?.publicKey;
  return typeof address === 'string' && address.length > 0 ? address : null;
}

/** 401 when the session has no wallet, 403 when it names a different one. */
function claimedAddress(req: AuthenticatedRequest, res: Response): string | null {
  const session = sessionAddress(req);
  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  const claimed = req.body?.address;
  if (typeof claimed === 'string' && claimed !== session) {
    res.status(403).json({ error: 'Address does not match the authenticated wallet' });
    return null;
  }

  return session;
}

notificationsRouter.post('/subscribe', requireAuth, async (req, res) => {
  const address = claimedAddress(req as AuthenticatedRequest, res);
  if (!address) return;
  try {
    const result = await notificationService.subscribeWebPush({ ...req.body, address });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/unsubscribe', requireAuth, async (req, res) => {
  const address = claimedAddress(req as AuthenticatedRequest, res);
  if (!address) return;
  try {
    await notificationService.unsubscribeWebPush(address, req.body.endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/link-code', requireAuth, async (req, res) => {
  const address = claimedAddress(req as AuthenticatedRequest, res);
  if (!address) return;
  try {
    const result = await notificationService.generateLinkCode(address);
    // The code goes to the operator's own channel, never back to the caller
    // (#1855): returning it made the second factor meaningless, because the
    // same request could attach a chat it controlled.
    res.status(201).json({ address: result.address, expiresAt: result.expiresAt });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/telegram/link', requireAuth, async (req, res) => {
  try {
    const result = await notificationService.linkTelegram(req.body.code, req.body.chatId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});

notificationsRouter.post('/discord', requireAuth, async (req, res) => {
  const address = claimedAddress(req as AuthenticatedRequest, res);
  if (!address) return;
  try {
    const result = await notificationService.setDiscordWebhook(address, req.body.webhookUrl);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bad request' });
  }
});
