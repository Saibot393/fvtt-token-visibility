/* globals
CONFIG,
Token,
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */
"use strict";

import { MODULES_ACTIVE } from "./const.js";
import { SETTINGS, getSetting } from "./settings.js";

// Patches for the CanvasVisibility class
export const PATCHES = {};
PATCHES.BASIC = {};

// ----- NOTE: Wraps ----- //

/**
 * Mixed wrap CanvasVisibility.prototype.testVisibility
 * Set tolerance to zero, to cause only a single centerpoint to be tested, for RANGE.CENTER.
 * @param {Point} point                         The point in space to test, an object with coordinates x and y.
 * @param {object} [options]                    Additional options which modify visibility testing.
 * @param {number} [options.tolerance=2]        A numeric radial offset which allows for a non-exact match.
 *                                              For example, if tolerance is 2 then the test will pass if the point
 *                                              is within 2px of a vision polygon.
 * @param {PIXI.DisplayObject} [options.object] An optional reference to the object whose visibility is being tested
 * @returns {boolean}                           Whether the point is currently visible.
 */
function testVisibility(wrapped, point, {tolerance=2, object=null}={}) {
  if ( !(object instanceof Token) ) return wrapped(point, { tolerance, object });

  if ( MODULES_ACTIVE.LEVELS ) {
    // Reset the tolerance
    tolerance = Math.min(object.w, object.h) / 4;

    // Prevent Levels from messing with the Sweep contains method during this visibility test.
    CONFIG.Levels.visibilityTestObject = undefined;
  }

  if ( getSetting(SETTINGS.RANGE.ALGORITHM) === SETTINGS.RANGE.TYPES.CENTER ) tolerance = 0;

  return wrapped(point, { tolerance, object });
}

PATCHES.BASIC.WRAPS = { testVisibility };
