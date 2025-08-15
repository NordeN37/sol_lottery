const anchor = require("@coral-xyz/anchor");
const { TOKEN_2022_PROGRAM_ID, createMint } = require("@solana/spl-token");
const { assert } = require("chai");

describe("sol_lottery", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("Is initialized!", async () => {
    const program = anchor.workspace.solLottery;
    const drawIntervalSecs = 60;

    // Account that will hold pool state data
    const poolState = anchor.web3.Keypair.generate();

    // Create mint that will be used by the pool
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Derive PDA for vault (token account + authority)
    const [vaultTokenAccount, _vaultBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), poolState.publicKey.toBuffer()],
        program.programId
      );

    // Derive PDA for staking (token account + authority)
    const [stakingTokenAccount, _stakingBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("staking"), poolState.publicKey.toBuffer()],
        program.programId
      );

    // Initialize the pool
    await program.methods
      .initialize(new anchor.BN(drawIntervalSecs))
      .accounts({
        poolState: poolState.publicKey,
        mint,
        vaultTokenAccount,
        vaultAuthority: vaultTokenAccount,
        stakingTokenAccount,
        stakingAuthority: stakingTokenAccount,
        owner: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([poolState])
      .rpc();

    const state = await program.account.poolState.fetch(
      poolState.publicKey
    );

    assert.strictEqual(
      state.owner.toString(),
      provider.wallet.publicKey.toString()
    );
    assert.strictEqual(state.mint.toString(), mint.toString());
    assert.strictEqual(state.drawInterval.toNumber(), drawIntervalSecs);
  });
});
