const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const Web3 = require("web3");
const axios = require("axios").default;
const Bottleneck = require("bottleneck");
const cmpdTokenSymbols = require("./compoundTokens");
const ERC20ABI = require("./data/erc20ABI");
const cERC20ABI = require("./data/cERC20");
const cETHABI = require("./data/cETH");
const compoundContracts = require("./data/compoundContracts.json");
const BigNumber = require("bignumber.js");
const etherscanAPIKey = "WKBMNJ4SNUP1QCUY6E8CJEZ3JCJNUJI5AR";
const coinmarketKey = "2cb6535e-4766-4c8b-9202-13913cddde89";
const amberKey = "UAK55ce920d969018431af2164bb7187233";
const { isToday } = require("date-fns");
const CryptoJS = require("crypto-js");

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

function chunk(array, size) {
  const chunked_arr = [];
  let index = 0;
  while (index < array.length) {
    chunked_arr.push(array.slice(index, size + index));
    index += size;
  }
  return chunked_arr;
}

const convertEth = (amount, decimals) => {
  const power = new BigNumber("10");
  return amount.dividedBy(power.exponentiatedBy(decimals));
};

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
    .doc(token.toUpperCase())
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
  try {
    const url = `https://web3api.io/api/v2/addresses/${address}/tokens`;

    const result = await axios.get(url, {
      headers: { "x-api-key": amberKey }
    });

    return result.data.payload.records.filter(token => {
      const idx = cmpdTokenSymbols.indexOf(token.symbol);
      return idx === -1 && token.amount !== "0";
    });
  } catch (error) {
    console.log("ERROR", error);
    throw error;
  }
};

const getTotalBalance = async (address, tokens, cTokens) => {
  const tokenValues = tokens.map(token => tokenValueInUSD(token));
  const cTokenValues = cTokens.map(compoundValueInUSD);

  const promises = [
    Promise.all(tokenValues),
    web3.eth.getBalance(address),
    getEtheruemValueInUSD()
  ];

  const [tokensInUSD, ethInWei, ethInUSD] = await Promise.all(promises);

  const eth = web3.utils.fromWei(ethInWei);

  return (
    tokensInUSD.reduce((acc, curr) => (acc += curr), eth * ethInUSD) +
    cTokenValues.reduce((acc, curr) => (acc += curr), 0)
  );
};

const compoundValueInUSD = token => {
  return convertEth(new BigNumber(token.balance), token.decimals) * token.inUSD;
};

const compoundETH = async (address, wallet) => {
  const Contract = new web3.eth.Contract(cETHABI, address);

  const [symbol, balance] = await Promise.all([
    Contract.methods.symbol().call(),
    Contract.methods.balanceOfUnderlying(wallet).call()
  ]);

  const inUSD = await getEtheruemValueInUSD();

  return {
    symbol,
    decimals: 18,
    balance,
    address,
    inUSD
  };
};

const getTokenInUSD = async token => {
  const result = await db
    .collection("market")
    .doc(token)
    .get();

  if (result.exists) {
    return result.data().value;
  }

  throw new Error("Token does not exist in DB");
};

const compoundERC20 = async (address, wallet) => {
  const Contract = new web3.eth.Contract(cERC20ABI, address);

  const [symbol, balance, underlying] = await Promise.all([
    Contract.methods.symbol().call(),
    Contract.methods.balanceOfUnderlying(wallet).call(),
    Contract.methods.underlying().call()
  ]);

  try {
    const Underlying = new web3.eth.Contract(ERC20ABI, underlying);
    const decimals = await Underlying.methods.decimals().call();

    const inUSD = await getTokenInUSD(symbol.slice(1));

    return {
      symbol,
      decimals,
      address,
      balance,
      inUSD
    };
  } catch (error) {
    console.log(symbol, underlying);
    console.log(error.message);
    return null;
  }
};

const compoundActiveMarkets = async (cMarkets, wallet) => {
  const cETH = "0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5";

  const addresses = [];
  for (const key in cMarkets) {
    addresses.push(key);
  }
  const result = await Promise.all(
    addresses.map(async address => {
      const isEth = address === cETH;
      return isEth
        ? compoundETH(address, wallet)
        : compoundERC20(address, wallet);
    })
  );
  return result.filter(market => market.balance !== "0");
};

/**
 * FUNCTIONS
 */

app.post("/encrypt-wyre-token", async (req, res) => {
  const key = functions.config().encryption.key;

  const { type, userId, accountType } = req.body;

  const account = accountType || "users";

  const token = CryptoJS.AES.encrypt(req.body.token, key).toString();

  await admin
    .firestore()
    .collection(account)
    .doc(userId)
    .update({ [type === "BANK" ? "wyreBankToken" : "wyreCardToken"]: token });

  res.end();
});

