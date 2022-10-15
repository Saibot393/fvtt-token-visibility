/* globals
Token,
canvas,
game,
ClockwiseSweepPolygon,
foundry,
PIXI
*/
"use strict";

import { MODULE_ID } from "./const.js";
import { SETTINGS, getSetting } from "./settings.js";
import { lineSegmentCrosses, walkLineIncrement, log } from "./util.js";
import { Point3d } from "./Point3d.js";
import { Shadow } from "./Shadow.js";
import { ClipperPaths } from "./ClipperPaths.js";
import * as drawing from "./drawing.js";

/* Visibility algorithm
Three tests, increasing in difficulty and stringency. User can select between 0% and 100%
of token area that must be seen to be visible. 0% means any tiny portion counts. User can
also adjust the token size up or down. For example, you might want only the inner 80% of
the token to count. Or for a particularly large creature that expands beyond its token
(dragon!) you might make it 120% of the token size.

Tests:
1. Center point to test LOS and FOV.
< 50% area: If the center point is within the LOS/FOV , the token is visibile. Return if true.
> 50% area: Center point must be seen, but is not sufficient in itself, to be visible.
            Filter sources that do not meet this criterion.

After this point, constrain the token shape such that if it overlaps a wall, the shape
is trimmed accordingly.

2. Visibility polygon to test LOS.
Draw rays from the vision source origin to the viewable edges of the constrained token shape.
Test if a wall intersects (blocks) both rays.

If no walls present, then we are done; return true.
If not testing area, then if walls only block one side, we are done; return true.
If a wall blocks both rays, then we are done; return false.

3. Intersect test.
Intersect the constrained token shape against the source los or fov. If not testing area,
then it is sufficient to test if the constrained token shape intersects the los/fov.

1 + 3 alone appear to do better than 1 + 2 + 3, so skipping 2 for now.
*/


/* Token visibility testing workflow
Token.prototype.isVisible
- Constructs "tolerance" based on width and height of token
- Calls canvas.effects.visibility.testVisibility(this.center, {tolerance, object: this})

CanvasVisibility.prototype.testVisibility
- Prepares array of points based on tolerance. Default is 2 px. Either [0, 0] or
  set of 9 points: center, 8 points arranged in square, tolerance away from center
- Creates a config = { object, tests: offsets.map(o => point, los)}
- Calls lightSource.testVisibility for each active lightSource
- Calls modes.basicSight.testVisibility for each visionSource. (basic detection test)
- Calls detectionMode.testVisibility on each vision source with special detection modes

DetectionMode.prototype.testVisibility
- Calls DetectionMode.prototype._canDetect for the given visionSource and object
- Calls DetectionMode.prototype._testPoint for each test object (test point) for the given visionSource and object

DetectionMode.prototype._canDetect
- Theoretical detection; should not consider relative positions of objects

DetectionMode.prototype._testPoint
- For given point, call _testLOS
- For given point, call _testRange

DetectionMode.prototype._testLOS
- Tests whether the visionSource.los contains the test point

DetectionMode.prototype._testRange
- Tests whether the test point is within range of a light source visionSource.object.getLightRadius

*/


/* Token range options
CENTER
√ Wrap CanvasVisibility.prototype.testVisibility to intercept the tolerance option.

FOUNDRY
- Default, just wrap

FOUNDRY_3D
√ Wrap _testRange and call 2 times per point (top, bottom). Also test the dead center first.

3D: test range in 3 dimensions. Always do this for 2d as well.
√ Wrap _testRange and test 3d distance if _testRange returns true.
(The 3d distance will always be >= than 2d distance)
*/

/* Token los options
POINTS
- Base Foundry (Don't need to shift points to top and bottom)

AREA
- Constrain token boundary by walls.
- Determine overlap area between token boundary and LOS.

3D: Cast shadows to token elevation (top if viewer is looking down; bottom if viewer is looking up)
  Block off token boundary covered by shadows, determine remaining token area.

*/


// ***** WRAPPERS

/**
 * Wrap PointSource.prototype._createPolygon
 * Add a map to temporarily store shadows
 */
export function _createPolygonPointSource(wrapped) {
  this._losShadows ??= new Map();
  this._losShadows.clear();

  return wrapped();
}

