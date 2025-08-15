// programs/sol_lottery/src/lib.rs

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self as token, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

declare_id!("6hqUSoAvitrjTuJrfoWyVT2YP1Db2BF7jtNYmaJU7cyE");

const ACC_PRECISION: u128 = 1_000_000_000_000; // масштаб для acc_reward_per_share

#[program]
pub mod sol_lottery {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, draw_interval_secs: i64) -> Result<()> {
        require!(draw_interval_secs > 0, LotteryError::BadInterval);

        let state = &mut ctx.accounts.pool_state;
        state.owner = ctx.accounts.owner.key();
        state.mint = ctx.accounts.mint.key();
        state.vault_bump = ctx.bumps.vault_authority;
        state.staking_bump = ctx.bumps.staking_authority;
        state.total_staked = 0;
        state.acc_reward_per_share = 0;
        state.last_draw_ts = Clock::get()?.unix_timestamp;
        state.draw_interval = draw_interval_secs;
        state.vault_accounted = 0;

        Ok(())
    }

    /// MVP-перевод с комиссией fee_bps -> в пул (кастомно).
    /// Если используешь Token-2022 transfer-fee, эта инструкция не обязательна.
    pub fn transfer_with_fee(
        ctx: Context<TransferWithFee>,
        amount: u64,
        fee_bps: u64,
    ) -> Result<()> {
        require!(fee_bps <= 10_000, LotteryError::BadFee);
        require!(amount > 0, LotteryError::ZeroAmount);

        let fee = amount.saturating_mul(fee_bps) / 10_000;
        let remainder = amount.saturating_sub(fee);
        let decimals = ctx.accounts.mint.decimals;

        // fee -> vault
        {
            let cpi = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            );
            token::transfer_checked(cpi, fee, decimals)?;
        }

        // остаток -> получателю
        {
            let cpi = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            );
            token::transfer_checked(cpi, remainder, decimals)?;
        }

        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, LotteryError::ZeroAmount);

        let state = &mut ctx.accounts.pool_state;
        let user = &mut ctx.accounts.user_stake;
        let decimals = ctx.accounts.mint.decimals;

        // auto-claim невыплаченного
        if user.amount > 0 {
            let pending = (user.amount as u128)
                .saturating_mul(state.acc_reward_per_share)
                .saturating_sub(user.reward_debt)
                / ACC_PRECISION;

            if pending > 0 {
                let state_key = state.key();
                let (prefix, key, bump) = vault_seeds(&state_key, state.vault_bump);
                let seeds = &[prefix, key, &bump];
                let signer = &[&seeds[..]];

                let cpi = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.user_token_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                );
                token::transfer_checked(cpi, pending as u64, decimals)?;
                state.vault_accounted = state.vault_accounted.saturating_sub(pending as u64);
            }
        }

        // перевод стейка в кастодиальный счёт
        {
            let cpi = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.staking_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            );
            token::transfer_checked(cpi, amount, decimals)?;
        }

        state.total_staked = state.total_staked.saturating_add(amount);
        user.amount = user.amount.saturating_add(amount);
        user.reward_debt = (user.amount as u128).saturating_mul(state.acc_reward_per_share);

        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.pool_state;
        let user = &mut ctx.accounts.user_stake;
        let decimals = ctx.accounts.mint.decimals;

        require!(amount > 0 && amount <= user.amount, LotteryError::BadUnstakeAmount);

        // auto-claim
        {
            let pending = (user.amount as u128)
                .saturating_mul(state.acc_reward_per_share)
                .saturating_sub(user.reward_debt)
                / ACC_PRECISION;

            if pending > 0 {
                let state_key = state.key();
                let (prefix, key, bump) = vault_seeds(&state_key, state.vault_bump);
                let seeds = &[prefix, key, &bump];
                let signer = &[&seeds[..]];

                let cpi = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_account.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.user_token_account.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer,
                );
                token::transfer_checked(cpi, pending as u64, decimals)?;
                state.vault_accounted = state.vault_accounted.saturating_sub(pending as u64);
            }
        }

        // вернуть часть стейка пользователю
        {
            let state_key = state.key();
            let (prefix, key, bump) = staking_seeds(&state_key, state.staking_bump);
            let seeds = &[prefix, key, &bump];
            let signer = &[&seeds[..]];

            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.staking_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.staking_authority.to_account_info(),
                },
                signer,
            );
            token::transfer_checked(cpi, amount, decimals)?;
        }

        state.total_staked = state.total_staked.saturating_sub(amount);
        user.amount = user.amount.saturating_sub(amount);
        user.reward_debt = (user.amount as u128).saturating_mul(state.acc_reward_per_share);

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let state = &mut ctx.accounts.pool_state;
        let user = &mut ctx.accounts.user_stake;
        let decimals = ctx.accounts.mint.decimals;

        let pending = (user.amount as u128)
            .saturating_mul(state.acc_reward_per_share)
            .saturating_sub(user.reward_debt)
            / ACC_PRECISION;

        require!(pending > 0, LotteryError::NothingToClaim);

        let state_key = state.key();
        let (prefix, key, bump) = vault_seeds(&state_key, state.vault_bump);
        let seeds = &[prefix, key, &bump];
        let signer = &[&seeds[..]];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer,
        );
        token::transfer_checked(cpi, pending as u64, decimals)?;
        state.vault_accounted = state.vault_accounted.saturating_sub(pending as u64);

        user.reward_debt = (user.amount as u128).saturating_mul(state.acc_reward_per_share);
        Ok(())
    }

    /// Разнос новых комиссий: 30% владельцу, 70% — в RPS (по стейку).
    pub fn draw_weekly(ctx: Context<DrawWeekly>) -> Result<()> {
        let state = &mut ctx.accounts.pool_state;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= state.last_draw_ts + state.draw_interval, LotteryError::TooEarly);

        let vault_balance = ctx.accounts.vault_token_account.amount;
        require!(vault_balance >= state.vault_accounted, LotteryError::Invariant);

        let delta = vault_balance - state.vault_accounted;
        require!(delta > 0, LotteryError::NoNewFees);

        // 30% создателю
        let creator_share = delta.saturating_mul(30) / 100;
        let decimals = ctx.accounts.mint.decimals;

        if creator_share > 0 {
            let state_key = state.key();
            let (prefix, key, bump) = vault_seeds(&state_key, state.vault_bump);
            let seeds = &[prefix, key, &bump];
            let signer = &[&seeds[..]];

            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            );
            token::transfer_checked(cpi, creator_share, decimals)?;
        }

        // 70% — в RPS
        let reward = delta - creator_share;
        if reward > 0 {
            require!(state.total_staked > 0, LotteryError::NoStakers);
            let add = (reward as u128)
                .saturating_mul(ACC_PRECISION)
                / (state.total_staked as u128);
            state.acc_reward_per_share = state.acc_reward_per_share.saturating_add(add);
            state.vault_accounted = state.vault_accounted.saturating_add(reward);
        }

        state.last_draw_ts = now;
        Ok(())
    }
}

