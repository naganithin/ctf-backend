const { admin, cert } = require("firebase-admin/app");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { collection, addDoc } = require("firebase/firestore");
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
var cors = require('cors');
const serviceAccount = require("./serviceAccountKey.json");
require('dotenv').config();


initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.DATABASE_URL
});
console.log(process.env.DATABASE_URL);
const db = getFirestore();
const app = express();
const port = 3000;

app.use(bodyParser.json());
const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],  // Allow these methods
    allowedHeaders: ['Content-Type', 'Authorization'],  // Allow these headers
};

app.use(cors(corsOptions));

async function createContact(contactData) {
    try {
        const response = await axios.post('https://api.razorpay.com/v1/contacts', contactData, {
            auth: {
                username: process.env.RZP_USERNAME,
                password: process.env.RZP_PASSWORD,
            }
        });
        return response.data.id;
    } catch (error) {
        console.error('Error creating contact:', error);
        throw error;
    }
}

async function createFundAccount(contact_id, vpaAddress) {
    try {
        const response = await axios.post('https://api.razorpay.com/v1/fund_accounts', {
            contact_id: contact_id,
            account_type: 'vpa', 
            vpa: {
                address: vpaAddress
            }
        }, {
            auth: {
                username: process.env.RZP_USERNAME,
                password: process.env.RZP_PASSWORD,
            }
        });
        return response.data.id;
    } catch (error) {
        console.error('Error creating fund account:', error);
        throw error;
    }
}

async function main(contactData, vpaAddress,address) {
    try {
        const contact_id = await createContact(contactData);
        console.log('Contact created with ID:', contact_id);

        const fund_account_id = await createFundAccount(contact_id, vpaAddress);
        console.log('Fund account created with ID:', fund_account_id);

        const data = {
            name: contactData.name,
            email: contactData.email,
            phone: contactData.contact,
            razorpay_contact_id: contact_id,
            razorpay_fund_account_id: fund_account_id,
            vpaAddress: vpaAddress,
            address: address
        };
        const phone = JSON.stringify(contactData.contact);
        const result = await db.collection('userdata').doc(phone).set(data);

        return fund_account_id;
    } catch (error) {
        console.error('Error in the process:', error);
        throw error;
    }
}

async function createPayout(fund_account_id,adjustedAmount) {
    try {
        const response = await axios.post('https://api.razorpay.com/v1/payouts', {
            account_number: "2323230000118276",
            fund_account_id: fund_account_id,
            amount: adjustedAmount,
            currency: "INR",
            mode: "UPI",
            purpose: "refund",
            queue_if_low_balance: true,
            reference_id: "test",
            narration: "test",
            notes: {
                notes_key_1: "test",
                notes_key_2: "test"
            }
        }, {
            auth: {
                username: process.env.RZP_USERNAME,
                password: process.env.RZP_PASSWORD,
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error creating payout:', error);
        throw error;
    }
}



async function adjustAmountWithExchangeRate(amount) {
    try {
        const response = await axios.get(`https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_API}/pair/USD/INR/${amount}`);
        const conversionResult = parseInt(response.data.conversion_result);

        if (conversionResult >= 0 && conversionResult <= 10000) {
            return parseInt((conversionResult - (conversionResult * 0.03))*100);
        } else if (conversionResult >= 10000 && conversionResult <= 99999) {
            return parseInt((conversionResult - (conversionResult * 0.02))* 100);
        } else if (conversionResult > 100000) {
            return parseInt((conversionResult - (conversionResult * 0.015))* 100);
        } else {
            throw new Error('Invalid conversion result');
        }
    } catch (error) {
        console.error('Error adjusting amount with exchange rate:', error);
        throw error;
    }
}

async function payctf(phone, amount) {
    try {

        const adjustedAmount = await adjustAmountWithExchangeRate(amount);
        console.log('Adjusted amount:', adjustedAmount);

        const userDoc = await db.collection('userdata').doc(phone.toString()).get();

        if (!userDoc.exists) {
            console.log('No user found with the provided phone number');
            throw new Error('No user found with the provided phone number');
        }

        const userData = userDoc.data();
        const fund_account_id = userData.razorpay_fund_account_id;

        if (!fund_account_id) {
            throw new Error('Fund account ID not found for the user');
        }
        console.log(fund_account_id)

        const payout = await createPayout(fund_account_id, adjustedAmount);
        console.log('Payout created:', payout);

        // Assuming the response contains payout details in a predictable format
        const payoutDetails = payout; // Adjust this line based on actual response structure

        // Reference to the payouts collection
        const payoutDocRef = db.collection('payouts').doc(phone.toString());

        // Check if the document exists
        const payoutDoc = await payoutDocRef.get();

        if (payoutDoc.exists) {
            // If the document exists, update the payouts array
            await payoutDocRef.update({
                payouts: FieldValue.arrayUnion(payoutDetails)
            });
        } else {
            // If the document does not exist, create it with the payouts array
            await payoutDocRef.set({
                payouts: [payoutDetails]
            });
        }

        return payout;
    } catch (error) {
        console.error('Error in the process:', error);
        throw error;
    }
}

app.post('/create-contact', async (req, res) => {
    try {
        const contact_id = await createContact(req.body);
        res.json({ contact_id });
    } catch (error) {
        res.status(500).send('Error creating contact');
    }
});

app.post('/create-fund-account', async (req, res) => {
    try {
        const accountId = await createFundAccount(req.body);
        res.status(200).json({ message: 'Fund account created successfully', id: accountId });
    } catch (error) {
        res.status(500).json({ message: 'Failed to create fund account', error: error.message });
    }
});

app.post('/start-process', async (req, res) => {
    try {
        const { contactData, vpaAddress, address } = req.body;
        const result = await main(contactData, vpaAddress, address);
        res.json(result);
    } catch (error) {
        res.status(500).send('Error in the process');
    }
});

app.post('/create-payout', async (req, res) => {
    try {
        const { fund_account_id, adjustedAmount } = req.body;
        const payout = await createPayout( fund_account_id, adjustedAmount);
        res.json(payout);
    } catch (error) {
        res.status(500).send('Error creating payout');
    }
});

app.get('/adjust-amount', async (req, res) => {
    try {
        const { amount } = req.body;
        const adjustedAmount = await adjustAmountWithExchangeRate(amount);
        res.json({ adjustedAmount });
    } catch (error) {
        res.status(500).send('Error adjusting amount with exchange rate');
    }
});

app.get('/exchange-rate', async (req, res) => {
    const { amount } = req.query;

    if (!amount) {
        return res.status(400).json({ error: 'Amount is required' });
    }

    try {
        const response = await axios.get(`https://v6.exchangerate-api.com/v6/74ca8272aae924ccfbc55ff5/pair/USD/INR/${amount}`);
        const exchangeRate = response.data.conversion_result;
        res.json({ exchangeRate });
    } catch (error) {
        console.error('Error fetching exchange rate:', error);
        res.status(500).json({ error: 'Failed to fetch exchange rate' });
    }
});

app.post('/start-payctf-process', async (req, res) => {
    try {
        const {phone, amount } = req.body;
        const result = await payctf( phone, amount);
        res.json(result);
    } catch (error) {
        res.status(500).send('Error in the process');
    }
});

// Error handler middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});


app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

module.exports = app;