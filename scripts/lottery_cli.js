// scripts/lottery_cli.js
// Команды:
//   node scripts/lottery_cli.js status <POOL_STATE>
//   node scripts/lottery_cli.js stake <POOL_STATE> <MINT_2022> <AMOUNT>
//   node scripts/lottery_cli.js unstake <POOL_STATE> <MINT_2022> <AMOUNT>
//   node scripts/lottery_cli.js claim <POOL_STATE>
//   node scripts/lottery_cli.js draw_weekly <POOL_STATE>
//   node scripts/lottery_cli.js tx_with_fee <POOL_STATE> <FROM_OWNER> <TO_OWNER> <MINT_2022> <AMOUNT> <FEE_BPS>

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

async function loadProgram(provider) {
  try {
    const p = anchor.workspace.SolLottery;
    if (p) return p;
  } catch {}
  const idlPath = path.resolve("target/idl/sol_lottery.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new PublicKey(
    idl.metadata?.address || process.env.PROGRAM_ID
  );
  if (!programId)
    throw new Error("No programId: set idl.metadata.address or PROGRAM_ID env");
  return new anchor.Program(idl, programId, provider);
}

function deriveVault(programId, pool) {
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault-auth"), pool.toBuffer()],
    programId
  );
  const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), pool.toBuffer()],
    programId
  );
  return { vaultAuthority, vaultTokenAccount };
}

function deriveStaking(programId, pool) {
  const [stakingAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("staking-auth"), pool.toBuffer()],
    programId
  );
  const [stakingTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("staking"), pool.toBuffer()],
    programId
  );
  return { stakingAuthority, stakingTokenAccount };
}

// Создание/проверка ATA под Token-2022
async function ensureAtaIx(
  connection,
  mint,
  owner,
  payer,
  allowOwnerOffCurve = false
) {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve, // PDA -> true, обычный owner -> false
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const info = await connection.getAccountInfo(ata);
  if (info) return { ata, ix: null };
  const ix = createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return { ata, ix };
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd) {
    console.log("usage: node scripts/lottery_cli.js <cmd> ...");
    process.exit(1);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = await loadProgram(provider);
  const connection = provider.connection;
  const wallet = provider.wallet.payer; // Keypair (локальный)

  if (cmd === "status") {
    const [poolStr] = args;
    const pool = new PublicKey(poolStr);
    const state = await program.account.poolState.fetch(pool);
    console.log({
      owner: state.owner.toBase58(),
      mint: state.mint.toBase58(),
      vaultBump: state.vaultBump,
      stakingBump: state.stakingBump,
      totalStaked: state.totalStaked.toString(),
      accRps: state.accRewardPerShare.toString(),
      lastDrawTs: state.lastDrawTs.toString(),
      drawInterval: state.drawInterval.toString(),
      vaultAccounted: state.vaultAccounted.toString(),
    });
    return;
  }

  if (cmd === "stake" || cmd === "unstake") {
    const [poolStr, mintStr, amountStr] = args;
    const pool = new PublicKey(poolStr);
    const mint = new PublicKey(mintStr);
    const amount = new anchor.BN(amountStr);

    const { vaultAuthority, vaultTokenAccount } = deriveVault(
      program.programId,
      pool
    );
    const { stakingAuthority, stakingTokenAccount } = deriveStaking(
      program.programId,
      pool
    );

    const user = wallet.publicKey;

    // ATA пользователя под Token-2022
    const { ata: userAta, ix } = await ensureAtaIx(
      connection,
      mint,
      user,
      user
    );

    const [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), pool.toBuffer(), user.toBuffer()],
      program.programId
    );

    const tx = new anchor.web3.Transaction();
    if (ix) tx.add(ix);

    const method =
      cmd === "stake"
        ? program.methods.stake(amount)
        : program.methods.unstake(amount);
    const sig = await method
      .accounts({
        poolState: pool,
        mint,
        vaultTokenAccount,
        vaultAuthority,
        stakingTokenAccount,
        stakingAuthority,
        userStake: userStakePda,
        user,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions(tx.instructions)
      .rpc();

    console.log(`${cmd} tx:`, sig);
    return;
  }

  if (cmd === "claim") {
    const [poolStr] = args;
    const pool = new PublicKey(poolStr);
    const state = await program.account.poolState.fetch(pool);
    const mint = state.mint;

    const { vaultAuthority, vaultTokenAccount } = deriveVault(
      program.programId,
      pool
    );

    const user = wallet.publicKey;
    const { ata: userAta, ix } = await ensureAtaIx(
      connection,
      mint,
      user,
      user
    );

    const [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), pool.toBuffer(), user.toBuffer()],
      program.programId
    );

    const tx = new anchor.web3.Transaction();
    if (ix) tx.add(ix);

    const sig = await program.methods
      .claim()
      .accounts({
        poolState: pool,
        vaultTokenAccount,
        vaultAuthority,
        userStake: userStakePda,
        user,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions(tx.instructions)
      .rpc();

    console.log("claim tx:", sig);
    return;
  }

  if (cmd === "draw_weekly") {
    const [poolStr] = args;
    const pool = new PublicKey(poolStr);
    const state = await program.account.poolState.fetch(pool);

    const { vaultAuthority, vaultTokenAccount } = deriveVault(
      program.programId,
      pool
    );

    // ATA владельца пула (создателя)
    const ownerAta = getAssociatedTokenAddressSync(
      state.mint,
      state.owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const sig = await program.methods
      .drawWeekly()
      .accounts({
        poolState: pool,
        vaultTokenAccount,
        vaultAuthority,
        ownerTokenAccount: ownerAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    console.log("draw_weekly tx:", sig);
    return;
  }

  if (cmd === "tx_with_fee") {
    const [poolStr, fromOwnerStr, toOwnerStr, mintStr, amountStr, feeBpsStr] =
      args;
    const pool = new PublicKey(poolStr);
    const fromOwner = new PublicKey(fromOwnerStr);
    const toOwner = new PublicKey(toOwnerStr);
    const mint = new PublicKey(mintStr);
    const amount = new anchor.BN(amountStr);
    const feeBps = new anchor.BN(feeBpsStr); // параметр для твоей MVP-инструкции

    const { vaultTokenAccount } = deriveVault(program.programId, pool);

    // MVP: отправителем выступает локальный кошелёк
    if (!fromOwner.equals(wallet.publicKey)) {
      throw new Error("Sender must equal local wallet in this CLI MVP");
    }

    // ATA для from/to (Token-2022)
    const fromAta = getAssociatedTokenAddressSync(
      mint,
      fromOwner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const toAta = getAssociatedTokenAddressSync(
      mint,
      toOwner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const sig = await program.methods
      .transferWithFee(amount, feeBps) // твоя on-chain MVP-логика (не Token-2022)
      .accounts({
        from: fromAta,
        to: toAta,
        vaultTokenAccount,
        sender: wallet.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    console.log("tx_with_fee tx:", sig);
    return;
  }

  console.log("Unknown command");
}

main().catch((e) => {
  console.error("CLI ERROR:", e.message);
  console.error(e);
  process.exit(1);
});
