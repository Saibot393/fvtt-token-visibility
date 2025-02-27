/* globals
PIXI,
canvas,
foundry,
Token,
CONST,
Ray,
LimitedAnglePolygon,
CONFIG,
ClipperLib
*/
"use strict";

/* Area 3d
Rotate canvas such that the view is the token looking directly at the target.
(Doom view)
- Y axis becomes the z axis. 0 is the token center.
- X axis is the line perpendicular to the line between token and target centers.

For target, use the constrained target points.

Walls:
- Transform all walls that intersect the boundary between token center and target shape
  in original XY coordinates.
- Construct shadows based on new rotated coordinates.

- Some points of the target and walls may be contained; find the perimeter. Use convex hull

Area:
- Unblocked target area is the denominator.
- Wall shapes block and shadows block. Construct the blocked target shape and calc area.
*/

import { MODULE_ID, FLAGS, MODULES_ACTIVE, DEBUG } from "./const.js";
import { getSetting, SETTINGS } from "./settings.js";
import { log, buildTokenPoints } from "./util.js";
import { ConstrainedTokenBorder } from "./ConstrainedTokenBorder.js";

import { Draw } from "./geometry/Draw.js"; // For debugging

import { ClipperPaths } from "./geometry/ClipperPaths.js";
import { Matrix } from "./geometry/Matrix.js";
import { Point3d } from "./geometry/3d/Point3d.js";

import { DrawingPoints3d } from "./PlaceablesPoints/DrawingPoints3d.js";
import { TokenPoints3d } from "./PlaceablesPoints/TokenPoints3d.js";
import { TilePoints3d } from "./PlaceablesPoints/TilePoints3d.js";
import { WallPoints3d } from "./PlaceablesPoints/WallPoints3d.js";

// Debugging pop-up
import { area3dPopoutData } from "./Area3dPopout.js";


export class Area3d {

  /** @type {VisionSource} */
  viewer;

  /** @type {Point3d} */
  _viewerCenter;

  /** @type {Token} */
  target;

  /** @type {TokenPoints3d} */
  _targetTokenPoints3d;

  /** @type {Point3d} */
  _targetTop;

  /** @type {Point3d} */
  _targetBottom;

  /** @type {Point3d} */
  _targetCenter;

  /**
   * @typedef Area3dConfig  Configuration settings for this class.
   * @type {object}
   * @property {CONST.WALL_RESTRICTION_TYPES} type    Type of vision source
   * @property {boolean} wallsBlock                   Do walls block vision?
   * @property {boolean} tilesBlock                   Do tiles block vision?
   * @property {boolean} deadTokensBlock              Do dead tokens block vision?
   * @property {boolean} liveTokensBlock              Do live tokens block vision?
   * @property {boolean} useShadows                   For benchmarking and debugging
   * @property {boolean} debugDrawObjects             Draw blockingObjectPoints if true
   */

  /** @type object */
  config = {};

  /** @type {boolean} */
  #debug = false;

  /** @type {Draw} **/
  drawTool = new Draw();

  /**
   * Holds Foundry objects that are within the vision triangle.
   * @typedef BlockingObjects
   * @type {object}
   * @property {Set<Drawing>} drawing
   * @property {Set<Wall>}    terrainWalls
   * @property {Set<Tile>}    tiles
   * @property {Set<Token>}   tokens
   * @property {Set<Wall>}    walls
   */
  _blockingObjects = {
    drawings: new Set(),
    terrainWalls: new Set(),
    tiles: new Set(),
    tokens: new Set(),
    walls: new Set()
  };

  /**
   * Holds arrays of processed blocking points from _blockingObjects.
   * @typedef BlockingPoints
   * @type {object}
   * @type {object}:
   * @property {HorizontalPoints3d[]}   drawings
   * @property {VerticalPoints3d[]}     terrainWalls
   * @property {HorizontalPoints3d[]}   tiles
   * @property {(VerticalPoints3d|HorizontalPoints3d)[]}     tokens
   * @property {VerticalPoints3d[]}     walls
   */
  _blockingPoints = {
    drawings: [],
    terrainWalls: [],
    tiles: [],
    tokens: [],
    walls: []
  };

  /**
   * Debug/temp object that holds the converted Foundry blockingObjects as PlanePoints3d.
   * @typedef {BlockingObjectsPoints}
   * @type {object}:
   * @property {Set<DrawingPoints3d>} drawing
   * @property {Set<WallPoints3d>}    terrainWalls
   * @property {Set<TilePoints3d>}    tiles
   * @property {Set<TokenPoints3d>}   tokens
   * @property {Set<WallPoints3d>}    walls
   */
  _blockingObjectsPoints = {
    drawings: new Set(),
    terrainWalls: new Set(),
    tiles: new Set(),
    tokens: new Set(),
    walls: new Set()
  };

  /**
   * The viewable area between viewer and target.
   * Typically, this is a triangle, but if viewed head-on, it will be a triangle
   * with the portion of the target between viewer and target center added on.
   * @type {PIXI.Polygon}
   */
  _visionPolygon;

  /** @type {Shadow[]} */
  wallShadows = [];

  /** @type {boolean} */
  _viewIsSet = false;

  /** @type {boolean} */
  _blockingObjectsAreSet = false;

  /** @type {boolean} */
  _blockingObjectsPointsAreSet = false;

  /** @type {boolean} */
  _blockingPointsAreSet = false;