app.post("/decrypt-wyre-token", async (req, res) => {
  const key = functions.config().encryption.key;

  const { userId, type, accountType } = req.body;

  const account = accountType || "users";

  const result = await admin
    .firestore()
    .collection(account)
    .doc(userId)
    .get();

  const token = type === "BANK" ? "wyreBankToken" : "wyreCardToken";

  const bytes = CryptoJS.AES.decrypt(result.data()[token], key);

  const decryptedToken = bytes.toString(CryptoJS.enc.Utf8);

  res.json({ wyreToken: decryptedToken });

  res.end();
});

exports.api = functions.https.onRequest(app);

exports.removeUser = functions.auth.user().onDelete(async user => {
  try {
    await db
      .collection("users")
      .doc(user.uid)
      .delete();
    await db
      .collection("merchants")
      .doc(user.uid)
      .delete();

    return `${user.uid} deleted.`;
  } catch (error) {
    console.log("DELETE ERROR", error);
    return error.message;
  }
});

// exports.updateContractABIs = functions
//   .runWith({ timeoutSeconds: 540 })
//   .pubsub.schedule("31 * 1 * *")
//   .timeZone("America/New_York")
//   .onRun(async () => {
//     const limiter = new Bottleneck({
//       maxConcurrent: 1,
//       minTime: 120
//     });

//     const tokens = await db.collection("market").get();

//     const promises = tokens.docs.map(doc => {
//       const address = doc.data().address;
//       if (address) {
//         return limiter.schedule(async () => {
//           const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}&apikey=${etherscanAPIKey}`;

//           const contractABI = await axios.get(url);
//           return db
//             .collection("contracts")
//             .doc(address)
//             .set({ abi: contractABI.data.result });
//         });
//       }
//     });
//     const result = await Promise.all(promises);
//     console.log("SUCCESS", result);
//     return result;
//   });

// exports.subscribeToBlockChanges = functions.pubsub
//   .schedule("*/1 * * * *")
//   .timeZone("America/New_York")
//   .onRun(async () => {
//     try {
//       const subscription = await wssWeb3.eth.subscribe(
//         "newBlockHeaders",
//         (error, data) => {
//           if (error) {
//             console.log("ERROR", error);
//             return error;
//           }
//           return data;
//         }
//       );
//       subscription.on("error", error => {
//         console.log(error);
//       });
//       subscription.on("data", async data => {
//         console.log("DATA", data);
//         const block = await wssWeb3.eth.getBlock(data.number);
//         console.log("NEW BLOCK MINED", block.number);
//         if (block && block.transactions) {
//           console.log(block.transactions.length, "TXs found");
//           block.transactions.forEach(async function(e) {
//             console.log(e.to, e.from);
//             // const from = await db
//             //   .collection("users")
//             //   .where("address", "==", e.from)
//             //   .get();
//             // const to = await db
//             //   .collection("users")
//             //   .where("address", "==", e.to)
//             //   .get();

//             // if (from.size !== 0) {
//             //   console.log("SENT TX FOUND", e);
//             //   await db
//             //     .collection("users")
//             //     .doc(from.docs[0].id)
//             //     .collection("transactions")
//             //     .doc(e.hash)
//             //     .set(e);
//             // } else if (to.size !== 0) {
//             //   console.log("RECEIVED TX FOUND", e);
//             //   await db
//             //     .collection("users")
//             //     .doc(to.docs[0].id)
//             //     .collection("transactions")
//             //     .doc(e.hash)
//             //     .set(e);
//             // }
//           });
//         }
//       });

//       setTimeout(() => {
//         subscription.subscription.unsubscribe((err, success) => {
//           if (success) {
//             console.log("UNSUBSCRIBED");
//           }
//           if (err) {
//             console.log("ERROR", err);
//           }
//         });
//       }, 60000);
//     } catch (error) {
//       console.log("BLOCK ERROR", error.message);
//     }
//   });