/**
 * Wrap PointSource.prototype._update

/**
 * Wrap CanvasVisibility.prototype.testVisibility
 * Set tolerance to zero, to cause only a single centerpoint to be tested, for RANGE.CENTER.
 * @param {Point} point                         The point in space to test, an object with coordinates x and y.
 * @param {object} [options]                    Additional options which modify visibility testing.
 * @param {number} [options.tolerance=2]        A numeric radial offset which allows for a non-exact match.
 *                                              For example, if tolerance is 2 then the test will pass if the point
 *                                              is within 2px of a vision polygon.
 * @param {PIXI.DisplayObject} [options.object] An optional reference to the object whose visibility is being tested
 * @returns {boolean}                           Whether the point is currently visible.
 */
export function testVisibilityCanvasVisibility(wrapped, point, {tolerance=2, object=null}={}) {
  const algorithm = getSetting(SETTINGS.RANGE.ALGORITHM);
  if ( object instanceof Token && algorithm === SETTINGS.RANGE.TYPES.CENTER ) tolerance = 0;
  return wrapped(point, { tolerance, object });
}


/**
 * Wrap DetectionMode.prototype.testVisibility
 * Create extra points if necessary
 * @param {VisionSource} visionSource           The vision source being tested
 * @param {TokenDetectionMode} mode             The detection mode configuration
 * @param {CanvasVisibilityTestConfig} config   The visibility test configuration
 * @returns {boolean}                           Is the test target visible?
 */
export function testVisibilityDetectionMode(wrapped, visionSource, mode, {object, tests}={}) {
  const debug = game.modules.get(MODULE_ID).api.debug;
  debug && drawing.clearDrawings();
  tests = elevatePoints(tests, visionSource, object);

  if ( getSetting(SETTINGS.LOS.ALGORITHM) === SETTINGS.LOS.TYPES.AREA ) {
    // link tests to the center test for los area
    const ln = tests.length;
    for ( let i = 1; i < ln; i += 1 ) {
      tests[i].centerPoint = tests[0];
    }
  }

  return wrapped(visionSource, mode, { object, tests });
}

/**
 * @param {object[]} tests                      Test object, containing point and los Map
 * @param {VisionSource} visionSource           The vision source being tested
 * @param {PlaceableObject} object              The target placeable
 * @returns {object[]} tests, with elevation and possibly other tests added.
 */
function elevatePoints(tests, visionSource, object) {
  if ( !(object instanceof Token) ) return tests;

  // Create default elevations
  const objectHeight = object.topZ - object.bottomZ;
  const avgElevation = object.bottomZ + (objectHeight * 0.5);
  for ( const test of tests ) {
    test.point.z ??= avgElevation;
  }

  // If top/bottom equal or not doing 3d points, no need for extra test points
  if ( !objectHeight || getSetting(SETTINGS.RANGE.ALGORITHM) !== SETTINGS.RANGE.TYPES.FOUNDRY_3D ) {
    return tests;
  }

  // Add points to the tests array representing top and bottom
  const tests3d = [tests[0]];
  const ln = tests.length;
  for ( let i = 1; i < ln; i += 1 ) {
    const test = tests[i];
    const { x, y } = test.point;
    if ( test.los.size > 0 ) console.warn("Test point has los mapping already.");

    tests3d.push(
      // Use the same map so that x,y contains tests are cached and not repeated.
      buildTestObject(x, y, object.topZ, test.los),
      buildTestObject(x, y, object.bottomZ, test.los)
    );
  }

  return tests3d;
}

/**
 * Helper function to construct a test object for testVisiblity
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {object}  Object with { point, los }
 *  See CanvasVisibility.prototype.testVisibility
 */
function buildTestObject(x, y, z = 0, los = new Map()) {
  return { point: new Point3d(x, y, z), los };
}

/**
 * Wrap DetectionMode.prototype._testRange
 * If using RANGE.FOUNDRY_3D, shift points to top and bottom.
 * Test 3d if 2d range is true.
 * @param {VisionSource} visionSource           The vision source being tested
 * @param {TokenDetectionMode} mode             The detection mode configuration
 * @param {PlaceableObject} target              The target object being tested
 * @param {CanvasVisibilityTest} test           The test case being evaluated
 * @returns {boolean}                           Is the target within range?
 */