  /**
   * Vector representing the up position on the canvas.
   * Used to construct the token camera and view matrices.
   * @type {Point3d}
   */
  static _upVector = new Point3d(0, 0, -1);

  /**
   * Scaling factor used with Clipper
   */
  static SCALING_FACTOR = 100;

  /**
   * @param {VisionSource|TOKEN} visionSource     Token, viewing from token.topZ.
   * @param {Target} target   Target; token is looking at the target center.
   */
  constructor(viewer, target, config = {}) {

    this.viewer = viewer instanceof Token ? viewer.vision : viewer;
    this.target = target;
    this._targetPoints = new TokenPoints3d(target);

    // Configuration options
    this.#configure(config);

    // Set debug only if the target is being targeted.
    // Avoids "double-vision" from multiple targets for area3d on scene.
    if ( DEBUG.area ) {
      const targets = canvas.tokens.placeables.filter(t => t.isTargeted);
      this.debug = targets.some(t => t === target);
    }
  }

  get debug() { return this.#debug; }

  set debug(value) {
    this.#debug = Boolean(value);

    // Turn on popout for the debug
    if ( this.#debug ) {
      if ( !area3dPopoutData.shown ) area3dPopoutData.app.render(true);
      this.drawTool = new Draw(area3dPopoutData.app.graphics);
      this.drawTool.clearDrawings();
    }
  }

  /**
   * Initialize the configuration for this constructor.
   * @param {object} config   Settings intended to override defaults.
   */
  #configure(config = {}) {
    config.type ??= "sight";
    config.wallsBlock ??= true;
    config.tilesBlock ??= MODULES_ACTIVE.LEVELS || MODULES_ACTIVE.EV;
    config.deadTokensBlock ??= false;
    config.liveTokensBlock ??= false;
    config.proneTokensBlock ??= true;

    // Not user-facing. For debugging and benchmarking shadows
    config.useShadows ??= getSetting(SETTINGS.AREA3D_USE_SHADOWS);

    // Internal setting.
    // If true, draws the _blockingObjectsPoints.
    // If false, draws the _blockingPoints
    this.config.debugDrawObjects ??= false;

    this.config = config;
  }


  // NOTE ----- USER-FACING METHODS -----

  /**
   * Determine whether a visionSource has line-of-sight to a target based on the percent
   * area of the target visible to the source.
   * @param {number} [thresholdArea]    Area required to have LOS between 0 and 1
   *   0% means any line-of-sight counts.
   *   100% means the entire token must be visible.
   * @returns {boolean}
   */
  hasLOS(thresholdArea) {
    thresholdArea ??= getSetting(SETTINGS.LOS.PERCENT_AREA);

    // If center point is visible, then target is likely visible but not always.
    // e.g., walls slightly block the center point. Or walls block all but center.

    const percentVisible = this.percentAreaVisible();
    if ( percentVisible.almostEqual(0) ) return false;
    return (percentVisible > thresholdArea) || percentVisible.almostEqual(thresholdArea);
  }

  /**
   * Determine the percentage area of the 3d token visible to the viewer.
   * Measured by projecting the 3d token to a 2d canvas representing the viewer's perspective.
   * @returns {number}
   */
  percentAreaVisible() {
    if ( !this._targetWithinLimitedAngleVision() ) return 0;

    const objs = this.blockingObjects;
    if ( !this.debug
      && !objs.walls.size
      && !objs.tiles.size
      && !objs.tokens.size
      && objs.terrainWalls.size < 2 ) return 1;

    const { obscuredSides, sidePolys } = this._obscureSides();

    const sidesArea = sidePolys.reduce((area, poly) =>
      area += poly.scaledArea({scalingFactor: Area3d.SCALING_FACTOR}), 0);
    const obscuredSidesArea = obscuredSides.reduce((area, poly) =>
      area += poly.scaledArea({scalingFactor: Area3d.SCALING_FACTOR}), 0);
    let percentSeen = sidesArea ? obscuredSidesArea / sidesArea : 0;

    if ( this.debug ) {
      const colors = Draw.COLORS;
      this._drawLineOfSight();

      // Draw the detected objects on the canvas
      objs.walls.forEach(w => Draw.segment(w, { color: colors.blue }));
      objs.tiles.forEach(t => Draw.shape(t.bounds, { color: colors.yellow, fillAlpha: 0.5 }));
      objs.terrainWalls.forEach(w => Draw.segment(w, { color: colors.lightgreen }));
      objs.drawings.forEach(d => Draw.shape(d.bounds, { color: colors.gray, fillAlpha: 0.5 }));
      objs.tokens.forEach(t => Draw.shape(t.constrainedTokenBorder, { color: colors.orange, fillAlpha: 0.5 }));

      // Draw the target in 3d, centered on 0,0
      this.targetPoints.drawTransformed({ drawTool: this.drawTool });

      // Fill in the constrained border on canvas
      Draw.shape(this.target.constrainedTokenBorder, { color: colors.red, fillAlpha: 0.5});

      // Draw the detected objects in 3d, centered on 0,0
      const pts = this.config.debugDrawObjects ? this.blockingObjectsPoints : this.blockingPoints;
      const drawTool = this.drawTool;
      pts.walls.forEach(w => w.drawTransformed({ color: colors.blue, drawTool }));
      pts.tiles.forEach(w => w.drawTransformed({ color: colors.yellow, drawTool }));
      pts.drawings.forEach(d => d.drawTransformed({ color: colors.gray, fillAlpha: 0.7, drawTool }));
      pts.tokens.forEach(t => t.drawTransformed({ color: colors.orange, drawTool }));
      pts.terrainWalls.forEach(w => w.drawTransformed({ color: colors.lightgreen, fillAlpha: 0.1, drawTool }));

      // Calculate the areas of the target faces separately, along with the obscured side areas.
      const target = this.target;
      const { topZ, bottomZ } = target;
      const height = topZ - bottomZ;
      this.debugSideAreas = {
        top: target.w * target.h,
        ogSide1: target.w * height,
        ogSide2: target.h * height,
        sides: [],
        obscuredSides: []
      };
      this.debugSideAreas.sides = sidePolys.map(poly =>
        poly.scaledArea({scalingFactor: Area3d.SCALING_FACTOR}));
      this.debugSideAreas.obscuredSides = obscuredSides.map(poly =>
        poly.scaledArea({scalingFactor: Area3d.SCALING_FACTOR}));

      // Report the percent seen that is being returned.
      console.log(`${this.viewer.object.name} sees ${percentSeen * 100}% of ${this.target.name} (Area3d).`);
    }

    // Round the percent seen so that near-zero areas are 0.
    // Because of trimming walls near the vision triangle, a small amount of token area can poke through
    if ( percentSeen < 0.005 ) percentSeen = 0;

    return percentSeen;
  }

