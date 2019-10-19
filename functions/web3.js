const fetch = require("node-fetch");
const Web3 = require("web3");
const cmpdTokenSymbols = require("./compoundTokens");
const db = require("./firebase");

const web3 = new Web3(
  new Web3.providers.HttpProvider(
    "https://mainnet.infura.io/v3/f4869a5c59cc495a8ed8e8c04e6ae28c"
  )
);

const amberKey = "UAK55ce920d969018431af2164bb7187233";
const coinmarketKey = "2cb6535e-4766-4c8b-9202-13913cddde89";
