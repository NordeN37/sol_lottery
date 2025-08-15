// scripts/init.js
// Инициализация пула (initialize) под Token-2022
// usage:
// ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
// ANCHOR_WALLET=~/.config/solana/id.json \
// node scripts/init.js target/pool_state.json <MINT_2022_PUBKEY> [intervalSec=604800]

const anchor = require("@coral-xyz/anchor");
const { SystemProgram, PublicKey, Keypair } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

async function loadProgram(provider) {
    try {
        // если программa есть в workspace (anchor test/dev)
        const p = anchor.workspace.SolLottery;
        if (p) return p;
    } catch {}
    // иначе берём IDL из target/idl
    const idlPath = path.resolve("target/idl/sol_lottery.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    const programId = new PublicKey(idl.metadata?.address || process.env.PROGRAM_ID);
    if (!programId) throw new Error("No programId: set idl.metadata.address or PROGRAM_ID env");
    return new anchor.Program(idl, programId, provider);
}

(async () => {
    try {
        const [, , poolKeypairPath, mintStr, intervalStr] = process.argv;
        if (!poolKeypairPath || !mintStr) {
            console.log("usage: node scripts/init.js target/pool_state.json <MINT_2022_PUBKEY> [intervalSec]");
            process.exit(1);
        }
        const interval = intervalStr ? Number(intervalStr) : 604800; // неделя по умолчанию

        const provider = anchor.AnchorProvider.env();
        anchor.setProvider(provider);
        const program = await loadProgram(provider);

        const poolKeypair = Keypair.fromSecretKey(
            Uint8Array.from(require(path.resolve(poolKeypairPath)))
        );
        const poolStatePk = poolKeypair.publicKey;
        const mint = new PublicKey(mintStr);

        // PDAs (совпадают с seeds в контракте)
        const [vaultAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolStatePk.toBuffer()],
            program.programId
        );
        const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolStatePk.toBuffer()],
            program.programId
        );
        const [stakingAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("staking"), poolStatePk.toBuffer()],
            program.programId
        );
        const [stakingTokenAccount] = PublicKey.findProgramAddressSync(
            [Buffer.from("staking"), poolStatePk.toBuffer()],
            program.programId
        );

        console.log("Program:              ", program.programId.toBase58());
        console.log("PoolState:            ", poolStatePk.toBase58());
        console.log("Mint (Token-2022):    ", mint.toBase58());
        console.log("VaultTokenAccount PDA:", vaultTokenAccount.toBase58());
        console.log("StakingTokenAccount:  ", stakingTokenAccount.toBase58());
        console.log("Interval (sec):       ", interval);

        const sig = await program.methods
            .initialize(new anchor.BN(interval))
            .accounts({
                poolState: poolStatePk,
                mint,
                vaultTokenAccount,
                vaultAuthority,
                stakingTokenAccount,
                stakingAuthority,
                owner: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_2022_PROGRAM_ID, // <— ВАЖНО
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .signers([poolKeypair])
            .rpc();

        console.log("initialize tx:", sig);
    } catch (e) {
        console.error("INIT ERROR:", e.message);
        console.error(e);
        process.exit(1);
    }
})();