  // NOTE ----- GETTERS / SETTERS ----- //

  /**
   * @type {TokenPoints3d}
   */
  get targetPoints() { return this._targetPoints; }

  /** @type {BlockingObjects} */
  get blockingObjects() {
    if ( !this._blockingObjectsAreSet ) this._findBlockingObjects();
    return this._blockingObjects;
  }

  /** @type {BlockingObjectsPoints} */
  get blockingObjectsPoints() {
    if ( !this._blockingObjectsPointsAreSet ) this._constructBlockingObjectsPoints();
    return this._blockingObjectsPoints;
  }

  /** @type {BlockingPoints} */
  get blockingPoints() {
    if ( !this._blockingPointsAreSet ) this._constructBlockingPointsArray();
    return this._blockingPoints;
  }

  /**
   * @type {object}
  /**
   * Get the array of sides, obscured by walls and shadows, if any.
   */
  get obscuredSides() {
    return this._obscuredSides || (this._obscuredSides = this._obscureSides());
  }

  get viewerViewM() {
    if ( !this._viewerViewM ) this.viewerCameraM; // eslint-disable-line no-unused-expressions
    return this._viewerViewM;
  }

  get viewerCameraM() {
    if ( !this._viewerCameraM ) {
      const { M, Minv } = this._calculateViewerCameraMatrix();
      this._viewerCameraM = M;
      this._viewerViewM = Minv;
    }

    return this._viewerCameraM;
  }

  get viewerCenter() {
    return this._viewerCenter
      || (this._viewerCenter = new Point3d(this.viewer.x, this.viewer.y, this.viewer.elevationZ));
  }

  get targetTop() {
    if ( typeof this._targetTop === "undefined" ) {
      const pts = Point3d.fromToken(this.target);
      this._targetTop = pts.top;
      this._targetBottom = pts.bottom;
    }

    return this._targetTop;
  }

  get targetBottom() {
    if ( typeof this._targetTop === "undefined" ) {
      const pts = Point3d.fromToken(this.target);
      this._targetTop = pts.top;
      this._targetBottom = pts.bottom;
    }

    return this._targetBottom;
  }

  get targetCenter() {
    return this._targetCenter || (this._targetCenter = Point3d.fromTokenCenter(this.target));
  }

  /** @type {PIXI.Polygon} */
  get visionPolygon() {
    return this._visionPolygon || (this._visionPolygon = Area3d.visionPolygon(this.viewerCenter, this.target));
  }

  // NOTE ----- STATIC METHODS ----- //

  /**
   * Vision Polygon for the view point --> target.
   * From the given token location, get the edge-most viewable points of the target.
   * Construct a triangle between the two target points and the token center.
   * If viewing head-on (only two key points), the portion of the target between
   * viewer and target center (typically, a rectangle) is added on to the triangle.
   * @param {PIXI.Point|Point3d} viewingPoint
   * @param {Token} target
   * @returns {PIXI.Polygon} Triangle between view point and target. Will be clockwise.
   */
  static visionPolygon(viewingPoint, target) {
    const border = target.constrainedTokenBorder;
    const keyPoints = border.viewablePoints(viewingPoint, { outermostOnly: false });
    if ( !keyPoints ) {
      log("visionPolygon: key points are null.");
      return border.toPolygon();
    }

    let out;
    switch ( keyPoints.length ) {
      case 0:
      case 1:
        log(`visionPolygon: only ${keyPoints.length} key points found.`);
        out = border.toPolygon();
        break;
      case 2: {
        const k0 = keyPoints[0];
        const k1 = keyPoints[1];
        const center = target.center;

        // Build a rectangle between center and key points.
        // Intersect against the border
        const X = Math.minMax(k0.x, k1.x, center.x);
        const Y = Math.minMax(k0.y, k1.y, center.y);
        const rect = new PIXI.Rectangle(X.min, Y.min, X.max - X.min, Y.max - Y.min);
        const intersect = border instanceof PIXI.Rectangle ? rect : rect.intersectPolygon(border);

        // Union the triangle with this border
        const triangle = new PIXI.Polygon([viewingPoint, k0, k1]);

        // WA requires a polygon with a positive orientation.
        if ( !triangle.isPositive ) triangle.reverseOrientation();
        out = intersect.intersectPolygon(triangle, { clipType: ClipperLib.ClipType.ctUnion });
        break;
      }
      default:
        out = new PIXI.Polygon([viewingPoint, keyPoints[0], keyPoints[keyPoints.length - 1]]);
    }

    if ( !out.isClockwise ) out.reverseOrientation();
    return out;
  }

