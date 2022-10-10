/* globals
Hooks,
game
*/
"use strict";

import { MODULE_ID } from "./const.js";
import * as bench from "./benchmark.js";
import { registerLibWrapperMethods, patchHelperMethods } from "./patching.js";
import { registerPIXIPolygonMethods } from "./PIXIPolygon.js";
import { objectIsVisible, objectHasCoverFromToken, constrainedTokenShape } from "./token_visibility.js";
import { registerSettings } from "./settings.js";
import { GJK2D } from "./GJK-EPA.js";

Hooks.once("init", async function() {
  registerLibWrapperMethods();
  patchHelperMethods();
  registerPIXIPolygonMethods();

  game.modules.get(MODULE_ID).api = {
    objectIsVisible,
    objectHasCoverFromToken,
    constrainedTokenShape,
    GJK2D,
    bench
  };
});

Hooks.once("setup", async function() {
  registerSettings();
});

/**
 * Tell DevMode that we want a flag for debugging this module.
 * https://github.com/League-of-Foundry-Developers/foundryvtt-devMode
 */
Hooks.once("devModeReady", ({ registerPackageDebugFlag }) => {
  registerPackageDebugFlag(MODULE_ID);
});