// .schedule("*/15 * * * *")
exports.updateMarketPrices = functions.pubsub
  .schedule("2 */1 * * *")
  .timeZone("America/New_York")
  .onRun(async context => {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?cryptocurrency_type=tokens&limit=1998`;
    const config = { headers: { "X-CMC_PRO_API_KEY": coinmarketKey } };

    const ethUrl = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=ETH`;
    const thetaUrl = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=THETA`;

    const [eth, theta, tokens] = await Promise.all([
      axios.get(ethUrl, config),
      axios.get(thetaUrl, config),
      axios.get(url, config)
    ]);

    const tokenRecords = tokens.data.data
      .map(token => ({
        value: token.quote.USD.price,
        address: token.platform && token.platform.token_address,
        symbol: token.symbol,
        change1h: token.quote.USD.percent_change_1h,
        change24h: token.quote.USD.percent_change_24h,
        change7d: token.quote.USD.percent_change_7d,
        updatedAt: new Date().toISOString()
      }))
      .filter((token, idx, arr) => {
        const elementIdx = arr.map(t => t.symbol).indexOf(token.symbol);
        return elementIdx === idx;
      });

    const batches = chunk(tokenRecords, 490);

    const batchMap = batches.map((chunk, idx) => {
      console.log("CHUNK", chunk.length);
      const batch = db.batch();

      chunk.forEach(token => {
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
          change7d: eth.data.data.ETH.quote.USD.percent_change_7d,
          updatedAt: new Date().toISOString()
        });

        const thetaRef = db.collection("market").doc("THETA");

        batch.set(thetaRef, {
          value: theta.data.data.THETA.quote.USD.price,
          symbol: theta.data.data.THETA.symbol,
          change1h: theta.data.data.THETA.quote.USD.percent_change_1h,
          change24h: theta.data.data.THETA.quote.USD.percent_change_24h,
          change7d: theta.data.data.THETA.quote.USD.percent_change_7d,
          updatedAt: new Date().toISOString()
        });
      }

      return batch;
    });

    const promises = batchMap.map(
      batch =>
        new Promise((resolve, reject) => {
          setTimeout(async () => {
            try {
              await batch.commit();
              resolve();
            } catch (error) {
              reject(error);
            }
          }, 1250);
        })
    );

    try {
      const result = await Promise.all(promises);
      console.log(`BATCH SUCCESS: Updated ${tokenRecords.length + 1} records`);

      return result;
    } catch (error) {
      throw error;
    }
  });

// Update long term history, once daily
exports.updateLongTermHistory = functions.pubsub
  .schedule("0 3 * * *")
  .timeZone("America/New_York")
  .onRun(async context => {
    const users = await db.collection("users").get();

    const promises = users.docs.map(async snap => {
      const wallet = snap.data().address;
      const tokens = await getERC20Tokens(wallet);
      const cTokens = await compoundActiveMarkets(snap.data().cMarkets, wallet);
      const balance = await getTotalBalance(wallet, tokens, cTokens);
      const date = new Date().toISOString();
      const timestamp = Date.now().toString();

      return db
        .collection("users")
        .doc(snap.id)
        .collection("history")
        .doc(timestamp)
        .set({
          date,
          balance
        });
    });

    const records = await Promise.all(promises);
    console.log(
      `Update Long-term History Success, ${records.length} users updated`
    );
    return records;
  });

// Update daily history every 5 minutes
exports.updateShortTermHistory = functions.pubsub
  .schedule("*/5 * * * *")
  .timeZone("America/New_York")
  .onRun(async () => {
    const users = await db.collection("users").get();

    const promises = users.docs.map(async snap => {
      const wallet = snap.data().address;
      const tokens = await getERC20Tokens(wallet);
      const cTokens = await compoundActiveMarkets(snap.data().cMarkets, wallet);
      const balance = await getTotalBalance(wallet, tokens, cTokens);
      const date = new Date().toISOString();
      const timestamp = Date.now().toString();
      return db
        .collection("users")
        .doc(snap.id)
        .collection("daily")
        .doc(timestamp)
        .set({
          date,
          balance
        });
    });
    const records = await Promise.all(promises);
    console.log(
      `Update Short-term History Success, ${records.length} users updated`
    );
    return records;
  });

// Every other day at 3 EST, remove the last 1440 daily records
exports.removeShortTermHistory = functions.pubsub
  .schedule("0 3 */2 * *")
  // .schedule("*/1 * * * *")
  .timeZone("America/New_York")
  .onRun(async () => {
    const users = await db.collection("users").get();

    // [[]];
    const userChunks = users.docs.map(async snap => {
      const dailies = await db
        .collection("users")
        .doc(snap.id)
        .collection("daily")
        .get();

      const data = dailies.docs.filter(
        doc => !isToday(new Date(doc.data().date))
      );

      console.log("TOTAL DATAPOINTS", data.length);

      return chunk(data, 499).map(chunk => {
        const batch = db.batch();

        chunk.forEach(datapoint => {
          const ref = db
            .collection("users")
            .doc(snap.id)
            .collection("daily")
            .doc(datapoint.id);

          batch.delete(ref);
        });

        return batch;
      });
    });

    const limiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 50
    });

    const userBatches = await Promise.all(userChunks);

    console.log("BATCHES", userBatches);

    const result = await Promise.all(
      userBatches.map(batches =>
        batches.map(batch => {
          if (batch) {
            console.log("BATCH", batch);
            return limiter.schedule(() => batch.commit());
          }
          return null;
        })
      )
    );

    console.log(`Remove short-term success`);
    console.log(result);
    return true;
  });