  /**
   * Filter relevant objects in the scene using the vision triangle.
   * For the z dimension, keeps objects that are between the lowest target point,
   * highest target point, and the viewing point.
   * @param {Point3d} viewingPoint    The 3d location of the "viewer" (vision/light source)
   * @param {Token} target            The token being "viewed".
   * @param {object} [options]        Options that affect what is filtered.
   * @param {string} [options.type]           Wall restriction type: sight, light, move, sound. Used to filter walls.
   * @param {boolean} [options.filterWalls]   If true, find and filter walls
   * @param {boolean} [options.filterTokens]  If true, find and filter tokens
   * @param {boolean} [options.filterTiles]   If true, find and filter tiles
   * @param {Token} [options.viewer]          Viewer token to exclude from filtered token results
   * @return {object} Object with walls, tokens, tiles, drawings as distinct sets or undefined.
   */
  static filterSceneObjectsByVisionPolygon(viewingPoint, target, {
    visionPolygon,
    type = "sight",
    filterWalls = true,
    filterTokens = true,
    filterTiles = true,
    debug = false,
    viewer } = {}) {

    visionPolygon ??= Area3d.visionPolygon(viewingPoint, target);
    if ( debug ) Draw.shape(visionPolygon,
      { color: Draw.COLORS.blue, fillAlpha: 0.2, fill: Draw.COLORS.blue });

    const { topZ, bottomZ } = target;
    const maxE = Math.max(viewingPoint.z ?? 0, topZ);
    const minE = Math.min(viewingPoint.z ?? 0, bottomZ);

    const out = { walls: new Set(), tokens: new Set(), tiles: new Set(), drawings: new Set() };
    if ( filterWalls ) {
      out.walls = Area3d.filterWallsByVisionPolygon(viewingPoint, visionPolygon, { type });

      // Filter walls that are definitely too low or too high
      out.walls = out.walls.filter(w => {
        return w.topZ > minE && w.bottomZ < maxE;
      });

      if ( debug ) out.walls.forEach(w => Draw.segment(w, { color: Draw.COLORS.gray, alpha: 0.2 }));
    }

    if ( filterTokens ) {
      out.tokens = Area3d.filterTokensByVisionPolygon(visionPolygon, { viewer, target });

      // Filter tokens that are definitely too low or too high
      out.tokens = out.tokens.filter(t => {
        return t.topZ > minE && t.bottomZ < maxE;
      });

      if ( debug ) out.tokens.forEach(t => Draw.shape(t.bounds, { color: Draw.COLORS.gray }));
    }

    if ( filterTiles ) {
      out.tiles = Area3d.filterTilesByVisionPolygon(visionPolygon);

      // For Levels, "noCollision" is the "Allow Sight" config option. Drop those tiles.
      if ( MODULES_ACTIVE.LEVELS && type === "sight" ) {
        out.tiles = out.tiles.filter(t => {
          return !t.document?.flags?.levels?.noCollision;
        });
      }

      // Filter tiles that are definitely too low or too high
      out.tiles = out.tiles.filter(t => {
        const tZ = CONFIG.GeometryLib.utils.gridUnitsToPixels(t.document.elevation);
        return tZ < maxE && tZ > minE;
      });

      // Check drawings if there are tiles
      if ( out.tiles.size ) out.drawings = Area3d.filterDrawingsByVisionPolygon(visionPolygon);

      if ( debug ) {
        out.tiles.forEach(t => Draw.shape(t.bounds, { color: Draw.COLORS.gray }));
        out.drawings.forEach(d => Draw.shape(d.bounds, { color: Draw.COLORS.gray }));
      }
    }

    return out;
  }

  /**
   * Filter drawings in the scene if they are flagged as holes.
   * @param {PIXI.Polygon} visionPolygon
   */
  static filterDrawingsByVisionPolygon(visionPolygon) {
    let drawings = canvas.drawings.quadtree.getObjects(visionPolygon.getBounds());

    // Filter by holes
    drawings = drawings.filter(d => d.document.getFlag(MODULE_ID, FLAGS.DRAWING.IS_HOLE)
      && ( d.document.shape.type === CONST.DRAWING_TYPES.POLYGON
      || d.document.shape.type === CONST.DRAWING_TYPES.ELLIPSE
      || d.document.shape.type === CONST.DRAWING_TYPES.RECTANGLE));

    if ( !drawings.size ) return drawings;

    // Filter by the precise triangle cone
    // Also convert to CenteredPolygon b/c it handles bounds better
    const edges = [...visionPolygon.iterateEdges()];
    drawings = drawings.filter(d => {
      const shape = CONFIG.GeometryLib.utils.centeredPolygonFromDrawing(d);
      const center = shape.center;
      if ( visionPolygon.contains(center.x, center.y) ) return true;
      const dBounds = shape.getBounds();
      return edges.some(e => dBounds.lineSegmentIntersects(e.A, e.B, { inside: true }));
    });
    return drawings;
  }