export function _testRangeDetectionMode(wrapper, visionSource, mode, target, test) {
  const debug = game.modules.get(MODULE_ID).api.debug;

  const inRange = wrapper(visionSource, mode, target, test);
  if ( !(target instanceof Token) || !inRange ) {
    debug && drawing.drawPoint(test.point, { color: inRange ? drawing.COLORS.green : drawing.COLORS.red });
    return inRange;
  }

  const radius = visionSource.object.getLightRadius(mode.range);
  const dx = test.point.x - visionSource.x;
  const dy = test.point.y - visionSource.y;
  const dz = test.point.z - visionSource.elevationZ;
  const inRange3d = ((dx * dx) + (dy * dy) + (dz * dz)) <= (radius * radius);
  debug && drawing.drawPoint(test.point, { alpha: 1, radius: 3, color: inRange3d ? drawing.COLORS.green : drawing.COLORS.red });

  return inRange3d;
}

/**
 * Wrap Token.prototype.updateVisionSource
 * Reset the constrained token shape when updating vision for a token.
 * @param {Function} wrapper
 * @param {object} [options]        Options which affect how the vision source is updated
 * @param {boolean} [options.defer]     Defer refreshing the LightingLayer to manually call that refresh later.
 * @param {boolean} [options.deleted]   Indicate that this vision source has been deleted.
 *
 */
export function tokenUpdateVisionSource(wrapped, { defer=false, deleted=false }={}) {
  // Remove the prior constrained shape, if any
  this._constrainedTokenShape = undefined;
  return wrapped({ defer, deleted });
}

/**
 * Wrap DetectionMode.prototype._testLOS
 */
export function _testLOSDetectionMode(wrapped, visionSource, mode, target, test) {
  const debug = game.modules.get(MODULE_ID).api.debug;

  // Only apply this test to tokens
  if ( !(target instanceof Token) ) return wrapped(visionSource, mode, target, test);

  const algorithm = getSetting(SETTINGS.LOS.ALGORITHM);
  if ( algorithm === SETTINGS.LOS.TYPES.POINTS ) {
    let hasLOS = wrapped(visionSource, mode, target, test);
    hasLOS = testLOSPoint(visionSource, target, test, hasLOS);
    debug && drawing.drawPoint(test.point, { alpha: .2, radius: 7, color: hasLOS ? drawing.COLORS.green : drawing.COLORS.red });

    return hasLOS;

  } else if ( algorithm === SETTINGS.LOS.TYPES.AREA ) {
    // Only need to test area once, so use the center point to do this.
    const avgElevation = target.bottomZ + ((target.topZ - target.bottomZ) * 0.5);
    const center = new Point3d(target.center.x, target.center.y, avgElevation);

    if ( !test.point.almostEqual(center) ) return test.centerPoint.hasLOSArea;

    let hasLOS = wrapped(visionSource, mode, target, test);
    hasLOS = testLOSArea(visionSource, target, hasLOS);
    test.hasLOSArea = hasLOS;
    return hasLOS;
  }
}

export function testLOSPoint(visionSource, target, test, hasLOS ) {
  // If not in the line of sight, no need to test for wall collisions
  if ( !hasLOS ) return false;

  // If no wall heights, then don't bother checking wall collisions
  if ( !game.modules.get("wall-height")?.active ) return true;

  // Test shadows and return true if not in shadow?

  // Test all non-infinite walls for collisions
  const origin = new Point3d(visionSource.x, visionSource.y, visionSource.elevationZ);
  return !ClockwiseSweepPolygon.testCollision3d(origin, test.point, { type: "sight", mode: "any", wallTypes: "limited" });
}

export function testLOSArea(visionSource, target, hasLOS) {
  const percentArea = getSetting(SETTINGS.LOS.PERCENT_AREA);
  const boundsScale = 1;
//   const boundsScale = getSetting(SETTINGS.VISION.BOUNDS_SCALE);

  // If less than 50% of the token area is required to be viewable, then
  // if the center point is viewable, the token is viewable from that source.
  if ( hasLOS && percentArea < 0.50 ) return true;

  // If more than 50% of the token area is required to be viewable, then
  // the center point must be viewable for the token to be viewable from that source.
  // (necessary but not sufficient)
  if ( !hasLOS && percentArea >= 0.50 ) return false;

  // Construct the constrained token shape if not yet present.
  // Store in token so it can be re-used (wrapped updateVisionSource will remove it when necessary)
  target._constrainedTokenShape ||= constrainedTokenShape(target, { boundsScale });
  const constrained = target._constrainedTokenShape;

  // Test top and bottom of target shape.
  let shadowLOSBottom;
  let shadowLOSTop;
  const inBetween = visionSource.elevationZ < target.topZ && visionSource.elevationZ > target.bottomZ;
  if ( inBetween || visionSource.elevationZ < target.bottomZ ) {
    // Looking up at bottom
    shadowLOSBottom = shadowPolygonForElevation(visionSource, target.bottomZ);
  }

  if ( inBetween || visionSource.elevationZ > target.topZ ) {
    // Looking down at top
    shadowLOSTop = shadowPolygonForElevation(visionSource, target.topZ);
  }

  // Do area test on both if necessary
  if ( shadowLOSTop && shadowLOSBottom ) {
    return areaTest(shadowLOSTop, constrained) || areaTest(shadowLOSBottom, constrained);
  }

  // Find the one to test
  const shadowed = shadowLOSTop ?? shadowLOSBottom ?? visionSource.los;
  return areaTest(shadowed, constrained);
}

