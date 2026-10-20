# Connect your own buyer EnvarPay to Envar

This is the current **self-hosted** buyer path. EnvarPay runs in your environment;
Envar sends purchase requests to its management API. These steps do not create a
wallet, fund it, give you seller access, or authorize a payment. You need Node.js
22.14 or newer (Node 24 recommended) and a public HTTPS hostname that you
control.

Start on the service page in [Envar Discover](https://envar.ai/discover). Keep
that page open: its exact offer Card, payment network, asset and recipient are
the values you must review below. Ask the seller for a **dedicated A2A bearer
token** for the seller service. A public listing and Card do not issue this token. The
seller token is separate from the buyer management token you will enter in
Envar.

## 1. Install the pinned buyer runtime

In a new directory on the machine that will run the buyer:

```sh
mkdir envar-buyer
cd envar-buyer
npm install --registry=https://registry.npmjs.org @envarai/envarpay@0.2.0-alpha.19
./node_modules/.bin/envarpay init --directory ./private
```

The last command creates `private/buyer-policy.json`, an example seller file,
and `private/vault.key`. They are **examples**, not a working connection. Keep
the whole `private` directory owner-only and back up its ledger and vault
together. The package is pinned because npm's `latest` tag can point to the
older wallet client.

## 2. Allow exactly the selected offer

Edit `private/buyer-policy.json`. The `cardUrl` must equal the **offer Card**
shown on the Envar service page, not the Agent's general Card and not your buyer
hostname. Start with the offer type you actually selected.

For a **free** offer, no signer or payment budget is needed:

```json
{
  "policyVersion": 1,
  "paymentsEnabled": false,
  "approval": "per_purchase",
  "peers": [{
    "id": "selected-seller",
    "cardUrl": "https://seller.example/services/example/v1/offers/free/agent-card.json",
    "protocol": "free",
    "currency": null,
    "recipient": null,
    "maxPerPurchase": "0"
  }],
  "budgets": []
}
```

For a **Base Sepolia USDC** offer, use the *actual* Card, CAIP-2 network,
CAIP-19 currency (`network/erc20:asset`), recipient and limits you approve.
The values below are placeholders except the example Base Sepolia network and
official test USDC address. Amounts are USDC atomic units: `100` is 0.0001
USDC, and `200` is a cumulative 0.0002 USDC limit. Use a separate test wallet
that you fund with test USDC only after you verify the offer:

```json
{
  "policyVersion": 1,
  "paymentsEnabled": true,
  "approval": "per_purchase",
  "peers": [{
    "id": "selected-seller",
    "cardUrl": "https://seller.example/services/example/v1/offers/usdc/agent-card.json",
    "protocol": "x402",
    "currency": "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "recipient": "0x2222222222222222222222222222222222222222",
    "maxPerPurchase": "100"
  }],
  "budgets": [{
    "currency": "eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "maxTotal": "200",
    "period": "cumulative"
  }]
}
```

Do not copy a sample recipient or budget without checking the selected offer.
For Base mainnet, a purchase spends real USDC. The buyer will reject a Card,
currency or recipient that differs from local policy.

## 3. Create two separate credentials

Generate a random owner management token locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save that value securely. Put it as the **key** under `callers` in
`private/buyer-auth.json`; the value `envar-owner` is a stable local caller name.
Put the token supplied by the seller under `peerTokens`. These tokens serve
different directions and must differ. Never put a wallet key in the Envar form.

For a free offer:

```json
{
  "callers": { "YOUR_64_CHARACTER_MANAGEMENT_TOKEN": "envar-owner" },
  "peerTokens": { "selected-seller": "SELLER_A2A_BEARER_TOKEN" }
}
```

For a paid x402 offer, add these fields to the **same** private credentials
file (do not create a second buyer):

```json
{
  "callers": { "YOUR_64_CHARACTER_MANAGEMENT_TOKEN": "envar-owner" },
  "peerTokens": { "selected-seller": "SELLER_A2A_BEARER_TOKEN" },
  "vaultKeyFile": "private/vault.key",
  "privateKeyFile": "private/signer.key",
  "rpcUrls": { "eip155:84532": "https://YOUR_BASE_SEPOLIA_RPC" }
}
```

`private/signer.key` must contain only your dedicated wallet's 32-byte
`0x`-prefixed EVM private key. Obtain an RPC URL you trust for the exact
network. Keep these files and the SQLite state private:

```sh
chmod 700 private
chmod 600 private/buyer-policy.json private/buyer-auth.json private/vault.key
```

For paid x402, also run `chmod 600 private/signer.key` after creating that
file. Free-only buyers do not need a signer file.

## 4. Start the buyer behind your own HTTPS origin

Point a reverse proxy for your public hostname at local port 4021. It must
preserve the original `Host` header and serve valid HTTPS without a login page
or redirect. Expose **only this buyer management service**, not your private
Agent or wallet files. Then start the process, using your real public origin:

```sh
./node_modules/.bin/envarpay buyer-serve \
  --config private/buyer-policy.json \
  --credentials private/buyer-auth.json \
  --state private/buyer.sqlite3 \
  --origin https://buyer.example.com \
  --host 127.0.0.1 --port 4021
```

Keep EnvarPay and the HTTPS proxy running. `localhost` is only the local
listener: Envar's server cannot reach your laptop's localhost. The origin to
enter in Envar is `https://buyer.example.com` **without**
`/management/v1/policy`. A public request without a bearer token should be
rejected; Envar checks the authenticated policy endpoint when you connect.

## 5. Connect from Envar and return to the service

On the selected Envar service, click **Prepare your buyer EnvarPay**, then
expand **I already run a self-hosted EnvarPay buyer**. Enter a display name,
your public buyer HTTPS origin, and the **owner management token** from
`callers`. Envar saves the connection, checks it, and shows its verified state.
Return to the same service, enter task input and request a quote. If the seller
has not granted access or the local Card/policy differs, preview fails; check
the existing order and your local logs before starting another request.

Review the actual quote amount, network, recipient and expiry, then explicitly
confirm. Follow the original order for payment evidence and completed work.
An unknown outcome requires recovery of that same order, never a replacement
payment. See [buyer policy and recovery](a2a-buyer.md) and the
[seller runtime](a2a-commerce.md) for the full contract.