  /**
   * Filter tokens in the scene by a triangle representing the view from viewingPoint to
   * token (or other two points). Only considers 2d top-down view.
   * @param {PIXI.Polygon} visionPolygon
   * @param {object} [options]
   * @param {string|undefined} viewerId   Id of viewer token to exclude
   * @param {string|undefined} targetId   Id of target token to exclude
   * @return {Set<Token>}
   */
  static filterTokensByVisionPolygon(visionPolygon, { viewer, target } = {}) {
    let tokens = canvas.tokens.quadtree.getObjects(visionPolygon.getBounds());

    // Filter out the viewer and target token
    tokens.delete(viewer);
    tokens.delete(target);

    if ( !tokens.size ) return tokens;

    // Filter by the precise triangle cone
    // For speed and simplicity, consider only token rectangular bounds
    const edges = [...visionPolygon.iterateEdges()];
    tokens = tokens.filter(t => {
      const tCenter = t.center;
      if ( visionPolygon.contains(tCenter.x, tCenter.y) ) return true;
      const tBounds = t.bounds;
      return edges.some(e => tBounds.lineSegmentIntersects(e.A, e.B, { inside: true }));
    });
    return tokens;
  }

  /**
   * Filter tiles in the scene by a triangle representing the view from viewingPoint to
   * token (or other two points). Only considers 2d top-down view.
   * @param {PIXI.Polygon} visionPolygon
   * @return {Set<Tile>}
   */
  static filterTilesByVisionPolygon(visionPolygon) {
    let tiles = canvas.tiles.quadtree.getObjects(visionPolygon.getBounds());
    if ( !tiles.size ) return tiles;

    // Filter by the precise triangle shape
    // Also filter by overhead tiles
    const edges = [...visionPolygon.iterateEdges()];
    tiles = tiles.filter(t => {
      // Only overhead tiles count for blocking vision
      if ( !t.document.overhead ) return false;

      // Check remainder against the vision polygon shape
      const tBounds = t.bounds;
      const tCenter = tBounds.center;
      if ( visionPolygon.contains(tCenter.x, tCenter.y) ) return true;
      return edges.some(e => tBounds.lineSegmentIntersects(e.A, e.B, { inside: true }));
    });
    return tiles;
  }

  /**
   * Filter walls in the scene by a triangle representing the view from viewingPoint to some
   * token (or other two points). Only considers 2d top-down view.
   * @param {Point3d} viewingPoint
   * @param {PIXI.Polygon} visionPolygon
   * @param {object} [options]
   * @param {string} [type]     Wall restriction type: sight, light, move, sound
   * @return {Set<Wall>}
   */
  static filterWallsByVisionPolygon(viewingPoint, visionPolygon, { type = "sight" } = {}) {
    let walls = canvas.walls.quadtree.getObjects(visionPolygon.getBounds());
    walls = walls.filter(w => Area3d._testWallInclusion(w, viewingPoint, { type }));

    if ( !walls.size ) return walls;

    // Filter by the precise triangle cone.
    const edges = [...visionPolygon.iterateEdges()];
    walls = walls.filter(w => {
      if ( visionPolygon.contains(w.A.x, w.A.y) || visionPolygon.contains(w.B.x, w.B.y) ) return true;
      return edges.some(e => foundry.utils.lineSegmentIntersects(w.A, w.B, e.A, e.B));
    });
    return walls;
  }

  /**
   * Test whether a wall should be included as potentially blocking from point of view of
   * token.
   * Comparable to ClockwiseSweep.prototype._testWallInclusion but less thorough.
   */
  static _testWallInclusion(wall, viewingPoint, { type = "sight" } = {}) {
    // Ignore walls that are not blocking for the type
    if (!wall.document[type] || wall.isOpen ) return false;

    // Ignore one-directional walls facing away
    const side = wall.orientPoint(viewingPoint);
    return !wall.document.dir || (side !== wall.document.dir);
  }

  // NOTE ----- PRIMARY METHODS ----- //

  /**
   * Calculate the view matrix for the given token and target.
   * Also sets the view matrix for the target, walls, tiles, and other tokens as applicable.
   */
  calculateViewMatrix() {
    this._calculateViewerCameraMatrix();

    // Set the matrix to look at the target from the viewer.
    const { targetPoints, viewerCenter, viewerViewM } = this;
    targetPoints.setViewingPoint(viewerCenter);
    targetPoints.setViewMatrix(viewerViewM);

    // Set the matrix to look at blocking point objects from the viewer.
    const blockingPoints = this.blockingPoints;
    blockingPoints.drawings.forEach(pts => pts.setViewMatrix(viewerViewM));
    blockingPoints.tiles.forEach(pts => pts.setViewMatrix(viewerViewM));
    blockingPoints.tokens.forEach(pts => pts.setViewMatrix(viewerViewM));
    blockingPoints.walls.forEach(pts => pts.setViewMatrix(viewerViewM));
    blockingPoints.terrainWalls.forEach(pts => pts.setViewMatrix(viewerViewM));

    // Set the matrix for drawing other debug objects
    if ( this.debug ) {
      const blockingObjectsPoints = this.blockingObjectsPoints;
      blockingObjectsPoints.drawings.forEach(pts => pts.setViewMatrix(viewerViewM));
      blockingObjectsPoints.tiles.forEach(pts => pts.setViewMatrix(viewerViewM));
      blockingObjectsPoints.tokens.forEach(pts => pts.setViewMatrix(viewerViewM));
      blockingObjectsPoints.walls.forEach(pts => pts.setViewMatrix(viewerViewM));
      blockingObjectsPoints.terrainWalls.forEach(pts => pts.setViewMatrix(viewerViewM));
    }

    this._viewIsSet = true;
  }