/**
 * Test if the constrained token shape is sufficiently large to be seen given the
 * chosen area percentage.
 */
export function areaTest(los, constrainedTokenShape) {
  const debug = game.modules.get(MODULE_ID).api.debug;
  const percentArea = getSetting(SETTINGS.LOS.PERCENT_AREA);

  if ( percentArea === 0 ) {
    // If percentArea equals zero, it might be possible to skip intersectConstrainedShapeWithLOS
    // and instead just measure if a token boundary has been breached.
    if ( los instanceof ClipperPaths ) los = los.simplify();

    if ( !(los instanceof ClipperPaths) ) {
      const hasLOS = sourceIntersectsPolygonBounds(los, constrainedTokenShape);
      debug && drawing.drawShape(los, { color: drawing.COLORS.blue });
      debug && drawing.drawShape(constrainedTokenShape, { color: hasLOS ? drawing.COLORS.green : drawing.COLORS.red });
      return hasLOS;
    }
  }

  let visibleTokenShape = intersectConstrainedShapeWithLOS(constrainedTokenShape, los);
  const seenArea = visibleTokenShape.area();
  if ( !seenArea || seenArea.almostEqual(0) ) return false;

  const tokenArea = constrainedTokenShape.area();
  if ( !tokenArea || tokenArea.almostEqual(0) ) return false;

  const percentSeen = seenArea / tokenArea;
  const hasLOS = percentSeen > percentArea || percentSeen.almostEqual(percentArea);

  if ( debug ) {
    if ( los instanceof ClipperPaths ) los = los.simplify();
    if ( visibleTokenShape instanceof ClipperPaths ) visibleTokenShape = visibleTokenShape.simplify();

    if ( los instanceof ClipperPaths ) {
      const polys = los.toPolygons();
      for ( const poly of polys ) {
        drawing.drawShape(poly, { color: drawing.COLORS.blue, width: poly.isHole ? 1 : 2 });
      }
    } else {
      drawing.drawShape(los, { color: drawing.COLORS.blue, width: 2 });
    }

    if ( visibleTokenShape instanceof ClipperPaths ) {
      const polys = visibleTokenShape.toPolygons();
      for ( const poly of polys ) {
        drawing.drawShape(poly, { color: hasLOS ? drawing.COLORS.green : drawing.COLORS.red });
      }
    } else {
      drawing.drawShape(visibleTokenShape, { color: hasLOS ? drawing.COLORS.green : drawing.COLORS.red });
    }
  }

  return hasLOS;

}

export function intersectConstrainedShapeWithLOS(constrained, los) {
  if ( constrained instanceof PIXI.Rectangle && los instanceof PIXI.Polygon ) {
    // Weiler-Atherton is faster for intersecting regular shapes
    // Use Clipper for now
  }

  if ( constrained instanceof PIXI.Rectangle ) constrained = constrained.toPolygon();

  return los.intersectPolygon(constrained);
}

/**
 * For a given los polygon, get the shadows at a given elevation.
 * Used to determine if there is line-of-sight to a tokken at a specific elevation with shadows.
 */
