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

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const orders = new Map();
const ORDER_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, order] of orders) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      if (order.ws && order.ws.readyState === WebSocket.OPEN) {
        order.ws.send(JSON.stringify({ type: 'expired', orderId: id }));
        order.ws.close(1000);
      }
      orders.delete(id);
      console.log(`🗑️ Order ${id} expired.`);
    }
  }
}, 60 * 1000);

wss.on('connection', (ws) => {
  let boundOrderId = null;

  ws.on('message', (data) => {
    try {
      const { orderId } = JSON.parse(data.toString());
      if (orders.has(orderId)) {
        const order = orders.get(orderId);
        if (order.ws && order.ws !== ws && order.ws.readyState === WebSocket.OPEN) {
          order.ws.close(1000);
        }
        order.ws = ws;
        boundOrderId = orderId;
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (boundOrderId && orders.has(boundOrderId)) {
      const order = orders.get(boundOrderId);
      if (order.ws === ws) order.ws = null;
    }
  });

  ws.on('error', () => {
    if (boundOrderId && orders.has(boundOrderId)) {
      const order = orders.get(boundOrderId);
      if (order.ws === ws) order.ws = null;
    }
  });
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('message', (msg) => {
  if (msg.from.id !== ADMIN_CHAT_ID) return;

  const text = (msg.text || '').trim();
  const parts = text.split(/\s+/);

  if (parts.length >= 2 && orders.has(parts[0])) {
    const order = orders.get(parts[0]);
    const odds = parts.slice(1).join(' ');

    if (order.ws && order.ws.readyState === WebSocket.OPEN) {
      order.ws.send(JSON.stringify({
        type: 'result',
        orderId: parts[0],
        odds,
        category: order.category,
        label: order.label
      }));
    }

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

app.post('/api/create-order', (req, res) => {
  const { category, label, price, odds, paymentMessage } = req.body;

  if (!category || !label || !price || !odds || !paymentMessage) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const safePrice = parseInt(price, 10);
  if (isNaN(safePrice) || safePrice <= 0) {
    return res.status(400).json({ error: 'Invalid price' });
  }

  const safeMsg = String(paymentMessage).substring(0, 4000);

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

app.get('/healthz', (_req, res) => res.sendStatus(200));

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  server.close(() => {
    wss.clients.forEach(ws => ws.close(1001));
    bot.stopPolling();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});

server.listen(PORT, () => {
  console.log(`✅ LegitOdds running on port ${PORT}`);
  console.log(`🤖 Bot polling started (admin: ${ADMIN_CHAT_ID})`);
});   