  /**
   * Construct 2d perspective projection of each blocking points object.
   * Combine them into a single array of blocking polygons.
   * For each visible side of the target, build the 2d perspective polygon for that side.
   * Take the difference between that side and the blocking polygons to determine the
   * visible portion of that side.
   * @returns {object} { obscuredSides: PIXI.Polygon[], sidePolys: PIXI.Polygon[]}
   *   sidePolys: The sides of the target, in 2d perspective.
   *   obscuredSides: The unobscured portions of the sidePolys
   */
  _obscureSides() {
    if ( !this._viewIsSet ) this.calculateViewMatrix();
    const blockingPoints = this.blockingPoints;

    // Combine terrain walls
    const combinedTerrainWalls = blockingPoints.terrainWalls.length > 1
      ? WallPoints3d.combineTerrainWalls(blockingPoints.terrainWalls, this.viewerCenter, {
        scalingFactor: Area3d.SCALING_FACTOR
      }) : undefined;

    // Combine blocking tiles with drawings as holes
    const tiles = this._combineBlockingTiles();

    // Combine other objects
    const walls = this._combineBlockingWalls();
    const tokens = this._combineBlockingTokens();

    // Combine to a single set of polygon paths
    let blockingPaths = [];
    if ( tiles ) blockingPaths.push(tiles);
    if ( walls ) blockingPaths.push(walls);
    if ( tokens ) blockingPaths.push(tokens);
    if ( combinedTerrainWalls ) blockingPaths.push(combinedTerrainWalls);
    const blockingObject = ClipperPaths.combinePaths(blockingPaths);

    // For each side, union the blocking wall with any shadows and then take diff against the side
    const tTarget = this.targetPoints.perspectiveTransform();
    const sidePolys = tTarget.map(side => new PIXI.Polygon(side));
    const obscuredSides = blockingObject
      ? sidePolys.map(side => blockingObject.diffPolygon(side))
      : sidePolys;

    return { obscuredSides, sidePolys };
  }

  // NOTE ----- GETTER/SETTER HELPER METHODS ----- //

  /**
   * Construct the transformation matrix to rotate the view around the center of the token.
   */
  _calculateViewerCameraMatrix() {
    const cameraPosition = this.viewerCenter;
    const targetPosition = this.targetCenter;
    return Matrix.lookAt(cameraPosition, targetPosition, Area3d._upVector);
  }

  /**
   * Find objects that are within the vision triangle between viewer and target.
   * Sets this._blockingObjects for drawings, tiles, tokens, walls, and terrainWalls.
   * Sets _blockingObjectsAreSet and resets _blockingPointsAreSet and _viewIsSet.
   */
  _findBlockingObjects() {
    const {
      type,
      wallsBlock,
      liveTokensBlock,
      deadTokensBlock,
      tilesBlock } = this.config;

    // Clear any prior objects from the respective sets
    const { terrainWalls, walls } = this._blockingObjects;
    terrainWalls.clear();
    walls.clear();

    const objsFound = Area3d.filterSceneObjectsByVisionPolygon(this.viewerCenter, this.target, {
      type,
      filterWalls: wallsBlock,
      filterTokens: liveTokensBlock || deadTokensBlock,
      filterTiles: tilesBlock,
      debug: this.debug,
      viewer: this.viewer.object });

    this._blockingObjects.drawings = objsFound.drawings;
    this._blockingObjects.tokens = objsFound.tokens;
    this._blockingObjects.tiles = objsFound.tiles;

    // Separate the terrain walls.
    objsFound.walls.forEach(w => {
      const s = w.document[type] === CONST.WALL_SENSE_TYPES.LIMITED ? terrainWalls : walls;
      s.add(w);
    });

    // Add walls for limited angle sight, if necessary.
    const limitedAngleWalls = this._constructLimitedAngleWallPoints3d();
    if ( limitedAngleWalls ) {
      walls.add(limitedAngleWalls[0]);
      walls.add(limitedAngleWalls[1]);
    }

    this._blockingObjectsAreSet = true;
    this._blockingObjectsPointsAreSet = false;
    this._blockingPointsAreSet = false;
    this._viewIsSet = false;
  }

  /**
   * Convert blocking objects into PlanePoints.
   * These will eventually be used by _obscureSides to project 2d perspective objects
   * that may block the target sides.
   */
  _constructBlockingObjectsPoints() {
    const blockingObjs = this.blockingObjects;

    // Clear any prior objects from the respective sets
    const { drawings, terrainWalls, tiles, tokens, walls } = this._blockingObjectsPoints;
    drawings.clear();
    terrainWalls.clear();
    tiles.clear();
    tokens.clear();
    walls.clear();

    // Add Tiles
    blockingObjs.tiles.forEach(t => tiles.add(new TilePoints3d(t)));

    // Add Drawings
    if ( blockingObjs.tiles.size
      && blockingObjs.drawings.size ) blockingObjs.drawings.forEach(d => drawings.add(new DrawingPoints3d(d)));

    // Add Tokens
    const tokenPoints = buildTokenPoints(blockingObjs.tokens, this.config);
    tokenPoints.forEach(pts => tokens.add(pts));

    // Add Walls
    blockingObjs.walls.forEach(w => {
      // Sometimes w can be WallPoints3d. See issue #48.
      if ( w instanceof WallPoints3d ) walls.add(w);
      else walls.add(new WallPoints3d(w))
    });

    // Add Terrain Walls
    blockingObjs.terrainWalls.forEach(w => terrainWalls.add(new WallPoints3d(w)));

    this._blockingObjectsPointsAreSet = true;
    this._blockingPointsAreSet = false;
    this._viewIsSet = false;
  }

