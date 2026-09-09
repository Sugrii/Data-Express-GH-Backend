const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL }));

// Webhook endpoint requires raw body for HMAC verification
app.post('/api/paystack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(req.body)
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(400).send('Invalid webhook signature');
        }

        const event = JSON.parse(req.body.toString());

        // Process successful payment
        if (event.event === 'charge.success') {
            const metadata = event.data.metadata;
            const recipientPhone = metadata.recipient_phone;
            const network = metadata.network; // e.g., 'MTN', 'VODAFONE', 'AIRTELTIGO'
            const packageId = metadata.package_id;
            const orderRef = event.data.reference;

            // Dispatch Airtime / Data via Hubtel Direct Topup API
            await dispatchHubtelData({
                recipientPhone,
                network,
                packageId,
                orderRef,
                amount: event.data.amount / 100
            });
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook Error:', error.message);
        res.status(500).send('Server Error');
    }
});

// JSON Parser for standard API routes
app.use(express.json());

// 1. Initialize Paystack Transaction
app.post('/api/checkout/initialize', async (req, res) => {
    const { email, amount, recipientPhone, network, packageId } = req.body;

    try {
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email,
                amount: Math.round(amount * 100), // Paystack expects amount in pesewas
                currency: 'GHS',
                callback_url: `${process.env.FRONTEND_URL}/index.html`,
                metadata: {
                    recipient_phone: recipientPhone,
                    network,
                    package_id: packageId,
                    custom_fields: [
                        { display_name: "Recipient Phone", variable_name: "recipient_phone", value: recipientPhone },
                        { display_name: "Network Provider", variable_name: "network", value: network }
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.status(200).json({
            success: true,
            authorization_url: response.data.data.authorization_url,
            reference: response.data.data.reference
        });
    } catch (error) {
        console.error('Paystack Init Error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'Payment initialization failed' });
    }
});

// 2. Hubtel Data/Airtime Dispatch Function
async function dispatchHubtelData({ recipientPhone, network, packageId, orderRef, amount }) {
    const authHeader = Buffer.from(`${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`).toString('base64');

    // Format phone to 233 format
    let formattedPhone = recipientPhone.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '233' + formattedPhone.slice(1);
    }

    try {
        const payload = {
            PrimaryCallbackUrl: `${process.env.FRONTEND_URL}/api/hubtel-callback`,
            SecondaryCallbackUrl: `${process.env.FRONTEND_URL}/api/hubtel-callback`,
            ClientReference: orderRef,
            RecipientPhoneNumber: formattedPhone,
            Amount: amount,
            NetworkProvider: network.toUpperCase(), // e.g. MTN, VODAFONE, AIRTELTIGO
            POSSalesID: process.env.HUBTEL_POS_SALES_ID
        };

        const response = await axios.post(
            'https://api.hubtel.com/v1/merchantaccount/merchants/' + process.env.HUBTEL_POS_SALES_ID + '/prepaid/topup',
            payload,
            {
                headers: {
                    Authorization: `Basic ${authHeader}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`Hubtel Dispatch Success [${orderRef}]:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`Hubtel Dispatch Failed [${orderRef}]:`, error.response?.data || error.message);
        throw error;
    }
}

// 3. Verify Order Status Endpoint (for tracking)
app.get('/api/orders/track/:reference', async (req, res) => {
    const { reference } = req.params;

    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
                }
            }
        );

        res.status(200).json({
            status: response.data.data.status,
            gateway_response: response.data.data.gateway_response,
            amount: response.data.data.amount / 100,
            paid_at: response.data.data.paid_at,
            metadata: response.data.data.metadata
        });
    } catch (error) {
        res.status(404).json({ success: false, message: 'Order reference not found' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`DataExpress Ghana Backend running on port ${PORT}`));