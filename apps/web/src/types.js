/**
 * Shared shapes for the client area.
 *
 * These mirror what `19-client-api` actually returns. Keeping them as real
 * typedefs rather than `object` means a renamed field is a build failure here
 * instead of an `undefined` rendered into a page.
 *
 * Type-only module: it exports nothing at runtime.
 */

/**
 * A trading account as the API presents it.
 *
 * `balance` and `equity` are the ledger's strings, or `null` with a reason —
 * the edge holds no financial state and never substitutes a zero (INV-183).
 *
 * @typedef {object} Account
 * @property {string} accountNumber
 * @property {string} platform
 * @property {string} accountType
 * @property {"real"|"demo"|string} mode
 * @property {string} nickname
 * @property {string} currency
 * @property {number} leverage
 * @property {"active"|"archived"|string} status
 * @property {string} createdAt
 * @property {string|null} [archivedAt]
 * @property {string|null} [archivedReason]
 * @property {string|null} [balance]
 * @property {string|null} [equity]
 * @property {number|null} [openPositions]
 * @property {string} [ledgerStatus]
 * @property {string|null} [balanceUnavailableReason]
 */

/**
 * A recorded funding intent. Money is a decimal string the whole way — it is
 * never a number on this side of the boundary (P1).
 *
 * @typedef {object} FundingIntent
 * @property {string} requestId
 * @property {"deposit"|"withdrawal"|"transfer"|string} kind
 * @property {string} method
 * @property {string} amount
 * @property {string} currency
 * @property {string|null} fromAccount
 * @property {string|null} toAccount
 * @property {string} status
 * @property {string|null} blockedReason
 * @property {string} createdAt
 */

/**
 * @typedef {object} AccountTypeOption
 * @property {string} label
 * @property {string} description
 * @property {string} minDeposit
 * @property {string} commission
 * @property {string} spreadFrom
 */

/**
 * @typedef {object} AccountMeta
 * @property {Record<string, AccountTypeOption>} types
 * @property {number[]} leverages
 * @property {string[]} currencies
 * @property {string[]} platforms
 */

/**
 * The account holder, as `/v1/profile` returns them.
 *
 * `authenticated` distinguishes a real person from the shared development
 * identity that anonymous requests resolve to, and the page renders differently
 * for each — so it is required rather than optional. Everything below it
 * describes what has actually been checked about this person, which on this
 * platform is deliberately very little.
 *
 * @typedef {object} Profile
 * @property {string} name
 * @property {string} email
 * @property {string} clientId
 * @property {string} country
 * @property {string} baseCurrency
 * @property {string|number} since
 * @property {boolean} [authenticated]     True only when a session resolved.
 * @property {boolean} [emailVerified]     Always false: no email is ever sent.
 * @property {boolean} [twoFactorEnabled]
 * @property {number}  [recoveryCodesRemaining]
 * @property {string|null} [lastLoginAt]
 * @property {boolean} [identityVerified]  Owned by 16-kyc-aml; never true here.
 */

export {};
