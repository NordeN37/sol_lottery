// scripts/t22_transfer.js
// Usage:
// ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=~/.config/solana/id.json \
// node scripts/t22_transfer.js <MINT_2022> <DEST_PUBKEY> <AMOUNT_RAW>
// где AMOUNT_RAW — в минимальных единицах (например, 1 токен при decimals=6 = 1_000_000)

const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    getMint,
    createAssociatedTokenAccountInstruction,
    transferChecked,
} = require("@solana/spl-token");
const fs = require("fs");

(async () => {
    try {
        const [MINT, DEST, AMOUNT_RAW] = process.argv.slice(2);
        if (!MINT || !DEST || !AMOUNT_RAW) {
            throw new Error("Usage: node scripts/t22_transfer.js <MINT_2022> <DEST_PUBKEY> <AMOUNT_RAW>");
        }
        const url = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
        const connection = new Connection(url, "confirmed");
        const walletPath = process.env.ANCHOR_WALLET || (process.env.HOME + "/.config/solana/id.json");
        const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));

        const mintPk = new PublicKey(MINT);
        const destPk = new PublicKey(DEST);

        const srcAta = getAssociatedTokenAddressSync(mintPk, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const dstAta = getAssociatedTokenAddressSync(mintPk, destPk, false, TOKEN_2022_PROGRAM_ID);

        const ixes = [];
        const ai = await connection.getAccountInfo(dstAta);
        if (!ai) {
            ixes.push(
                createAssociatedTokenAccountInstruction(
                    payer.publicKey,
                    dstAta,
                    destPk,
                    mintPk,
                    TOKEN_2022_PROGRAM_ID,
                    ASSOCIATED_TOKEN_PROGRAM_ID
                )
            );
        }

        const mintInfo = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
        const decimals = mintInfo.decimals;
        const amount = Number(AMOUNT_RAW);

        const sig = await transferChecked(
            connection,
            payer,
            srcAta,
            mintPk,
            dstAta,
            payer.publicKey,
            amount,
            decimals,
            undefined,
            undefined,
            TOKEN_2022_PROGRAM_ID,
            { preflightCommitment: "confirmed" },
            ixes
        );

        console.log("transfer tx:", sig);
    } catch (e) {
        console.error("T22 TRANSFER ERROR:", e.message);
        console.error(e);
        process.exit(1);
    }
})();