export function shadowPolygonForElevation(visionSource, targetElevation) {
  log("Building shadows.");

  // Only walls that encounter LOS will shadow the LOS
  const los = visionSource.los;
  const bounds = los.bounds;
  const collisionTest = (o, rect) => isFinite(o.t.topZ) || isFinite(o.t.bottomZ);
  const walls = canvas.walls.quadtree.getObjects(bounds, { collisionTest });

  if ( !walls.size) {
    log("No limited walls; no shadows.");
//     visionSource._losShadows.set(targetElevation, null);
    return los;
  }

  const shadows = [];
  for ( const wall of walls ) {
    const shadow = Shadow.construct(wall, visionSource, targetElevation);
    if ( shadow ) shadows.push(shadow);
  }

  const combined = Shadow.combinePolygonWithShadows(los, shadows);
//   visionSource._losShadows.set(targetElevation, combined);
  return combined;
}

// ***** API



// ***** FUNCTIONS

/**
 * Does the source intersect the bounding box?
 * @param {PIXI.Polygon} source
 * @param {PIXI.Rectangle} bbox
 * @return {boolean} True if the bbox intersects the source.
 */
function sourceIntersectsBounds(source, bbox) {
  for ( const si of source.iterateEdges() ) {
    if ( bbox.lineSegmentIntersects(si.A, si.B,
      { intersectFn: foundry.utils.lineSegmentIntersects }) ) return true;
  }
  return false;
}

/**
 * Stricter intersection test between polygon and a constrained token bounds.
 * 1. Overlapping edges are not considered intersecting.
 * 2. endpoints that overlap the other segment are not considered intersecting.
 * 3. bounds rectangle used to skip edges
 *
 * (1) and (2) are to avoid situations in which the boundary polygon and the source polygon
 * are separated by a wall.
 */
function sourceIntersectsPolygonBounds(source, bounds) {
  if ( bounds instanceof PIXI.Rectangle ) return sourceIntersectsBounds(source, bounds);
  const bbox = bounds.getBounds();

  const bounds_edges = [...bounds.iterateEdges()];
  const ln2 = bounds_edges.length;

  // TO-DO: should inside be true or false?
  const edges = [...source.iterateEdges()].filter(e => bbox.lineSegmentIntersects(e.A, e.B, { inside: true }));
  return bounds.linesCross(edges);
}

/**
 * Intersect the token bounds against line-of-sight polygon to trim the token bounds
 * to only that portion that does not overlap a wall.
 * @param {Token} token
 * @return {PIXI.Polygon}
 */
export function constrainedTokenShape(token, { boundsScale } = {}) {
//   boundsScale ??= getSetting(SETTINGS.BOUNDS_SCALE);
  boundsScale ??= 1;

  let bbox = token.bounds;
  if ( boundsScale !== 1) {
    // BoundsScale is a percentage where less than one means make the bounds smaller,
    // greater than one means make the bounds larger.
    const scalar = boundsScale - 1;
    bbox.pad(Math.ceil(bbox.width * scalar), Math.ceil(bbox.height * scalar)); // Prefer integer values; round up to avoid zeroes.
  }

  let walls = Array.from(canvas.walls.quadtree.getObjects(bbox).values());
  if ( !walls.length ) return bbox;

  // Only care about walls that strictly intersect the bbox or are inside the bbox.
  // Many times with a grid, a wall will overlap a bbox edge.
  walls = walls.filter(w =>
    bbox.lineSegmentIntersects(w.A, w.B, { inside: true, intersectFn: foundry.utils.lineSegmentIntersects }));

  // Don't include walls that are in line with a boundary edge
  walls = walls.filter(w => {
    if ( w.A.x === w.B.x && (w.A.x === bbox.left || w.A.x === bbox.right) ) return false;
    if ( w.A.y === w.B.y && (w.A.y === bbox.top || w.A.y === bbox.bottom) ) return false;
    return true;
  });

  if ( !walls.length ) return bbox;

  // One or more walls are inside or intersect the bounding box.
  const constrained = new ClockwiseSweepPolygon();
  constrained.initialize(token.center, { type: "sight", source: token.vision, boundaryShapes: [bbox] });
  constrained.compute();

  // Check if we are basically still dealing with an unconstrained token shape, b/c
  // that is faster than dealing with an arbitrary polygon.
  if ( constrained.points.length !== 10 ) return constrained;

  for ( const pt of constrained.iteratePoints({ close: false }) ) {
    if ( !(pt.x.almostEqual(bbox.left) || pt.x.almostEqual(bbox.right)) ) return constrained;
    if ( !(pt.x.almostEqual(bbox.top) || pt.y.almostEqual(bbox.bottom)) ) return constrained;
  }

  return bbox;
}
