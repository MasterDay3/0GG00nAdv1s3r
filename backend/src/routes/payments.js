// Dueboard Prep: the demo checkout.
import { randomBytes } from 'node:crypto';
import { PREMIUM, TEST_CARDS, MINUTE } from '../constants.js';
import { createLimiter } from '../lib/limiter.js';
import { DAY, HOUR } from '../lib/urgency.js';
import { HttpError } from '../lib/validate.js';

export function paymentRoutes(ctx) {
  const { now, route, one, all, run, guard } = ctx;

  const paymentView = (p) => ({
    id: p.id, orderRef: p.order_ref, amount: p.amount / 100, status: p.status, cardLast4: p.card_last4,
    reason: p.reason, createdAt: p.created_at, paidAt: p.paid_at, activeUntil: p.active_until,
  });

  route('GET', '/api/payments', ({ user }) =>
    all('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id).map(paymentView));

  // An order for one package. Unpaid orders older than a day are dropped, so the list stays short.
  const orderLimit = createLimiter({ limit: 20, windowMs: 60 * MINUTE, now });
  route('POST', '/api/payments', ({ user, res }) => {
    run("DELETE FROM payments WHERE user_id = ? AND status = 'pending' AND created_at < ?", user.id, now() - DAY);
    // Opening the checkout again (a reload, Back) continues the same unpaid order instead of starting a new one.
    const open = one("SELECT * FROM payments WHERE user_id = ? AND status = 'pending' AND created_at > ? ORDER BY id DESC LIMIT 1", user.id, now() - HOUR);
    if (open) return paymentView(open);
    guard(res, [orderLimit, `u${user.id}`]);
    orderLimit.hit(`u${user.id}`);
    const orderRef = `DB-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const { lastInsertRowid } = run(
      "INSERT INTO payments (user_id, order_ref, amount, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      user.id, orderRef, PREMIUM.price * 100, now(),
    );
    return paymentView(one('SELECT * FROM payments WHERE id = ?', lastInsertRowid));
  });

  // The demo "bank": the page says which test card was used; a paid order adds 30 days (on top of time left, if any).
  route('POST', '/api/payments/:id/pay', ({ user, params, body }) => {
    const payment = one('SELECT * FROM payments WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!payment) throw new HttpError(404, 'Замовлення не знайдено');
    if (payment.status !== 'pending') throw new HttpError(409, 'Це замовлення вже оброблено. Почніть нове.');
    const card = Object.hasOwn(TEST_CARDS, body.card) ? TEST_CARDS[body.card] : null;
    if (!card) throw new HttpError(400, 'Це демо-оплата: приймаються лише тестові картки.');
    if (!card.ok) {
      run("UPDATE payments SET status = 'declined', card_last4 = ?, reason = ? WHERE id = ?", card.last4, card.reason, payment.id);
    } else {
      const fresh = one('SELECT premium_until FROM users WHERE id = ?', user.id);
      const until = Math.max(now(), fresh.premium_until || 0) + PREMIUM.days * DAY;
      run('UPDATE users SET premium_until = ? WHERE id = ?', until, user.id);
      run("UPDATE payments SET status = 'paid', card_last4 = ?, paid_at = ?, active_until = ? WHERE id = ?", card.last4, now(), until, payment.id);
    }
    return paymentView(one('SELECT * FROM payments WHERE id = ?', payment.id));
  });
}