  /**
   * Construct the PlanePoints3d array.
   * Split various PlanePoints3d objects as needed for the given perspective.
   */
  _constructBlockingPointsArray() {
    const blockingObjectsPoints = this.blockingObjectsPoints;
    const { drawings, terrainWalls, tiles, tokens, walls } = this._blockingPoints;
    const { visionPolygon, target } = this;
    const edges = [...visionPolygon.iterateEdges()];
    const blockingPoints = this._blockingPoints;
    const viewerLoc = this.viewerCenter;

    if ( this.debug ) Draw.shape(visionPolygon, { fill: Draw.COLORS.lightblue, fillAlpha: 0.2 });

    // Clear the existing arrays.
    tiles.length = 0;
    drawings.length = 0;
    tokens.length = 0;
    walls.length = 0;
    terrainWalls.length = 0;

    // Vertical points
    blockingObjectsPoints.walls.forEach(pts => {
      const res = pts._getVisibleSplits(target, visionPolygon, { edges, viewerLoc });
      if ( res.length ) blockingPoints.walls.push(...res);
    });

    blockingObjectsPoints.terrainWalls.forEach(pts => {
      const res = pts._getVisibleSplits(target, visionPolygon, { edges, viewerLoc });
      if ( res.length ) blockingPoints.terrainWalls.push(...res);
    });

    // Horizontal points
    blockingObjectsPoints.tiles.forEach(pts => {
      const res = pts._getVisibleSplits(target, visionPolygon, { edges, viewerLoc });
      if ( res.length ) blockingPoints.tiles.push(...res);
    });

    blockingObjectsPoints.drawings.forEach(pts => {
      const res = pts._getVisibleSplits(target, visionPolygon, { edges, viewerLoc });
      if ( res.length ) blockingPoints.drawings.push(...res);
    });

    // Tokens have both horizontal and vertical.
    blockingObjectsPoints.tokens.forEach(token => {
      const topBottom = token._viewableTopBottom(viewerLoc);
      if ( topBottom ) {
        const res = topBottom._getVisibleSplits(target, visionPolygon, { edges, viewerLoc });
        if ( res.length ) blockingPoints.tokens.push(...res);
      }

      const sides = token._viewableSides(viewerLoc);
      sides.forEach(pts => {
        const res = pts._getVisibleSplits(target, visionPolygon, { edges, viewerLoc });
        if ( res.length ) blockingPoints.tokens.push(...res);
      });
    });

    this._blockingPointsAreSet = true;
    this._viewIsSet = false;
  }

  // NOTE ----- OTHER HELPER METHODS ----- //

  /**
   * Combine provided walls using Clipper.
   * @returns {ClipperPaths|undefined}
   */
  _combineBlockingWalls() {
    let walls = this.blockingPoints.walls;
    if ( !walls.length ) return undefined;

    const transformed = walls.map(w => new PIXI.Polygon(w.perspectiveTransform()));
    const paths = ClipperPaths.fromPolygons(transformed, { scalingFactor: Area3d.SCALING_FACTOR });
    const combined = paths.combine();
    combined.clean();
    return combined;
  }

  /**
   * Combine all the blocking tokens using Clipper
   * @returns {ClipperPaths|undefined}
   */
  _combineBlockingTokens() {
    const tokens = this.blockingPoints.tokens;
    if ( !tokens.length ) return undefined;

    const transformed = tokens.map(t => new PIXI.Polygon(t.perspectiveTransform()));
    const paths = ClipperPaths.fromPolygons(transformed, { scalingFactor: Area3d.SCALING_FACTOR });
    const combined = paths.combine();
    combined.clean();
    return combined;
  }

  /**
   * Combine all the blocking tiles using Clipper.
   * If drawings with holes exist, construct relevant tiles with holes accordingly.
   * @returns {ClipperPaths|undefined}
   */
  _combineBlockingTiles() {
    const blockingPoints = this.blockingPoints;

    if ( !blockingPoints.tiles.length ) return undefined;

    if ( !blockingPoints.drawings.length ) {
      let tiles = blockingPoints.tiles.map(w => new PIXI.Polygon(w.perspectiveTransform()));
      tiles = ClipperPaths.fromPolygons(tiles, {scalingFactor: Area3d.SCALING_FACTOR});
      tiles.combine().clean();
      return tiles;
    }

    // Check if any drawings might create a hole in one or more tiles
    const tilesUnholed = [];
    const tilesHoled = [];
    for ( const tile of blockingPoints.tiles ) {
      const drawingHoles = [];
      const tileE = tile.object.document.elevation;
      const tilePoly = new PIXI.Polygon(tile.perspectiveTransform());

      for ( const drawing of blockingPoints.drawings ) {
        const minE = drawing.object.document.getFlag("levels", "rangeTop");
        const maxE = drawing.object.document.getFlag("levels", "rangeBottom");
        if ( minE == null && maxE == null ) continue; // Intended to test null, undefined
        else if ( minE == null && tileE !== maxE ) continue;
        else if ( maxE == null && tileE !== minE ) continue;
        else if ( !tileE.between(minE, maxE) ) continue;

        // We know the tile is within the drawing elevation range.
        drawing.elevation = tileE; // Temporarily change the drawing elevation to match tile.
        drawingHoles.push(new PIXI.Polygon(drawing.perspectiveTransform()));
      }

      if ( drawingHoles.length ) {
        // Construct a hole at the tile's elevation from the drawing taking the difference.
        const drawingHolesPaths = ClipperPaths.fromPolygons(drawingHoles, {scalingFactor: Area3d.SCALING_FACTOR});
        const tileHoled = drawingHolesPaths.diffPolygon(tilePoly);
        tilesHoled.push(tileHoled);
      } else tilesUnholed.push(tilePoly);
    }

    if ( tilesUnholed.length ) {
      const unHoledPaths = ClipperPaths.fromPolygons(tilesUnholed, {scalingFactor: Area3d.SCALING_FACTOR});
      unHoledPaths.combine().clean();
      tilesHoled.push(unHoledPaths);
    }

    // Combine all the tiles, holed and unholed
    const tiles = ClipperPaths.combinePaths(tilesHoled);
    tiles.combine().clean();
    return tiles;
  }

