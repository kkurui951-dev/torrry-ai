const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID, 10);

if (!BOT_TOKEN || !ADMIN_CHAT_ID || isNaN(ADMIN_CHAT_ID)) {
  console.error('❌ Missing or invalid BOT_TOKEN or ADMIN_CHAT_ID in environment variables.');
  process.exit(1);
}

// ── Express ──
const app = express();
app.use(express.json({ limit: '10kb' })); // prevent oversized payloads
app.use(express.static(path.join(__dirname, 'public')));

// ── HTTP Server + WebSocket ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ── In-memory store: orderId → { category, label, price, odds, ws, createdAt } ──
const orders = new Map();
const ORDER_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup of expired orders
setInterval(() => {
  const now = Date.now();
  for (const [id, order] of orders) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      if (order.ws && order.ws.readyState === WebSocket.OPEN) {
        order.ws.send(JSON.stringify({ type: 'expired', orderId: id }));
        order.ws.close(1000);
      }
      orders.delete(id);
      console.log(`🗑️ Order ${id} expired and cleaned up.`);
    }
  }
}, 60 * 1000); // check every minute

// ── WebSocket: track which socket belongs to which order ──
wss.on('connection', (ws) => {
  let boundOrderId = null;

  ws.on('message', (data) => {
    try {
      const { orderId } = JSON.parse(data.toString());
      if (orders.has(orderId)) {
        // If there's an old socket, close it
        const order = orders.get(orderId);
        if (order.ws && order.ws !== ws && order.ws.readyState === WebSocket.OPEN) {
          order.ws.close(1000);
        }
        order.ws = ws;
        boundOrderId = orderId;
      }
    } catch (e) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    // Clean up reference if this socket was the active one
    if (boundOrderId && orders.has(boundOrderId)) {
      const order = orders.get(boundOrderId);
      if (order.ws === ws) {
        order.ws = null;
      }
    }
  });

  ws.on('error', () => {
    if (boundOrderId && orders.has(boundOrderId)) {
      const order = orders.get(boundOrderId);
      if (order.ws === ws) {
        order.ws = null;
      }
    }
  });
});

// ── Telegram Bot (polling mode) ──
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('message', (msg) => {
  // 🔒 Only accept messages from the admin
  if (msg.from.id !== ADMIN_CHAT_ID) return;

  const text = (msg.text || '').trim();
  const parts = text.split(/\s+/);

  if (parts.length >= 2 && orders.has(parts[0])) {
    const order = orders.get(parts[0]);
    const odds = parts.slice(1).join(' ');

    // Push result to user's browser via WebSocket
    if (order.ws && order.ws.readyState === WebSocket.OPEN) {
      order.ws.send(JSON.stringify({
        type: 'result',
        orderId: parts[0],
        odds,
        category: order.category,
        label: order.label
      }));
    }

    // Confirm to admin
    bot.sendMessage(ADMIN_CHAT_ID, `✅ Order ${parts[0]} delivered.\nOdds sent: ${odds}`);
    orders.delete(parts[0]);
  } else if (text === '/start') {
    bot.sendMessage(msg.chat.id,
      '👋 LegitOdds Admin Bot\n\n' +
      'When a user places an order, you\'ll see it here.\n' +
      'Reply with: ORDER_ID ODDS\n\n' +
      'Example: K7X2FA 45'
    );
  }
});

// ── API: Create Order ──
app.post('/api/create-order', (req, res) => {
  const { category, label, price, odds, paymentMessage } = req.body;

  if (!category || !label || !price || !odds || !paymentMessage) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Basic validation
  const safePrice = parseInt(price, 10);
  if (isNaN(safePrice) || safePrice <= 0) {
    return res.status(400).json({ error: 'Invalid price' });
  }

  // Sanitize: truncate payment message to stay under Telegram's 4096 limit
  const safeMsg = String(paymentMessage).substring(0, 4000);

  // Generate short order ID (6 chars, no ambiguous chars)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let orderId = '';
  for (let i = 0; i < 6; i++) {
    orderId += chars[Math.floor(Math.random() * chars.length)];
  }

  orders.set(orderId, {
    category: String(category).substring(0, 100),
    label: String(label).substring(0, 100),
    price: safePrice,
    odds: String(odds).substring(0, 50),
    ws: null,
    createdAt: Date.now()
  });

  // Notify admin via Telegram
  const adminMsg =
    `🆕 NEW ORDER: ${orderId}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `Category: ${String(category).substring(0, 100)}\n` +
    `Type: ${String(label).substring(0, 100)}\n` +
    `Price: KSh ${safePrice.toLocaleString()}\n` +
    `Odds: ${String(odds).substring(0, 50)}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💬 Payment Message:\n${safeMsg}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `Reply with: ${orderId} <odds to send>`;

  bot.sendMessage(ADMIN_CHAT_ID, adminMsg).catch(err =>
    console.error('Failed to notify admin:', err.message)
  );

  res.json({ orderId });
});

// ── Health check (Render) ──
app.get('/healthz', (_req, res) => res.sendStatus(200));

// ── Graceful shutdown (Render SIGTERM) ──
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
    bot.stopPolling();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`✅ LegitOdds server running on port ${PORT}`);
  console.log(`🤖 Telegram bot polling started (admin: ${ADMIN_CHAT_ID})`);
});   
