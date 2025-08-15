// scripts/t22_withdraw_from_accounts.js
// Usage:
// ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
// ANCHOR_WALLET=~/.config/solana/id.json \
// node scripts/t22_withdraw_from_accounts.js <MINT_2022> <VAULT_ATA> <ACCOUNT_1> [ACCOUNT_2] ...

const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  getTransferFeeAmount,
  withdrawWithheldTokensFromAccounts,
} = require("@solana/spl-token");
const fs = require("fs");

(async () => {
  try {
    const [MINT, VAULT_ATA, ...ACCTS] = process.argv.slice(2);
    if (!MINT || !VAULT_ATA || ACCTS.length === 0) {
      throw new Error(
        "Usage: node scripts/t22_withdraw_from_accounts.js <MINT_2022> <VAULT_ATA> <ACCOUNT_1> [...]"
      );
    }

    const url =
      process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
    const connection = new Connection(url, "confirmed");

    const walletPath =
      process.env.ANCHOR_WALLET || process.env.HOME + "/.config/solana/id.json";
    const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

    const mint = new PublicKey(MINT);
    const vaultAta = new PublicKey(VAULT_ATA);

    // отберём только аккаунты, где реально есть withheld
    const list = [];
    for (const a of ACCTS) {
      const pk = new PublicKey(a);
      const ai = await connection.getAccountInfo(pk, "confirmed");
      if (!ai) continue;
      try {
        const acc = unpackAccount(pk, ai, TOKEN_2022_PROGRAM_ID);
        const tfa = getTransferFeeAmount(acc);
        if (tfa && tfa.withheldAmount > 0n) list.push(pk);
      } catch {}
    }

    if (list.length === 0) {
      console.log("Нет аккаунтов с удержанными комиссиями");
      return;
    }

    const sig = await withdrawWithheldTokensFromAccounts(
      connection,
      payer,
      mint,
      vaultAta,
      payer,
      undefined, // multiSigners
      list,
      undefined, // confirmOptions
      TOKEN_2022_PROGRAM_ID
    );

    console.log("withdraw-withheld-from-accounts tx:", sig);
  } catch (e) {
    console.error("WITHDRAW ERROR:", e.message);
    console.error(e);
    process.exit(1);
  }
})();
