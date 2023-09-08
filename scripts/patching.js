/* globals
game,
*/
"use strict";
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */

import { Patcher } from "./Patcher.js";
import { MODULES_ACTIVE } from "./const.js";

import { PATCHES as PATCHES_ActiveEffect } from "./ActiveEffect.js";
import { PATCHES as PATCHES_CanvasVisibility } from "./CanvasVisibility.js";
import { PATCHES as PATCHES_ConstrainedTokenBorder } from "./ConstrainedTokenBorder.js";
import { PATCHES as PATCHES_DetectionMode } from "./DetectionMode.js";
import { PATCHES as PATCHES_Item } from "./Item.js";
import { PATCHES as PATCHES_LightSource } from "./LightSource.js";
import { PATCHES as PATCHES_PointSourcePolygon } from "./PointSourcePolygon.js";
import { PATCHES as PATCHES_Token } from "./Token.js";
import { PATCHES as PATCHES_VisionSource } from "./VisionSource.js";

// Levels
import { PATCHES as PATCHES_Levels_SightHandler } from "./Levels_SightHandler.js";

// Midiqol
import { PATCHES as PATCHES_Midiqol } from "./Midiqol.js";

const PATCHES = {
  ActiveEffect: PATCHES_ActiveEffect,
  CanvasVisibility: PATCHES_CanvasVisibility,
  ConstrainedTokenBorder: PATCHES_ConstrainedTokenBorder,
  DetectionMode: PATCHES_DetectionMode,
  Item: PATCHES_Item,
  LightSource: PATCHES_LightSource,
  PointSourcePolygon: PATCHES_PointSourcePolygon,
  Token: PATCHES_Token,
  VisionSource: PATCHES_VisionSource,
  "CONFIG.Levels.handlers.SightHandler": PATCHES_Levels_SightHandler,
  Midiqol: PATCHES_Midiqol
};

export const PATCHER = new Patcher(PATCHES);

export function initializePatching() {
  PATCHER.registerGroup("BASIC");
  PATCHER.registerGroup("ConstrainedTokenBorder");

  if ( MODULES_ACTIVE.LEVELS ) PATCHER.registerGroup("LEVELS");
  else PATCHER.registerGroup("NO_LEVELS");

  if ( game.system.id === "dnd5e" ) {
    if ( MODULES_ACTIVE.MIDI_QOL ) PATCHER.registerGroup("DND5E_NO_MIDI")
    else PATCHER.registerGroup("DND5E_MIDI");
  }

  if ( game.system.id === "sfrpg" ) PATCHER.registerGroup("sfrpg");
}