  /**
   * Test if any part of the target is within the limited angle vision of the token.
   * @returns {boolean}
   */
  _targetWithinLimitedAngleVision() {
    const angle = this.viewer.data.angle;
    if ( angle === 360 ) return true;

    // Does the target intersect the two rays from viewer center?
    // Does the target fall between the two rays?
    const { x, y, rotation } = this.viewer.data;

    // The angle of the left (counter-clockwise) edge of the emitted cone in radians.
    // See LimitedAnglePolygon
    const aMin = Math.normalizeRadians(Math.toRadians(rotation + 90 - (angle / 2)));

    // The angle of the right (clockwise) edge of the emitted cone in radians.
    const aMax = aMin + Math.toRadians(angle);

    const constrainedTokenBorder = ConstrainedTokenBorder.get(this.target).constrainedBorder();

    // For each edge:
    // If it intersects a ray, target is within.
    // If an endpoint is within the limited angle, target is within
    const rMin = Ray.fromAngle(x, y, aMin, canvas.dimensions.maxR);
    const rMax = Ray.fromAngle(x, y, aMax, canvas.dimensions.maxR);

    // Probably worth checking the target center first
    const center = this.target.center;
    if ( LimitedAnglePolygon.pointBetweenRays(center, rMin, rMax, angle) ) return true;
    if ( LimitedAnglePolygon.pointBetweenRays(center, rMin, rMax, angle) ) return true;

    // TODO: Would it be more performant to assign an angle to each target point?
    // Or maybe just check orientation of ray to each point?
    const edges = constrainedTokenBorder.toPolygon().iterateEdges();
    for ( const edge of edges ) {
      if ( foundry.utils.lineSegmentIntersects(rMin.A, rMin.B, edge.A, edge.B) ) return true;
      if ( foundry.utils.lineSegmentIntersects(rMax.A, rMax.B, edge.A, edge.B) ) return true;
      if ( LimitedAnglePolygon.pointBetweenRays(edge.A, rMin, rMax, angle) ) return true;
      if ( LimitedAnglePolygon.pointBetweenRays(edge.B, rMin, rMax, angle) ) return true;
    }

    return false;
  }

  /**
   * Test whether a wall should be included as potentially blocking from point of view of
   * token.
   * Comparable to ClockwiseSweep.prototype._testWallInclusion
   */
  _testWallInclusion(wall, bounds) {
    // First test for inclusion in our overall bounding box
    if ( !bounds.lineSegmentIntersects(wall.A, wall.B, { inside: true }) ) return false;

    // Ignore walls that do not block sight
    if ( !wall.document.sight || wall.isOpen ) return false;

    // Ignore walls that are in line with the viewer and target
    if ( !foundry.utils.orient2dFast(this.viewerCenter, wall.A, wall.B)
      && !foundry.utils.orient2dFast(this.targetCenter, wall.A, wall.B) ) return false;

    // Ignore one-directional walls facing away from the origin
    const side = wall.orientPoint(this.viewerCenter);
    return !wall.document.dir || (side !== wall.document.dir);
  }

  /**
   * Construct walls based on limited angle rays
   * Start 1 pixel behind the origin
   * @returns {null|WallPoints3d[2]}
   */
  _constructLimitedAngleWallPoints3d() {
    const angle = this.viewer.data.angle;
    if ( angle === 360 ) return null;

    const { x, y, rotation } = this.viewer.data;
    const aMin = Math.normalizeRadians(Math.toRadians(rotation + 90 - (angle / 2)));
    const aMax = aMin + Math.toRadians(angle);

    // 0 faces south; 270 faces east
    const aMed = (aMax + aMin) * 0.5;
    const rMed = Ray.fromAngle(x, y, aMed, -1);
    const rMin = Ray.fromAngle(rMed.B.x, rMed.B.y, aMin, canvas.dimensions.maxR);
    const rMax = Ray.fromAngle(rMed.B.x, rMed.B.y, aMax, canvas.dimensions.maxR);

    // Use the ray as the wall
    rMin.topZ = canvas.dimensions.maxR;
    rMin.bottomZ = -canvas.dimensions.maxR;
    rMax.topZ = canvas.dimensions.maxR;
    rMax.bottomZ = -canvas.dimensions.maxR;
    return [new WallPoints3d(rMin), new WallPoints3d(rMax)];
  }

  /**
   * For debugging.
   * Draw the line of sight from token to target.
   */
  _drawLineOfSight() {
    Draw.segment({A: this.viewerCenter, B: this.targetCenter});
  }
}
