const anchor = require("@coral-xyz/anchor");
const {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} = require("@solana/spl-token");
const { assert } = require("chai");

describe("transfer_with_fee", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.solLottery;

  it("charges a 0.5% fee", async () => {
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      0,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    const fromAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      provider.wallet.publicKey,
      false,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const toKeypair = anchor.web3.Keypair.generate();
    const toAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      toKeypair.publicKey,
      false,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const vaultOwner = anchor.web3.Keypair.generate();
    const vaultAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      vaultOwner.publicKey,
      false,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      fromAta.address,
      provider.wallet.publicKey,
      1000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await program.methods
      .transferWithFee(new anchor.BN(1000))
      .accounts({
        mint,
        from: fromAta.address,
        to: toAta.address,
        vaultTokenAccount: vaultAta.address,
        sender: provider.wallet.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const toAccount = await getAccount(
      provider.connection,
      toAta.address,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const vaultAccount = await getAccount(
      provider.connection,
      vaultAta.address,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    assert.strictEqual(Number(toAccount.amount), 995);
    assert.strictEqual(Number(vaultAccount.amount), 5);
  });
});
