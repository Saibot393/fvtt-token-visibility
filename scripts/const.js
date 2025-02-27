/* globals
Hooks,
game,
canvas
*/
"use strict";

// Ignores Cover
import { IgnoresCover } from "./IgnoresCover.js";

export const MODULE_ID = "tokenvisibility";
export const EPSILON = 1e-08;

export const FLAGS = {
  DRAWING: { IS_HOLE: "isHole" },
  COVER: {
    IGNORE: {
      ALL: "ignoreCoverAll",
      MWAK: "ignoreCoverMWAK",
      MSAK: "ignoreCoverMSAK",
      RWAK: "ignoreCoverRWAK",
      RSAK: "ignoreCoverRSAK"
    },

    IGNORE_DND5E: "helpersIgnoreCover",
    SPELLSNIPER: "spellSniper",
    SHARPSHOOTER: "sharpShooter"
  }
};

export const COVER = {};

COVER.TYPES = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  TOTAL: 4
};

// Names of the SFRPG Cover items
COVER.SFRPG = {
  1: "Partial Cover",
  2: "Cover",
  3: "Improved Cover",
  4: "Total Cover"
};

COVER.IDS = {};

COVER.IDS[MODULE_ID] = new Set([
  `${MODULE_ID}.cover.LOW`,
  `${MODULE_ID}.cover.MEDIUM`,
  `${MODULE_ID}.cover.HIGH`
]);

COVER.IDS["dfreds-convenient-effects"] = new Set([
  "Convenient Effect: Cover (Half)",
  "Convenient Effect: Cover (Three-Quarters)",
  "Convenient Effect: Cover (Total)"
]);

COVER.IDS.ALL = COVER.IDS[MODULE_ID].union(COVER.IDS["dfreds-convenient-effects"]);

COVER.DFRED_NAMES = {
  LOW: "Cover (Half)",
  MEDIUM: "Cover (Three-Quarters)",
  HIGH: "Cover (Total)"
};


COVER.CATEGORIES = {
  LOW: {
    "dfreds-convenient-effects": "Convenient Effect: Cover (Half)",
    [MODULE_ID]: `${MODULE_ID}.cover.LOW`
  },

  MEDIUM: {
    "dfreds-convenient-effects": "Convenient Effect: Cover (Three-Quarters)",
    [MODULE_ID]: `${MODULE_ID}.cover.MEDIUM`
  },

  HIGH: {
    "dfreds-convenient-effects": "Convenient Effect: Cover (Total)",
    [MODULE_ID]: `${MODULE_ID}.cover.HIGH`
  }
};

COVER.TYPES_FOR_ID = {
  [MODULE_ID]: {
    [`${MODULE_ID}.cover.LOW`]: COVER.TYPES.LOW,
    [`${MODULE_ID}.cover.MEDIUM`]: COVER.TYPES.MEDIUM,
    [`${MODULE_ID}.cover.HIGH`]: COVER.TYPES.HIGH,

    // Sometimes the id is all lowercase.
    [`${MODULE_ID}.cover.low`]: COVER.TYPES.LOW,
    [`${MODULE_ID}.cover.medium`]: COVER.TYPES.MEDIUM,
    [`${MODULE_ID}.cover.high`]: COVER.TYPES.HIGH
  },

  "dfreds-convenient-effects": {
    "Convenient Effect: Cover (Half)": COVER.TYPES.LOW,
    "Convenient Effect: Cover (Three-Quarters)": COVER.TYPES.MEDIUM,
    "Convenient Effect: Cover (Total)": COVER.TYPES.HIGH
  }
};

COVER.MIN = Math.min(...Object.values(COVER.TYPES));
COVER.MAX = Math.max(...Object.values(COVER.TYPES));

export const MODULES_ACTIVE = {
  WALL_HEIGHT: false,
  PERFECT_VISION: false,
  LEVELS: false,
  DFREDS_CE: false,
  SIMBULS_CC: false,
  MIDI_QOL: false,
  EV: false
};

export const DEBUG = {
  range: false,
  los: false,
  cover: false,
  area: false,
  once: false,
  forceLiveTokensBlock: false,
  forceDeadTokensBlock: false
};

export let IGNORES_COVER_HANDLER = IgnoresCover;

export const WEAPON_ATTACK_TYPES = {
  all: `${MODULE_ID}.phrases.AllAttacks`,
  mwak: "DND5E.ActionMWAK",
  msak: "DND5E.ActionMSAK",
  rwak: "DND5E.ActionRWAK",
  rsak: "DND5E.ActionRSAK"
};

// Hook init b/c game.modules is not initialized at start.
Hooks.once("init", function() {
  MODULES_ACTIVE.WALL_HEIGHT = game.modules.get("wall-height")?.active;
  MODULES_ACTIVE.PERFECT_VISION = game.modules.get("perfect-vision")?.active;
  MODULES_ACTIVE.LEVELS = game.modules.get("levels")?.active;
  MODULES_ACTIVE.DFREDS_CE = game.modules.get("dfreds-convenient-effects")?.active;
  MODULES_ACTIVE.SIMBULS_CC = game.modules.get("simbuls-cover-calculator")?.active;
  MODULES_ACTIVE.MIDI_QOL = game.modules.get("midi-qol")?.active;
  MODULES_ACTIVE.ELEVATED_VISION = game.modules.get("elevatedvision")?.active;
});

/**
 * Helper to set the cover ignore handler and, crucially, update all tokens.
 */
export function setCoverIgnoreHandler(handler) {
  if ( !(handler.prototype instanceof IgnoresCover ) ) {
    console.warn("setCoverIgnoreHandler: handler not recognized.");
    return;
  }

  IGNORES_COVER_HANDLER = handler;

  // Simplest just to revert any existing.
  if ( !canvas.tokens?.placeables ) return;
  canvas.tokens.placeables.forEach(t => t._ignoresCoverType = undefined);
}
