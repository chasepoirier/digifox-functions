const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const Web3 = require("web3");
const axios = require("axios").default;

const cmpdTokenSymbols = require("./compoundTokens");

const coinmarketKey = "2cb6535e-4766-4c8b-9202-13913cddde89";
const amberKey = "UAK55ce920d969018431af2164bb7187233";

const app = express();

const serviceAccount = {
  type: "service_account",
  project_id: functions.config().fb.project_id,
  private_key_id: functions.config().fb.private_id,
  private_key: functions.config().fb.private_key.replace(/\\n/g, "\n"),
  client_email: functions.config().fb.email,
  client_id: functions.config().fb.client_id,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: functions.config().fb.cert_url
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://digifox-7140d.firebaseio.com"
});

const db = admin.firestore();

const web3 = new Web3(
  new Web3.providers.HttpProvider(
    "https://mainnet.infura.io/v3/f4869a5c59cc495a8ed8e8c04e6ae28c"
  )
);

// Automatically allow cross-origin requests
app.use(cors({ origin: true }));

/**
 * WEB 3
 */

const getEtheruemValueInUSD = async () => {
  const value = await axios.get(
    "https://api.coinmarketcap.com/v1/ticker/ethereum/"
  );
  return value.data[0].price_usd;
};

const getUSDPrice = async token => {
  const result = await db
    .collection("market")
    .doc(token)
    .get();

  return result.data().value;
};

const tokenValueInUSD = async token => {
  const value = token.amount / Math.pow(10, token.decimals);
  const usdValue = await getUSDPrice(token.symbol);
  return value * usdValue;
};

const getERC20Tokens = async address => {
  // const address = "0x25F0b9e6AB89456909EcB0A54BC192A4666f05C3";
  const url = `https://web3api.io/api/v2/addresses/${address}/tokens`;

  const result = await axios.get(url, {
    headers: { "x-api-key": amberKey }
  });

  return result.data.payload.records.filter(token => {
    const idx = cmpdTokenSymbols.indexOf(token.symbol);
    return idx === -1 && token.amount !== "0";
  });
};

const getTotalBalance = async (address, tokens) => {
  const tokenValues = tokens.map(token => tokenValueInUSD(token));

  const promises = [
    Promise.all(tokenValues),
    web3.eth.getBalance(address),
    getEtheruemValueInUSD()
  ];

  const [tokensInUSD, ethInWei, ethInUSD] = await Promise.all(promises);

  const eth = web3.utils.fromWei(ethInWei);

  return tokensInUSD.reduce((acc, curr) => (acc += curr), eth * ethInUSD);
};

/**
 * FUNCTIONS
 */

exports.removeUser = functions.auth.user().onDelete(async user => {
  return await db
    .collection("users")
    .doc(user.uid)
    .delete();
});

exports.updateMarketPrices = functions.pubsub
  .schedule("*/15 * * * *")
  .timeZone("America/New_York")
  .onRun(async context => {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?cryptocurrency_type=tokens&limit=1998`;
    const config = { headers: { "X-CMC_PRO_API_KEY": coinmarketKey } };

    const ethUrl = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=ETH`;
    const thetaUrl = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=THETA`;

    const result = await axios.get(url, config);

    const [eth, theta, tokens] = await Promise.all([
      axios.get(ethUrl, config),
      axios.get(thetaUrl, config),
      axios.get(url, config)
    ]);

    const tokenRecords = tokens.data.data.map(token => ({
      value: token.quote.USD.price,
      symbol: token.symbol,
      change1h: token.quote.USD.percent_change_1h,
      change24h: token.quote.USD.percent_change_24h,
      change7d: token.quote.USD.percent_change_7d
    }));

    const batches = [
      tokenRecords.slice(0, 498),
      tokenRecords.slice(499, 998),
      tokenRecords.slice(999, 1498),
      tokenRecords.slice(1499, 1998)
    ];

    const batchMap = batches.map((slice, idx) => {
      const batch = db.batch();

      slice.forEach(token => {
        const tokenRef = db.collection("market").doc(token.symbol);
        batch.set(tokenRef, token);
      });

      if (idx === 0) {
        const ethRef = db.collection("market").doc("ETH");

        batch.set(ethRef, {
          value: eth.data.data.ETH.quote.USD.price,
          symbol: eth.data.data.ETH.symbol,
          change1h: eth.data.data.ETH.quote.USD.percent_change_1h,
          change24h: eth.data.data.ETH.quote.USD.percent_change_24h,
          change7d: eth.data.data.ETH.quote.USD.percent_change_7d
        });

        const thetaRef = db.collection("market").doc("THETA");

        batch.set(thetaRef, {
          value: theta.data.data.THETA.quote.USD.price,
          symbol: theta.data.data.THETA.symbol,
          change1h: theta.data.data.THETA.quote.USD.percent_change_1h,
          change24h: theta.data.data.THETA.quote.USD.percent_change_24h,
          change7d: theta.data.data.THETA.quote.USD.percent_change_7d
        });
      }

      return batch;
    });

    batchMap.forEach(batch => {
      setTimeout(async () => {
        await batch.commit();
      }, 1250);
    });

    console.log(`BATCH SUCCESS: Updated ${tokenRecords.length + 1} records`);

    return null;
  });

// Update long term history, once daily
exports.updateLongTermHistory = functions.pubsub
  .schedule("0 3 * * *")
  .timeZone("America/New_York")
  .onRun(async context => {
    const users = await db.collection("users").get();

    users.forEach(async snap => {
      const tokens = await getERC20Tokens(snap.data().address);
      const balance = await getTotalBalance(snap.data().address, tokens);
      const date = new Date().toISOString();
      const timestamp = Date.now().toString();

      db.collection("users")
        .doc(snap.id)
        .collection("history")
        .doc(timestamp)
        .set({
          date,
          balance
        });
    });
    return null;
  });

// Update daily history every 5 minutes
exports.updateShortTermHistory = functions.pubsub
  .schedule("*/5 * * * *")
  .timeZone("America/New_York")
  .onRun(async context => {
    const users = await db.collection("users").get();

    users.forEach(async snap => {
      const tokens = await getERC20Tokens(snap.data().address);
      const balance = await getTotalBalance(snap.data().address, tokens);
      const date = new Date().toISOString();
      const timestamp = Date.now().toString();
      db.collection("users")
        .doc(snap.id)
        .collection("daily")
        .doc(timestamp)
        .set({
          date,
          balance
        });
    });
    return null;
  });

// Every other day at 3 EST, remove the last 1440 daily records
exports.removeShortTermHistory = functions.pubsub
  .schedule("0 3 */2 * *")
  .timeZone("America/New_York")
  .onRun(async context => {
    const users = await db.collection("users").get();

    users.forEach(async snap => {
      const balanceInWei = await web3.eth.getBalance(snap.data().address);
      const balance = web3.utils.fromWei(balanceInWei);
      const date = new Date().toISOString();
      const timestamp = Date.now().toString();

      const dailies = await db
        .collection("users")
        .doc(snap.id)
        .collection("daily")
        .orderBy("date", "desc")
        .limit(1440)
        .get();

      dailies.forEach(daily => {
        db.collection("users")
          .doc(snap.id)
          .collection("daily")
          .doc(daily.id)
          .delete();
      });
    });
    return null;
  });
