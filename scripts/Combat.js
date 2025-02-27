/* globals
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

// Patches for the Combat class
export const PATCHES = {};
PATCHES.NO_PF2E = {};

// ----- NOTE: Hooks ----- //

/**
 * Hook the combat turn, to clear cover from other combatants.
 */
async function combatTurn(combat, updateData, updateOptions) { // eslint-disable-line no-unused-vars
  // Properties for updateData:
  //   updateData.round
  //   updateData.turn

  const c = combat.combatant;
  const playerOwners = c.players;

  // Clear cover status of all tokens in the scene
  // Unless the token is targeted by the current user
  const tokens = canvas.tokens.placeables;

  const userTargetedTokens = [];
  for ( const token of tokens ) {
    if ( playerOwners.some(owner => token.targeted.has(owner)) ) {
      userTargetedTokens.push(token);
    }
    CoverCalculator.disableAllCover(token.id);
  }

  // Calculate cover from combatant to any currently targeted tokens
  const combatToken = c.token.object;
  for ( const target of userTargetedTokens ) {
    const coverCalc = new CoverCalculator(combatToken, target);
    coverCalc.setTargetCoverEffect();
  }
}

PATCHES.NO_PF2E.HOOKS = { combatTurn };
