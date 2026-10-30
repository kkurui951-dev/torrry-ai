const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Your Telegram chat ID (number)

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error('❌ Missing BOT_TOKEN or ADMIN_CHAT_ID in environment variables.');
  process.exit(1);
}

// ── Express ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HTTP Server + WebSocket (same port for Render) ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ── In-memory store: orderId → { user, category, label, price, odds, ws } ──
const orders = new Map();

// ── WebSocket: track which socket belongs to which order ──
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const { orderId } = JSON.parse(data);
      if (orders.has(orderId)) {
        orders.get(orderId).ws = ws;
      }
    } catch (e) { /* ignore malformed */ }
  });
});

// ── Telegram Bot (polling mode) ──
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// When admin sends a message to the bot (e.g. "ABC123 45")
bot.on('message', (msg) => {
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
    bot.sendMessage(msg.chat.id, '👋 This is the LegitOdds admin bot.\n\nWhen a user places an order, you\'ll see it here.\nReply with: ORDER_ID ODDS\n\nExample: ABC123 45');
  }
});

// ── API: Create Order ──
app.post('/api/create-order', (req, res) => {
  const { category, label, price, odds, paymentMessage } = req.body;

  if (!category || !label || !price || !odds || !paymentMessage) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Generate short order ID
  const orderId = Math.random().toString(36).substring(2, 8).toUpperCase();
  orders.set(orderId, { category, label, price, odds, ws: null });

  // Notify admin via Telegram
  const adminMsg =
    `🆕 NEW ORDER: ${orderId}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `Category: ${category}\n` +
    `Type: ${label}\n` +
    `Price: KSh ${Number(price).toLocaleString()}\n` +
    `Odds: ${odds}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💬 Payment Message:\n${paymentMessage}\n` +
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
    wss.clients.forEach(ws => ws.close(1001));
    bot.stopPolling();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`✅ LegitOdds server running on port ${PORT}`);
  console.log(`🤖 Telegram bot polling started`);
});   