// -------------------- Account Contexts --------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = owner, space = 8 + PoolState::SIZE)]
    pub pool_state: Account<'info, PoolState>,

    pub mint: InterfaceAccount<'info, Mint>,

    // PDA vault (копит комиссии)
    #[account(
        init,
        payer = owner,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA-авторити для vault
    #[account(seeds = [b"vault", pool_state.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    // PDA staking (кастодиальный стейкинг)
    #[account(
        init,
        payer = owner,
        seeds = [b"staking", pool_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = staking_authority
    )]
    pub staking_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA-авторити для staking
    #[account(seeds = [b"staking", pool_state.key().as_ref()], bump)]
    pub staking_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TransferWithFee<'info> {
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub to: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub sender: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"vault", pool_state.key().as_ref()], bump = pool_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"staking", pool_state.key().as_ref()],
        bump = pool_state.staking_bump
    )]
    pub staking_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"staking", pool_state.key().as_ref()], bump = pool_state.staking_bump)]
    pub staking_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"user", pool_state.key().as_ref(), user.key().as_ref()],
        bump,
        space = 8 + UserStake::SIZE
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"vault", pool_state.key().as_ref()], bump = pool_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"staking", pool_state.key().as_ref()],
        bump = pool_state.staking_bump
    )]
    pub staking_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"staking", pool_state.key().as_ref()], bump = pool_state.staking_bump)]
    pub staking_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"user", pool_state.key().as_ref(), user.key().as_ref()], bump)]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"vault", pool_state.key().as_ref()], bump = pool_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"user", pool_state.key().as_ref(), user.key().as_ref()], bump)]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DrawWeekly<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump = pool_state.vault_bump
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK:
    #[account(seeds = [b"vault", pool_state.key().as_ref()], bump = pool_state.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// ATA владельца пула (куда уйдут 30%)
    #[account(mut)]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// -------------------- State --------------------

#[account]
pub struct PoolState {
    pub owner: Pubkey,              // 32
    pub mint: Pubkey,               // 32
    pub vault_bump: u8,             // 1
    pub staking_bump: u8,           // 1
    pub total_staked: u64,          // 8
    pub acc_reward_per_share: u128, // 16
    pub last_draw_ts: i64,          // 8
    pub draw_interval: i64,         // 8
    pub vault_accounted: u64,       // 8
}
impl PoolState {
    pub const SIZE: usize = 32 + 32 + 1 + 1 + 8 + 16 + 8 + 8 + 8;
}

#[account]
pub struct UserStake {
    pub amount: u64,        // сколько застейкано
    pub reward_debt: u128,  // accrual debt
}
impl UserStake {
    pub const SIZE: usize = 8 + 16;
}

// -------------------- Errors --------------------

#[error_code]
pub enum LotteryError {
    #[msg("Bad draw interval")]
    BadInterval,
    #[msg("Fee bps out of range")]
    BadFee,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Bad unstake amount")]
    BadUnstakeAmount,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Too early to draw")]
    TooEarly,
    #[msg("Invariant violation")]
    Invariant,
    #[msg("No new fees since last draw")]
    NoNewFees,
    #[msg("No stakers to distribute to")]
    NoStakers,
}

// -------------------- Helpers --------------------

/// Returns components of the seeds used for the vault authority PDA.
fn vault_seeds<'a>(state_key: &'a Pubkey, vault_bump: u8) -> (&'static [u8], &'a [u8], [u8; 1]) {
    (b"vault", state_key.as_ref(), [vault_bump])
}

/// Returns components of the seeds used for the staking authority PDA.
fn staking_seeds<'a>(state_key: &'a Pubkey, staking_bump: u8) -> (&'static [u8], &'a [u8], [u8; 1]) {
    (b"staking", state_key.as_ref(), [staking_bump])
}
