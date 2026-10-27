/**
 * setCodes.js — Arena set codes vs. the data behind them.
 *
 * Alchemy drafts use the base set's cards plus some digital-only ones. Arena
 * names the event's set "YFRA" (older events: "Y26SOS"); 17Lands lists it as
 * "Y26FRA" with few or no win rates, while the base set has full data for
 * every shared card (same Arena ids). So data lookups go to the base set, and
 * only the extra cards come from 17Lands' Alchemy listing.
 */
'use strict';

const ALCHEMY_RE = /^Y(\d{2})?([A-Z0-9]{3})$/;

/** 'FRA' for 'YFRA' or 'Y26FRA'; null for a regular set code. */
function alchemyBase(code) {
  const m = typeof code === 'string' ? ALCHEMY_RE.exec(code) : null;
  return m ? m[2] : null;
}

/** The set whose data (tables, ratings, bot stats) stands for `code`. */
const dataSetFor = (code) => alchemyBase(code) ?? code;

module.exports = { alchemyBase, dataSetFor };
